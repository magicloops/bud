import { resolveBrowserColor } from "./color.js";
import { BrowserResourceRepository, type BrowserResource } from "./resource-repository.js";
import { ulid } from "ulid";
import type { Pool } from "pg";
import { pool } from "../db/client.js";
import { BrowserError } from "./repository.js";
import type { BrowserCommand } from "./transport.js";
import type { BrowserHandoffContext } from "../agent/browser-tool-executor.js";

export type BrowserSession = {
  id: string;
  thread_id: string;
  bud_id: string;
  created_by_user_id: string;
  tenant_id: string | null;
  browser_id: string;
  browser_epoch: number;
  control_session_id: string | null;
  generation: string;
  boot_id: string;
  state: string;
  desired_state: string;
  control_state: string;
  control_epoch: number;
  sequence: number;
  revision: number;
  control_request_id: string | null;
  private_content: boolean;
  override_id: string | null;
  override_viewer_id: string | null;
  override_carrier_id: string | null;
  override_expires_at: Date | null;
  ended_override_id: string | null;
  override_end_reason: string | null;
};
const owned = `select s.*,r.control_state,r.private_content,r.revision,r.control_request_id,
  r.override_id,r.override_viewer_id,r.override_carrier_id,r.override_expires_at,r.ended_override_id,r.override_end_reason,
  r.control_epoch as browser_epoch,r.control_session_id from browser_session s
  join browser_resource r on r.id=s.browser_id and r.retired_at is null and r.desired_state='open'
  join thread t on t.thread_id=s.thread_id
  join bud b on b.bud_id=s.bud_id where s.created_by_user_id=$1 and t.created_by_user_id=$1
  and b.created_by_user_id=$1 and t.bud_id=s.bud_id and t.deleted_at is null and s.closed_at is null`;

/** Viewer inventory is always SQL-scoped; transitions use short row locks, not network transactions. */
export class BrowserControlRepository {
  constructor(private readonly database: Pool = pool) {}

  /** Install the exact override after the acknowledged acquisition fence. */
  async grantOverride(owner: string, id: string, revision: number, override: string, viewer: string, carrier: string, expires: number) {
    const initial = await this.get(owner, id);
    return new BrowserResourceRepository(this.database).withLocked(owner, initial.bud_id, async (client, resource) => {
      if (resource.revision !== revision || resource.control_session_id !== id || resource.control_state !== "human_private")
        throw new BrowserError("browser_revision_conflict");
      if (expires <= Date.now()) throw new BrowserError("browser_control_expired");
      await client.query(`update browser_resource set override_id=$2,override_viewer_id=$3,
        override_carrier_id=$4,override_expires_at=$5,ended_override_id=null,override_end_reason=null
        where id=$1`, [resource.id,override,viewer,carrier,new Date(expires)]);
      // A help prompt becomes associated only when the user actually takes over.
      await client.query(`update browser_handoff set override_id=$3 where session_id=$1
        and created_by_user_id=$2 and status='pending' and kind='agent' and override_id is null`, [id,owner,override]);
    });
  }

  async renewOverride(owner: string, id: string, override: string, viewer: string, carrier: string, expires: number) {
    await this.get(owner,id);
    const result = await this.database.query(`update browser_resource r set override_expires_at=greatest(override_expires_at,$6)
      from browser_session s,bud b where s.id=$1 and s.browser_id=r.id and b.bud_id=r.bud_id
      and s.created_by_user_id=$2 and r.created_by_user_id=$2 and b.created_by_user_id=$2
      and r.control_session_id=s.id and r.override_id=$3 and r.override_viewer_id=$4
      and r.override_carrier_id=$5 and r.override_expires_at>now() and $6>now() and $6<=now()+interval '6 seconds'
      and r.retired_at is null and r.desired_state='open' and s.closed_at is null
      returning r.id`, [id,owner,override,viewer,carrier,new Date(expires)]);
    if (!result.rowCount) throw new BrowserError("browser_control_expired");
  }

  /** Retire first, before waiting for page work. A late end cannot clear a new override. */
  async endOverride(owner: string, id: string, override: string, reason: string, candidate?: BrowserSession) {
    const initial = candidate ?? await this.get(owner,id);
    return new BrowserResourceRepository(this.database).withLocked(owner,initial.bud_id,async (client,resource) => {
      const result = await client.query(`update browser_resource set ended_override_id=override_id,
        override_id=null,override_viewer_id=null,override_carrier_id=null,override_expires_at=null,
        override_end_reason=$3,revision=revision+1,updated_at=now() where id=$1 and override_id=$2 returning id`,
        [resource.id,override,reason]);
      return Boolean(result.rowCount);
    });
  }

