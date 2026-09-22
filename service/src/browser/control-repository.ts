import { resolveBrowserColor } from "./color.js";
import { BrowserResourceRepository } from "./resource-repository.js";
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
};
const owned = `select s.*,r.control_state,r.private_content,r.revision,r.control_request_id,
  r.control_epoch as browser_epoch,r.control_session_id from browser_session s
  join browser_resource r on r.id=s.browser_id and r.retired_at is null and r.desired_state='open'
  join thread t on t.thread_id=s.thread_id
  join bud b on b.bud_id=s.bud_id where s.created_by_user_id=$1 and t.created_by_user_id=$1
  and b.created_by_user_id=$1 and t.bud_id=s.bud_id and t.deleted_at is null and s.closed_at is null`;

/** Viewer inventory is always SQL-scoped; transitions use short row locks, not network transactions. */
export class BrowserControlRepository {
  constructor(private readonly database: Pool = pool) {}
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
      if ((current.boot_id !== boot && !(command.action === "control" && command.operation === "pause")) || current.desired_state !== "open") throw new BrowserError("browser_interrupted");
      if (resource.revision !== expectedRevision) throw new BrowserError("browser_revision_conflict");
      const advance = command.action === "control" && command.operation !== "renew";
      if (advance) {
        const operation = command.operation;
        if ((operation === "acquire" && resource.control_state !== "paused") ||
            (operation === "prepare_return" && !["paused", "human_private"].includes(resource.control_state)) ||
            (operation === "finish_return" && resource.control_state !== "resume_pending") ||
            (["prepare_return", "finish_return", "release"].includes(String(operation)) && resource.control_session_id !== id))
          throw new BrowserError("browser_control_conflict");
        await client.query(`update browser_resource set control_state=$2,
          private_content=private_content or $2='human_private',
          control_session_id=case when $2='human_private' then $3 else control_session_id end,
          control_epoch=control_epoch+1,revision=revision+1,control_request_id=$4,control_operation=$5,updated_at=now()
          where id=$1`, [resource.id,nextState,id,requestId,command.operation === "release" ? "pause" : command.operation]);
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
  async returned(owner: string, session: string, revision: number) {
    const row = await this.get(owner,session);
    const repository = new BrowserResourceRepository(this.database);
    const resource = await repository.get(owner,row.bud_id);
    if (!resource || resource.revision !== revision || resource.control_session_id !== session)
      throw new BrowserError("browser_revision_conflict");
    await repository.acknowledgeReturn(resource);
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
