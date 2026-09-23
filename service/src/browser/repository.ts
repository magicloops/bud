import { resolveBrowserColor } from "./color.js";
import { BrowserResourceRepository, type BrowserResource } from "./resource-repository.js";
import { settledWorkDurationSql } from "../agent/invocation-timing.js";
import { ulid } from "ulid";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { pool } from "../db/client.js";
import { BrowserToolWait } from "../agent/browser-tool-executor.js";
import type {
  BrowserAgentContext,
  BrowserBackendResult,
} from "../agent/browser-tool-executor.js";
import type { BrowserCommand } from "./transport.js";

export class BrowserError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
/** Internal receipt return, never permission to redispatch the saved request. */
export class BrowserReplay extends Error {
  constructor(readonly request: BrowserCommand, readonly result: BrowserBackendResult) {
    super("browser_cell_receipt");
  }
}
type Session = {
  id: string;
  browser_id: string;
  generation: string;
  boot_id: string;
  state: string;
  desired_state: string;
  control_epoch: number;
  sequence: number;
  invocation_id: string | null;
  invocation_fence: number | null;
  pending_until: Date | null;
  thread_id: string;
  bud_id: string;
  created_by_user_id: string;
};

export class BrowserRepository {
  constructor(private readonly database: Pool = pool) {}

  async modelForCapture(context: BrowserAgentContext): Promise<string | null> {
    const result = await this.database.query(`select model from agent_invocation
      where id=$1 and thread_id=$2 and created_by_user_id=$3 and fence=$4 and status='running'`,
      [context.invocation?.id, context.threadId, context.ownerUserId, context.invocation?.fence]);
    return result.rows[0]?.model ?? null;
  }

