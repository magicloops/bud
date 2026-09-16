import { ulid } from "ulid";
import { randomUUID } from "node:crypto";
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
const owned = `select s.* from browser_session s join thread t on t.thread_id=s.thread_id
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
  async hasRunningInvocation(owner: string, session: string): Promise<boolean> {
    const result = await this.database.query(
      `select i.id from agent_invocation i join browser_session s
      on s.thread_id=i.thread_id and s.created_by_user_id=i.created_by_user_id
      where s.id=$1 and i.created_by_user_id=$2 and i.reserves_thread
        and i.status in ('leased','running')`,
      [session, owner],
    );
    return Boolean(result.rowCount);
  }
  async requestUser(
    owner: string,
    id: string,
  ): Promise<{ session: BrowserSession; created: boolean }> {
    const client = await this.database.connect();
    try {
      await client.query("begin");
      await client.query(
        `select t.thread_id from thread t join browser_session s on s.thread_id=t.thread_id
        where s.id=$1 and s.created_by_user_id=$2 and t.created_by_user_id=$2 for update of t`,
        [id, owner],
      );
      const invocation = (
        await client.query(
          `select i.id from agent_invocation i join browser_session s
        on s.thread_id=i.thread_id where s.id=$1 and i.created_by_user_id=$2 and s.created_by_user_id=$2
        and i.reserves_thread and i.status in ('leased','running') and i.cancel_requested_at is null for update of i`,
          [id, owner],
        )
      ).rows[0];
      const session = (
        await client.query<BrowserSession>(
          `${owned} and s.id=$2 for update of s`,
          [owner, id],
        )
      ).rows[0];
      if (!session) throw new BrowserError("browser_not_found");
      const existing = (
        await client.query(
          "select id from browser_handoff where session_id=$1 and invocation_id=$2 and status='pending'",
          [id, invocation?.id ?? null],
        )
      ).rows[0];
      const created = Boolean(invocation && !existing);
      if (created)
        await client.query(
          `insert into browser_handoff(id,session_id,thread_id,bud_id,created_by_user_id,
        tenant_id,invocation_id,client_id,reason,kind) values($1,$2,$3,$4,$5,$6,$7,$8,'User requested browser control','user')`,
          [
            ulid(),
            id,
            session.thread_id,
            session.bud_id,
            owner,
            session.tenant_id,
            invocation.id,
            randomUUID(),
          ],
        );
      await client.query("commit");
      return { session, created };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
  async requestAgent(
    context: BrowserHandoffContext,
  ): Promise<{ session: BrowserSession; id: string }> {
    const identity = context.invocation;
    if (!identity) throw new BrowserError("browser_invocation_required");
    const client = await this.database.connect();
    try {
      await client.query("begin");
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
    const client = await this.database.connect();
    try {
      await client.query("begin");
      if (command.action === "control" && command.operation === "acquire") {
        // Serialize private admission with invocation claiming (thread first).
        await client.query(
          `select t.thread_id from thread t join browser_session s on s.thread_id=t.thread_id
          where s.id=$1 and s.created_by_user_id=$2 and t.created_by_user_id=$2 for update of t`,
          [id, owner],
        );
        const active = await client.query(
          `select i.id from agent_invocation i join browser_session s on s.thread_id=i.thread_id
          where s.id=$1 and i.created_by_user_id=$2 and i.reserves_thread and i.status in ('leased','running')`,
          [id, owner],
        );
        if (active.rowCount)
          throw new BrowserError("browser_agent_still_running");
      }
      const current = (
        await client.query<BrowserSession>(
          `${owned} and s.id=$2 for update of s`,
          [owner, id],
        )
      ).rows[0];
      if (!current) throw new BrowserError("browser_not_found");
      if (current.boot_id !== boot || current.desired_state !== "open")
        throw new BrowserError("browser_interrupted");
      if (current.revision !== expectedRevision)
        throw new BrowserError("browser_revision_conflict");
      const epochAdvance =
        command.action === "control" && command.operation !== "renew";
      const stateChanged = epochAdvance;
      const session = (
        await client.query<BrowserSession>(
          `update browser_session set control_state=$2,
        private_content=private_content or $2='human_private',
        control_epoch=control_epoch+$3,sequence=sequence+1,revision=revision+$5,
        control_request_id=case when $5=1 then $4 else control_request_id end,
        updated_at=now() where id=$1 returning *`,
          [
            id,
            nextState,
            epochAdvance ? 1 : 0,
            requestId,
            stateChanged ? 1 : 0,
          ],
        )
      ).rows[0];
      await client.query("commit");
      return { session, request: this.command(session, command, requestId) };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
  command(
    session: BrowserSession,
    command: Record<string, unknown>,
    requestId = ulid(),
  ): BrowserCommand {
    const { action, ...control } = command;
    const wireCommand = action === "control" ? { action, control } : command;
    return {
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
    await this.database.query(
      `update browser_session set control_state='paused',revision=revision+1,updated_at=now()
      where id=$1 and created_by_user_id=$2 and revision=$3`,
      [id, owner, revision],
    );
  }
  async returned(
    owner: string,
    session: string,
    revision: number,
    requestId: string,
  ) {
    const client = await this.database.connect();
    try {
      await client.query("begin");
      // Match worker/cancellation lock order: invocation, then session/handoff.
      await client.query(
        `select i.id from agent_invocation i join browser_handoff h on h.invocation_id=i.id
        where h.session_id=$1 and h.created_by_user_id=$2 and i.created_by_user_id=$2
        and h.status='pending' for update of i`,
        [session, owner],
      );
      const row = (
        await client.query<BrowserSession>(
          `${owned} and s.id=$2 for update of s`,
          [owner, session],
        )
      ).rows[0];
      if (
        !row ||
        row.revision !== revision ||
        row.control_state !== "resume_pending"
      )
        throw new BrowserError("browser_revision_conflict");
      // Cancel/finish wins over return: never make an unrelated invocation runnable.
      await client.query(
        `update browser_handoff h set status=case when i.cancel_requested_at is null
          and i.status='waiting_for_user' then 'returned' else 'canceled' end,
          returned_by_user_id=$2,resolved_at=now() from agent_invocation i
        where h.session_id=$1 and h.created_by_user_id=$2 and h.status='pending'
          and i.id=h.invocation_id and i.created_by_user_id=$2`,
        [session, owner],
      );
      await client.query(
        `update browser_handoff set status='returned',returned_by_user_id=$2,resolved_at=now()
        where session_id=$1 and created_by_user_id=$2 and invocation_id is null and status='pending'`,
        [session, owner],
      );
      await client.query(
        `update browser_session set control_state='agent',private_content=false,revision=revision+1,
        control_request_id=$3,updated_at=now() where id=$1 and created_by_user_id=$2`,
        [session, owner, requestId],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
  async recover() {
    // Leases are memory-only. A new service cannot revive an old controller.
    await this.database
      .query(`update browser_session set control_state='paused',revision=revision+1
      where closed_at is null and control_state in ('human_private','resume_pending')`);
  }

  async requestClose(owner: string, id: string, revision: number) {
    const client = await this.database.connect();
    try {
      await client.query("begin");
      const row = (
        await client.query<BrowserSession>(
          `${owned} and s.id=$2 for update of s`,
          [owner, id],
        )
      ).rows[0];
      if (!row) throw new BrowserError("browser_not_found");
      if (row.revision !== revision)
        throw new BrowserError("browser_revision_conflict");
      const closed = await client.query<BrowserSession>(
        `update browser_session set desired_state='closed',control_state='paused',
        revision=revision+1,updated_at=now() where id=$1 returning *`,
        [id],
      );
      const runs = await client.query<{ id: string }>(
        `select id from agent_invocation where thread_id=$1
        and created_by_user_id=$2 and reserves_thread`,
        [row.thread_id, owner],
      );
      await client.query("commit");
      return {
        session: closed.rows[0],
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