  /** Internal recovery scan, never a browser-facing inventory. */
  async reconciliationCandidates() {
    return (await this.database.query<BrowserSession>(`select s.*,r.control_state,r.private_content,
      r.control_epoch as browser_epoch,r.revision,r.control_session_id,r.control_request_id,
      r.override_id,r.override_viewer_id,r.override_carrier_id,r.override_expires_at,r.ended_override_id,r.override_end_reason
      from browser_resource r join lateral (select candidate.* from browser_session candidate
        where candidate.browser_id=r.id and candidate.created_by_user_id=r.created_by_user_id
        order by (candidate.id=r.control_session_id) desc nulls last,candidate.created_at desc limit 1) s on true
      join bud b on b.bud_id=r.bud_id and b.created_by_user_id=r.created_by_user_id
      join thread t on t.thread_id=s.thread_id and t.created_by_user_id=r.created_by_user_id
      where r.retired_at is null and r.desired_state='open'
      and r.control_state<>'agent' and (r.override_id is null or r.override_expires_at<=now())
      order by r.updated_at limit 32`)).rows;
  }
  /** Internal cleanup accepts an archived workspace, but still locks the current owned resource. */
  async prepareEnd(candidate: BrowserSession, boot: string) {
    return new BrowserResourceRepository(this.database).withLocked(candidate.created_by_user_id,candidate.bud_id,async (client,resource) => {
      if (resource.id !== candidate.browser_id || resource.desired_state !== "open" || resource.override_id)
        throw new BrowserError("browser_control_conflict");
      const requestId=ulid();
      const next=(await client.query<BrowserResource>(`update browser_resource set control_state='resume_pending',
        control_operation='end',control_request_id=$2,control_epoch=control_epoch+1,revision=revision+1,updated_at=now()
        where id=$1 returning *`,[resource.id,requestId])).rows[0];
      const workspace=(await client.query<BrowserSession>(`update browser_session set sequence=sequence+1,
        control_epoch=control_epoch+1,boot_id=$2 where id=$1 and browser_id=$3 and created_by_user_id=$4 returning *`,
        [candidate.id,boot,resource.id,candidate.created_by_user_id])).rows[0];
      if (!workspace) throw new BrowserError("browser_not_found");
      const session={...candidate,...workspace,browser_epoch:next.control_epoch,revision:next.revision,
        control_state:next.control_state};
      return {resource:next,session,request:this.command(session,{action:"control",operation:"end"},requestId)};
    });
  }

  async acknowledgeEnd(resource: BrowserResource) {
    return new BrowserResourceRepository(this.database).acknowledgeReturn(resource);
  }

  async failEnd(resource: BrowserResource) {
    return new BrowserResourceRepository(this.database).failControl(resource);
  }