  async prepare(
    context: BrowserAgentContext,
    bootId: string,
    command: Record<string, unknown>,
    ensureOnly: boolean | "receipt_only" = false,
  ): Promise<BrowserCommand> {
    const identity = context.invocation;
    if (!identity || !context.callId)
      throw new BrowserError("browser_invocation_required");
    await new BrowserResourceRepository(this.database).ensure(context.ownerUserId, context.budId);
    const client = await this.database.connect();
    let open = false;
    try {
      await client.query("begin");
      open = true;
      await client.query("select bud_id from bud where bud_id=$1 and created_by_user_id=$2 for update", [context.budId, context.ownerUserId]);
      let resource = (await client.query<BrowserResource>(`select r.* from browser_resource r join bud b on b.bud_id=r.bud_id
        where r.bud_id=$1 and r.created_by_user_id=$2 and b.created_by_user_id=$2 and r.retired_at is null for update of r`,
        [context.budId, context.ownerUserId])).rows[0];
      if (!resource) throw new BrowserError("browser_not_found");
      if (resource.desired_state === "stopped" && command.action === "open") {
        resource = (await client.query<BrowserResource>(`update browser_resource set desired_state='open',
          control_state=case when private_content then 'paused' else 'agent' end,
          control_epoch=control_epoch+1,revision=revision+1,updated_at=now() where id=$1 returning *`, [resource.id])).rows[0];
      }
      if (resource.desired_state !== "open") throw new BrowserError("browser_stopped");
      // Admission locks the thread before the invocation. Follow that order;
      // this dispatch validates the existing lease and never acquires one.
      await client.query(
        `select thread_id from thread where thread_id=$1
        and bud_id=$2 and created_by_user_id=$3 and deleted_at is null for update`,
        [context.threadId, context.budId, context.ownerUserId],
      );
      const authority = await client.query(
        `select i.lease_expires_at, t.tenant_id from agent_invocation i
        join thread t on t.thread_id=i.thread_id join bud b on b.bud_id=t.bud_id
        where i.id=$1 and i.fence=$2 and i.worker_id=$3 and i.turn_id=$4
        and i.status='running' and i.lease_expires_at>clock_timestamp() and i.cancel_requested_at is null
        and i.created_by_user_id=$5 and t.created_by_user_id=$5 and b.created_by_user_id=$5
        and t.thread_id=$6 and b.bud_id=$7 and t.deleted_at is null for update of i`,
        [
          identity.id,
          identity.fence,
          identity.workerId,
          context.turnId,
          context.ownerUserId,
          context.threadId,
          context.budId,
        ],
      );
      if (!authority.rows[0]) throw new BrowserError("browser_authority_lost");
      if (command.action === "exec") {
        if (typeof command.code !== "string" || !command.code.length ||
            Buffer.byteLength(command.code) > 64 * 1024 || Object.keys(command).length !== 2)
          throw new BrowserError("browser_invalid_arguments");
        const action = (await client.query(`select status,evidence from agent_invocation_action
          where invocation_id=$1 and call_id=$2 and fence=$3 and created_by_user_id=$4
            and kind='browser_exec' for update`,
          [identity.id, context.callId, identity.fence, context.ownerUserId])).rows[0];
        if (!action) throw new BrowserError("browser_invocation_required");
        const receipt = action.evidence?.browser_cell;
        if (receipt) {
          if (receipt.code_hash !== createHash("sha256").update(command.code).digest("hex"))
            throw new BrowserError("browser_cell_conflict");
          throw new BrowserReplay(receipt.request, receipt.result ?? {
            ok: false, outcome: "unknown", error: "browser_outcome_unknown",
            data: { execution_state: "unknown" },
          });
        }
        if (action.status !== "intent" || action.evidence?.browser_dispatched)
          throw new BrowserError("browser_call_already_dispatched");
      }
      // Receipt lookup needs no daemon connection and must never allocate or
      // consume a new dispatch when the carrier is offline.
      if (ensureOnly === "receipt_only") throw new BrowserError("browser_unavailable");
      const expires = Math.min(
        Date.now() + 30_000,
        new Date(authority.rows[0].lease_expires_at).getTime(),
      );
      let session = (
        await client.query<Session>(
          `select * from browser_session where thread_id=$1
        and created_by_user_id=$2 and bud_id=$3 and closed_at is null for update`,
          [context.threadId, context.ownerUserId, context.budId],
        )
      ).rows[0];
      // Workspace identity survives restart. Only a retired resource invalidates it.
      if (session && session.browser_id !== resource.id) {
        await client.query(
          "update browser_session set state='interrupted',desired_state='closed',closed_at=now(),updated_at=now() where id=$1",
          [session.id],
        );
        session = undefined!;
        if (!["open", "exec"].includes(String(command.action))) {
          // Persist the closed workspace; nothing is dispatched for this call.
          await client.query("commit");
          open = false;
          throw new BrowserError("browser_interrupted_reopen_required");
        }
      }
      if (!session) {
        if (!["open", "exec"].includes(String(command.action)))
          throw new BrowserError("browser_not_open");
        session = (
          await client.query<Session>(
            `insert into browser_session
          (id,thread_id,bud_id,created_by_user_id,tenant_id,generation,boot_id,browser_id)
          values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
            [
              `browser_${ulid()}`,
              context.threadId,
              context.budId,
              context.ownerUserId,
              authority.rows[0].tenant_id,
              ulid(),
              bootId,
              resource.id,
            ],
          )
        ).rows[0];
      }
      if (ensureOnly) {
        // Validate the same lease and undispatched intent before recovery I/O.
        // Recovery does not consume the action; normal admission rechecks both.
        const intent = await client.query(`select id from agent_invocation_action
          where invocation_id=$1 and call_id=$2 and fence=$3 and created_by_user_id=$4
          and status='intent' and not coalesce((evidence->>'browser_dispatched')::boolean,false)`,
          [identity.id,context.callId,identity.fence,context.ownerUserId]);
        if (!intent.rowCount) throw new BrowserError("browser_call_already_dispatched");
        if (session.desired_state !== "open") throw new BrowserError("browser_close_pending");
        await client.query("commit");
        open = false;
        return {browser_id:resource.id,browser_epoch:resource.control_epoch,
          private_content:resource.private_content,browser_paused:resource.control_state !== "agent",
          request_id:ulid(),session_id:session.id,generation:session.generation,
          thread_id:context.threadId,owner_user_id:context.ownerUserId,
          control_epoch:Math.max(1,session.control_epoch),sequence:Math.max(1,session.sequence),
          invocation_id:identity.id,invocation_fence:identity.fence,expires_at_ms:expires,command};
      }
      // The existing action intent is the durable no-replay receipt. Retrying
      // after a process failure cannot mint a second dispatch for this call.
      const receipt = await client.query(
        `update agent_invocation_action set evidence=jsonb_build_object('browser_dispatched',true)
        where invocation_id=$1 and call_id=$2 and fence=$3 and created_by_user_id=$4
        and status='intent' and not coalesce((evidence->>'browser_dispatched')::boolean,false) returning id`,
        [identity.id, context.callId, identity.fence, context.ownerUserId],
      );
      if (!receipt.rowCount)
        throw new BrowserError("browser_call_already_dispatched");
      if (resource.control_state !== "agent" || resource.private_content) {
        if (!context.waitClientId || session.desired_state !== "open")
          throw new BrowserError("browser_private_or_paused");
        const handoffId = ulid();
        await client.query(`insert into browser_handoff
          (id,session_id,thread_id,bud_id,created_by_user_id,tenant_id,invocation_id,call_id,client_id,reason,kind)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,'Return browser control so Bud can continue.','return_control')`,
          [handoffId,session.id,context.threadId,context.budId,context.ownerUserId,
            authority.rows[0].tenant_id,identity.id,context.callId,context.waitClientId]);
        // Overwrite the tentative receipt: no command left this transaction.
        await client.query(`update agent_invocation_action set status='waiting_for_user',fence=fence+1,
          evidence=jsonb_build_object('browser_handoff_id',$3::text,'browser_dispatched',false)
          where invocation_id=$1 and call_id=$2`, [identity.id,context.callId,handoffId]);
        await client.query(`update agent_invocation set work_duration_ms=${settledWorkDurationSql},work_started_at=null,status='waiting_for_user',reserves_thread=false,
          worker_id=null,lease_expires_at=null,fence=fence+1,updated_at=clock_timestamp() where id=$1`,[identity.id]);
        await client.query("commit");
        open = false;
        throw new BrowserToolWait({ handoff_id:handoffId,viewer_path:`/browser/${session.id}`,wait_kind:"return_control",invocation_id:identity.id,session_id:session.id });
      }
      const restarted = session.boot_id !== bootId;
      if (restarted && !["open", "exec", "close"].includes(String(command.action)))
        throw new BrowserError("browser_recovery_required");
      if (!restarted && session.pending_until && session.pending_until.getTime() > Date.now())
        throw new BrowserError("browser_busy");
      if (session.desired_state === "closed" && command.action !== "close")
        throw new BrowserError("browser_close_pending");
      const changed =
        restarted || command.action === "open" || session.invocation_id !== identity.id ||
        session.invocation_fence !== identity.fence;
      const updated = (
        await client.query<Session>(
          `update browser_session set sequence=sequence+1,
        control_epoch=control_epoch+$2,invocation_id=$3,invocation_fence=$4,pending_until=$5,
        desired_state=case when $6 then 'closed' else desired_state end,
        generation=case when boot_id<>$7 then $8 else generation end,boot_id=$7,
        updated_at=now() where id=$1 returning *`,
          [
            session.id,
            changed ? 1 : 0,
            identity.id,
            identity.fence,
            new Date(expires),
            command.action === "close",
            bootId,
            ulid(),
          ],
        )
      ).rows[0];
      const browserColor = ["open", "exec"].includes(String(command.action))
        ? await resolveBrowserColor(client, context.ownerUserId, context.budId) : undefined;
      const request: BrowserCommand = {
        ...(browserColor ? { browser_color: browserColor } : {}),
        browser_id: resource.id,
        browser_epoch: resource.control_epoch,
        private_content: resource.private_content,
        browser_paused: resource.control_state !== "agent",
        request_id: ulid(),
        session_id: updated.id,
        generation: updated.generation,
        thread_id: context.threadId,
        owner_user_id: context.ownerUserId,
        control_epoch: updated.control_epoch,
        sequence: updated.sequence,
        invocation_id: identity.id,
        invocation_fence: identity.fence,
        expires_at_ms: expires,
        command,
      };
      if (command.action === "exec") {
        // Commit identity with intent, before any send. Keep generated code out
        // of the receipt; the hash detects accidental reuse with different code.
        const receipt = { code_hash: createHash("sha256").update(command.code as string).digest("hex"),
          request: { ...request, command: { action: "exec" } } };
        await client.query(`update agent_invocation_action set evidence=evidence || jsonb_build_object('browser_cell',$3::jsonb)
          where invocation_id=$1 and call_id=$2`, [identity.id, context.callId, JSON.stringify(receipt)]);
      }
      await client.query("commit");
      open = false;
      return request;
    } catch (error) {
      if (open) await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async complete(
    request: BrowserCommand,
    result: BrowserBackendResult,
  ): Promise<void> {
    if (request.command.action === "exec") {
      // The first bounded, correlated outcome is immutable. Record even after
      // takeover/cancellation has fenced delivery. Losing this write leaves the
      // dispatch intent ambiguous, never executable again.
      const recorded = await this.database.query(`update agent_invocation_action
        set evidence=jsonb_set(evidence,'{browser_cell,result}',$5::jsonb)
        where invocation_id=$1 and evidence->'browser_cell'->'request'->>'invocation_fence'=$2::text and created_by_user_id=$3
          and evidence->'browser_cell'->'request'->>'request_id'=$4
          and not (evidence->'browser_cell' ? 'result')`,
        [request.invocation_id,request.invocation_fence,request.owner_user_id,request.request_id,JSON.stringify(result)]);
      if (!recorded.rowCount) return; // A duplicate completion cannot change health either.
    }
    const closed =
      request.command.action === "close" &&
      (result.ok ||
        ["browser_closed", "browser_interrupted"].includes(result.error ?? ""));
    const recoverable = result.outcome === "rejected" && [
      "browser_locator_ambiguous", "browser_locator_not_found", "browser_click_blocked", "browser_stale_reference",
      "browser_observation_limit", "browser_target_not_found", "browser_document_changed",
      "browser_invalid_arguments", "browser_busy",
    ].includes(result.error ?? "");
    // An admitted page action can time out while Chrome and passive media remain
    // healthy. Its unknown outcome is not runtime-loss evidence. Preserve prior
    // health (including interruption); the receipt still forbids action replay.
    const uncertainPage = !result.ok && result.outcome === "unknown" &&
      result.error === "browser_outcome_unknown" &&
      ["inspect", "navigate", "click", "insert_text"].includes(String(request.command.action));
    // Cells can be entirely local. Neither success nor a worker/transport error
    // establishes Chrome health; preserve it and let browser recovery own it.
    await this.database.query(
      `update browser_session set state=coalesce($4,state),pending_until=null,
      closed_at=case when $5 then now() else closed_at end,updated_at=now()
      where id=$1 and generation=$2 and sequence=$3 and created_by_user_id=$6`,
      [
        request.session_id,
        request.generation,
        request.sequence,
        closed ? "closed" : request.command.action === "exec" || uncertainPage ? null : result.ok || recoverable ? "ready" : "interrupted",
        closed,
        request.owner_user_id,
      ],
    );
  }

  /** A takeover may commit after dispatch but before the daemon receives its fence. */
  async evidenceAllowed(request: BrowserCommand): Promise<boolean> {
    const result = await this.database.query(
      `select s.id from browser_session s join browser_resource r on r.id=s.browser_id
      join thread t on t.thread_id=s.thread_id join bud b on b.bud_id=s.bud_id
      join agent_invocation i on i.id=$5 and i.thread_id=t.thread_id
      where s.id=$1 and s.generation=$2 and s.control_epoch=$3
        and s.created_by_user_id=$4 and t.created_by_user_id=$4 and b.created_by_user_id=$4
        and t.deleted_at is null and r.control_state='agent' and not r.private_content
        and r.id=$7 and r.control_epoch=$8 and r.retired_at is null and r.desired_state='open'
        and s.closed_at is null and i.fence=$6 and i.status='running'
        and i.lease_expires_at>clock_timestamp() and i.cancel_requested_at is null`,
      [
        request.session_id,
        request.generation,
        request.control_epoch,
        request.owner_user_id,
        request.invocation_id,
        request.invocation_fence,
        request.browser_id,
        request.browser_epoch,
      ],
    );
    return Boolean(result.rowCount);
  }

  /** Internal lifecycle reconciliation, never exposed as a global viewer read. */
  async cleanupCandidates(): Promise<Session[]> {
    await this.database
      .query(`update browser_session s set desired_state='closed',updated_at=now()
      from thread t,bud b where s.thread_id=t.thread_id and s.bud_id=b.bud_id and s.closed_at is null
      and (t.deleted_at is not null or t.created_by_user_id is distinct from s.created_by_user_id
        or b.created_by_user_id is distinct from s.created_by_user_id)`);
    return (
      await this.database
        .query<Session>(`select * from browser_session where closed_at is null
      and (desired_state='closed' or exists (select 1 from browser_handoff h where h.session_id=browser_session.id and h.status='pending'))
      and (pending_until is null or pending_until<now()) order by updated_at limit 32`)
    ).rows;
  }

  async prepareCleanup(
    session: Session,
    _bootId: string,
  ): Promise<BrowserCommand | null> {
    const resource = await new BrowserResourceRepository(this.database).get(session.created_by_user_id, session.bud_id);
    if (!resource || session.browser_id !== resource.id) {
      await this.database.query(
        `update browser_session set state='closed',closed_at=now(),updated_at=now()
        where id=$1 and generation=$2 and closed_at is null`,
        [session.id, session.generation],
      );
      return null;
    }
    if (session.desired_state !== "closed") return null;
    const expires = Date.now() + 30_000;
    const claimed = (
      await this.database.query<Session>(
        `update browser_session set sequence=sequence+1,
      control_epoch=control_epoch+1,pending_until=$3,updated_at=now() where id=$1 and generation=$2
      and closed_at is null and desired_state='closed' and (pending_until is null or pending_until<now()) returning *`,
        [session.id, session.generation, new Date(expires)],
      )
    ).rows[0];
    if (!claimed) return null;
    return {
      browser_id: resource.id,
      browser_epoch: resource.control_epoch,
      private_content: resource.private_content,
      browser_paused: resource.control_state !== "agent",
      request_id: ulid(),
      session_id: claimed.id,
      generation: claimed.generation,
      thread_id: claimed.thread_id,
      owner_user_id: claimed.created_by_user_id,
      control_epoch: claimed.control_epoch,
      sequence: claimed.sequence,
      invocation_id: `cleanup_${claimed.id}`,
      invocation_fence: 1,
      expires_at_ms: expires,
      command: { action: "close" },
    };
  }
}
