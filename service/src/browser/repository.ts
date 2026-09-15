import { ulid } from "ulid";
import type { Pool } from "pg";
import { pool } from "../db/client.js";
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
type Session = {
  id: string;
  generation: string;
  boot_id: string;
  state: string;
  desired_state: string;
  control_state: string;
  private_content: boolean;
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

  async prepare(
    context: BrowserAgentContext,
    bootId: string,
    command: Record<string, unknown>,
  ): Promise<BrowserCommand> {
    const identity = context.invocation;
    if (!identity || !context.callId)
      throw new BrowserError("browser_invocation_required");
    const client = await this.database.connect();
    try {
      await client.query("begin");
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
      const expires = Math.min(
        Date.now() + 30_000,
        new Date(authority.rows[0].lease_expires_at).getTime(),
      );
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
      let session = (
        await client.query<Session>(
          `select * from browser_session where thread_id=$1
        and created_by_user_id=$2 and bud_id=$3 and closed_at is null for update`,
          [context.threadId, context.ownerUserId, context.budId],
        )
      ).rows[0];
      // Check before boot reconciliation too: open/close must not bypass a
      // private pause by replacing or destroying the user's browser identity.
      if (session && (session.control_state !== "agent" || session.private_content))
        throw new BrowserError("browser_private_or_paused");
      if (session && session.boot_id !== bootId) {
        await client.query(
          "update browser_session set state='interrupted',desired_state='closed',closed_at=now(),updated_at=now() where id=$1",
          [session.id],
        );
        session = undefined!;
        if (command.action !== "open") {
          await client.query("commit");
          throw new BrowserError("browser_interrupted_reopen_required");
        }
      }
      if (!session) {
        if (command.action !== "open")
          throw new BrowserError("browser_not_open");
        session = (
          await client.query<Session>(
            `insert into browser_session
          (id,thread_id,bud_id,created_by_user_id,tenant_id,generation,boot_id)
          values($1,$2,$3,$4,$5,$6,$7) returning *`,
            [
              `browser_${ulid()}`,
              context.threadId,
              context.budId,
              context.ownerUserId,
              authority.rows[0].tenant_id,
              ulid(),
              bootId,
            ],
          )
        ).rows[0];
      }
      if (session.pending_until && session.pending_until.getTime() > Date.now())
        throw new BrowserError("browser_busy");
      if (session.desired_state === "closed" && command.action !== "close")
        throw new BrowserError("browser_close_pending");
      const changed =
        session.invocation_id !== identity.id ||
        session.invocation_fence !== identity.fence;
      const updated = (
        await client.query<Session>(
          `update browser_session set sequence=sequence+1,
        control_epoch=control_epoch+$2,invocation_id=$3,invocation_fence=$4,pending_until=$5,
        desired_state=case when $6 then 'closed' else desired_state end,updated_at=now() where id=$1 returning *`,
          [
            session.id,
            changed ? 1 : 0,
            identity.id,
            identity.fence,
            new Date(expires),
            command.action === "close",
          ],
        )
      ).rows[0];
      await client.query("commit");
      return {
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
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async complete(
    request: BrowserCommand,
    result: BrowserBackendResult,
  ): Promise<void> {
    const closed =
      request.command.action === "close" &&
      (result.ok ||
        ["browser_closed", "browser_interrupted"].includes(result.error ?? ""));
    await this.database.query(
      `update browser_session set state=$4,pending_until=null,
      closed_at=case when $5 then now() else closed_at end,updated_at=now()
      where id=$1 and generation=$2 and sequence=$3 and created_by_user_id=$6`,
      [
        request.session_id,
        request.generation,
        request.sequence,
        closed ? "closed" : result.ok ? "ready" : "interrupted",
        closed,
        request.owner_user_id,
      ],
    );
  }

  /** A takeover may commit after dispatch but before the daemon receives its fence. */
  async evidenceAllowed(request: BrowserCommand): Promise<boolean> {
    const result = await this.database.query(
      `select s.id from browser_session s
      join thread t on t.thread_id=s.thread_id join bud b on b.bud_id=s.bud_id
      where s.id=$1 and s.generation=$2 and s.control_epoch=$3
        and s.created_by_user_id=$4 and t.created_by_user_id=$4 and b.created_by_user_id=$4
        and t.deleted_at is null and s.control_state='agent'`,
      [
        request.session_id,
        request.generation,
        request.control_epoch,
        request.owner_user_id,
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
      and desired_state='closed' and (pending_until is null or pending_until<now()) order by updated_at limit 32`)
    ).rows;
  }

  async prepareCleanup(
    session: Session,
    bootId: string,
  ): Promise<BrowserCommand | null> {
    if (session.boot_id !== bootId) {
      await this.database.query(
        `update browser_session set state='closed',closed_at=now(),updated_at=now()
        where id=$1 and generation=$2 and desired_state='closed'`,
        [session.id, session.generation],
      );
      return null;
    }
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