  async get(owner: string, id: string): Promise<BrowserSession> {
    const row = (
      await this.database.query<BrowserSession>(`${owned} and s.id=$2`, [
        owner,
        id,
      ])
    ).rows[0];
    if (!row) throw new BrowserError("browser_not_found");
    return row;
  }
  async list(owner: string, thread: string): Promise<BrowserSession[]> {
    return (
      await this.database.query<BrowserSession>(
        `${owned} and s.thread_id=$2 order by s.created_at desc limit 10`,
        [owner, thread],
      )
    ).rows;
  }
  async pending(owner: string, session: string) {
    await this.get(owner, session);
    return (
      (
        await this.database.query(
          `select h.id,h.reason,h.kind,h.client_id,h.call_id,h.invocation_id,i.turn_id
      from browser_handoff h left join agent_invocation i on i.id=h.invocation_id and i.created_by_user_id=h.created_by_user_id
      where h.session_id=$1 and h.created_by_user_id=$2 and h.status='pending'
      and (h.invocation_id is null or (i.status in ('leased','running','waiting_for_user') and i.cancel_requested_at is null))`,
          [session, owner],
        )
      ).rows[0] ?? null
    );
  }
  async requestAgent(
    context: BrowserHandoffContext,
  ): Promise<{ session: BrowserSession; id: string }> {
    const identity = context.invocation;
    if (!identity) throw new BrowserError("browser_invocation_required");
    const client = await this.database.connect();
    try {
      await client.query("begin");
      await client.query("select bud_id from bud where bud_id=$1 and created_by_user_id=$2 for update", [context.budId,context.ownerUserId]);
      await client.query("select id from browser_resource where bud_id=$1 and created_by_user_id=$2 and retired_at is null for update", [context.budId,context.ownerUserId]);
      await client.query("select thread_id from thread where thread_id=$1 and created_by_user_id=$2 for update", [context.threadId,context.ownerUserId]);
      const inv = (
        await client.query(
          `select i.id from agent_invocation i join thread t on t.thread_id=i.thread_id
        join bud b on b.bud_id=i.bud_id where i.id=$1 and i.fence=$2 and i.worker_id=$3
        and i.created_by_user_id=$4 and t.created_by_user_id=$4 and b.created_by_user_id=$4
        and i.thread_id=$5 and i.bud_id=$6 and i.status='running' and i.lease_expires_at>now()
        and i.cancel_requested_at is null and t.deleted_at is null for update of i`,
          [
            identity.id,
            identity.fence,
            identity.workerId,
            context.ownerUserId,
            context.threadId,
            context.budId,
          ],
        )
      ).rows[0];
      if (!inv) throw new BrowserError("browser_authority_lost");
      const session = (
        await client.query<BrowserSession>(
          `${owned} and s.thread_id=$2 for update of s`,
          [context.ownerUserId, context.threadId],
        )
      ).rows[0];
      if (!session || session.control_state !== "agent")
        throw new BrowserError("browser_not_ready_for_handoff");
      const intent = await client.query(
        `select id from agent_invocation_action where invocation_id=$1 and call_id=$2
        and fence=$3 and status='intent' and kind='browser_request_handoff' and created_by_user_id=$4`,
        [
          identity.id,
          context.directive.callId,
          identity.fence,
          context.ownerUserId,
        ],
      );
      if (!intent.rowCount) throw new BrowserError("browser_authority_lost");
      const id = ulid();
      await client.query(
        `insert into browser_handoff(id,session_id,thread_id,bud_id,created_by_user_id,tenant_id,
        invocation_id,call_id,client_id,reason,kind) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'agent')`,
        [
          id,
          session.id,
          session.thread_id,
          session.bud_id,
          context.ownerUserId,
          session.tenant_id,
          identity.id,
          context.directive.callId,
          context.clientId,
          context.directive.args.reason,
        ],
      );
      await client.query("commit");
      return { session, id };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Active demand only. Inventory reads never call this method. */
  async prepareEnsure(owner: string, id: string, boot: string, explicitUrl: boolean) {
    const initial = await this.get(owner, id);
    return new BrowserResourceRepository(this.database).withLocked(owner, initial.bud_id, async (client, resource) => {
      if (resource.desired_state !== "open") throw new BrowserError("browser_stopped");
      await client.query("select thread_id from thread where thread_id=$1 and created_by_user_id=$2 for update", [initial.thread_id,owner]);
      const current = (await client.query<BrowserSession>(`${owned} and s.id=$2 for update of s`, [owner,id])).rows[0];
      if (!current || current.desired_state !== "open") throw new BrowserError("browser_not_found");
      if (current.boot_id !== boot) {
        await client.query(`update browser_session set generation=$2,boot_id=$3,
          control_epoch=control_epoch+1,sequence=sequence+1,pending_until=null,
          invocation_id=null,invocation_fence=null,updated_at=now() where id=$1`, [id,ulid(),boot]);
      }
      await client.query("update browser_session set control_epoch=greatest(1,control_epoch),sequence=greatest(1,sequence) where id=$1",[id]);
      const session = (await client.query<BrowserSession>(`${owned} and s.id=$2`,[owner,id])).rows[0];
      const request = this.command(session, {action:"ensure", explicit_url:explicitUrl});
      request.sequence = Math.max(1,request.sequence);
      request.control_epoch = Math.max(1,request.control_epoch);
      request.browser_color = await resolveBrowserColor(client, owner, session.bud_id);
      return {session,resource,request};
    });
  }

  acknowledgeRecovery(resource: BrowserResource, session: BrowserSession) {
    return new BrowserResourceRepository(this.database).acknowledgeRecovery(resource,session);
  }

  async ensured(owner: string, session: BrowserSession) {
    await new BrowserResourceRepository(this.database).withLocked(owner, session.bud_id, async (client, resource) => {
      if (resource.desired_state !== "open") throw new BrowserError("browser_stopped");
      const updated = await client.query(`update browser_session s set state='ready',updated_at=now()
        from thread t where s.id=$1 and s.generation=$2 and s.created_by_user_id=$3
        and s.desired_state='open' and s.closed_at is null and t.thread_id=s.thread_id
        and t.created_by_user_id=$3 and t.deleted_at is null returning s.id`, [session.id,session.generation,owner]);
      if (!updated.rowCount) throw new BrowserError("browser_not_found");
    });
    return this.get(owner, session.id);
  }

  async prepare(
    owner: string,
    id: string,
    boot: string,
    expectedRevision: number,
    requestId: string,
    command: Record<string, unknown>,
    nextState: string,
  ): Promise<{ session: BrowserSession; request: BrowserCommand }> {
    const initial = await this.get(owner, id);
    return new BrowserResourceRepository(this.database).withLocked(owner, initial.bud_id, async (client, resource) => {
      await client.query("select thread_id from thread where thread_id=$1 and created_by_user_id=$2 for update", [initial.thread_id,owner]);
      const current = (await client.query<BrowserSession>(`${owned} and s.id=$2 for update of s`, [owner,id])).rows[0];
      if (!current) throw new BrowserError("browser_not_found");
      if ((current.boot_id !== boot && !(command.action === "control" && ["pause","end"].includes(String(command.operation)))) || current.desired_state !== "open") throw new BrowserError("browser_interrupted");
      if (resource.revision !== expectedRevision) throw new BrowserError("browser_revision_conflict");
      const advance = command.action === "control" && command.operation !== "renew";
      if (advance) {
        const operation = command.operation;
        if (!["pause", "acquire"].includes(String(operation)) ||
            (operation === "acquire" && resource.control_state !== "paused"))
          throw new BrowserError("browser_control_conflict");
        await client.query(`update browser_resource set control_state=$2,
          private_content=private_content or $2='human_private',
          control_session_id=$3,
          control_epoch=control_epoch+1,revision=revision+1,control_request_id=$4,control_operation=$5,updated_at=now()
          where id=$1`, [resource.id,nextState,id,requestId,command.operation]);
      }
      // Viewer commands get an independent workspace ordering fence. Passive
      // media/fitting and renewal use command() and do not advance it.
      await client.query(`update browser_session set sequence=sequence+1,
        control_epoch=control_epoch+$3,invocation_id=$2,invocation_fence=1,
        generation=case when boot_id<>$4 then $5 else generation end,
        pending_until=case when boot_id<>$4 then null else pending_until end,
        boot_id=$4,state='ready',updated_at=now() where id=$1`, [id,`viewer_${id}`,Number(advance),boot,ulid()]);
      const session = (await client.query<BrowserSession>(`${owned} and s.id=$2`,[owner,id])).rows[0];
      const request = this.command(session,command,requestId);
      if (command.action === "control" && command.operation === "pause") {
        request.browser_color = await resolveBrowserColor(client, owner, session.bud_id);
      }
      return {session,request};
    });
  }
  command(
    session: BrowserSession,
    command: Record<string, unknown>,
    requestId = ulid(),
  ): BrowserCommand {
    const { action, ...control } = command;
    const wireCommand = action === "control" ? { action, control } : command;
    return {
      browser_id: session.browser_id,
      browser_epoch: session.browser_epoch,
      private_content: session.private_content,
      browser_paused: session.control_state !== "agent",
      request_id: requestId,
      session_id: session.id,
      generation: session.generation,
      thread_id: session.thread_id,
      owner_user_id: session.created_by_user_id,
      control_epoch: session.control_epoch,
      sequence: session.sequence,
      invocation_id: `viewer_${session.id}`,
      invocation_fence: 1,
      expires_at_ms: Date.now() + 30_000,
      command: wireCommand,
    };
  }
  async pauseAfterFailure(owner: string, id: string, revision: number) {
    const session = await this.get(owner,id);
    const repository = new BrowserResourceRepository(this.database);
    const resource = await repository.get(owner,session.bud_id);
    if (resource && resource.revision === revision) await repository.failControl(resource);
  }
  async recover() {
    await new BrowserResourceRepository(this.database).recover();
  }

  async requestClose(owner: string, id: string, revision: number) {
    const initial = await this.get(owner,id);
    const client = await this.database.connect();
    try {
      await client.query("begin");
      await client.query("select bud_id from bud where bud_id=$1 and created_by_user_id=$2 for update", [initial.bud_id,owner]);
      await client.query("select id from browser_resource where id=$1 for update", [initial.browser_id]);
      await client.query("select thread_id from thread where thread_id=$1 for update", [initial.thread_id]);
      const row = (
        await client.query<BrowserSession>(
          `${owned} and s.id=$2 for update of s`,
          [owner, id],
        )
      ).rows[0];
      if (!row) throw new BrowserError("browser_not_found");
      if (row.revision !== revision || row.desired_state !== "open")
        throw new BrowserError("browser_revision_conflict");
      await client.query(`update browser_resource set ended_override_id=override_id,
        override_id=null,override_viewer_id=null,override_carrier_id=null,override_expires_at=null,
        override_end_reason='workspace_closed',revision=revision+1,updated_at=now()
        where id=$1 and control_session_id=$2`,[row.browser_id,id]);
      await client.query<BrowserSession>(
        `update browser_session set desired_state='closed',updated_at=now() where id=$1 returning *`,
        [id],
      );
      const runs = await client.query<{ id: string }>(
        `select i.id from agent_invocation i join browser_handoff h on h.invocation_id=i.id
        where h.session_id=$1 and h.status='pending' and i.created_by_user_id=$2
        and i.status='waiting_for_user'`,
        [id, owner],
      );
      await client.query("commit");
      return {
        session: {...row,desired_state:"closed"},
        invocations: runs.rows.map((run) => run.id),
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}
