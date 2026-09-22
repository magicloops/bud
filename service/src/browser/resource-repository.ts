import type { Pool, PoolClient } from "pg";
import { ulid } from "ulid";
import { pool } from "../db/client.js";
import { BrowserError } from "./repository.js";

export type BrowserResource = {
  id: string;
  bud_id: string;
  created_by_user_id: string;
  tenant_id: string | null;
  profile_generation: number;
  control_state: "agent" | "paused" | "human_private" | "resume_pending";
  private_content: boolean;
  control_epoch: number;
  control_session_id: string | null;
  revision: number;
  control_request_id: string | null;
  control_operation: "pause" | "acquire" | "prepare_return" | "finish_return" | null;
  desired_state: "open" | "stop_pending" | "stopped" | "reset_pending";
  lifecycle_request_id: string | null;
  requested_by_user_id: string | null;
  retired_at: Date | null;
};

/**
 * Durable Bud-wide intent. No controller lease, page data or second scheduler.
 * Lock order: owned Bud -> browser resource -> thread/invocation -> workspace.
 * Control/admission transactions use this same order.
 */
export class BrowserResourceRepository {
  constructor(private readonly database: Pool = pool) {}

  async get(owner: string, bud: string): Promise<BrowserResource | null> {
    return (await this.database.query<BrowserResource>(
      `select r.* from browser_resource r join bud b on b.bud_id=r.bud_id
       where r.bud_id=$1 and r.created_by_user_id=$2 and b.created_by_user_id=$2
       and r.retired_at is null`, [bud, owner],
    )).rows[0] ?? null;
  }

  /** The callback may lock workspace/invocation rows, but must not perform I/O. */
  async withLocked<T>(owner: string, bud: string,
    operation: (client: PoolClient, resource: BrowserResource) => Promise<T>,
    create = false): Promise<T> {
    const client = await this.database.connect();
    try {
      await client.query("begin");
      const owned = (await client.query<{tenant_id: string | null}>(
        "select tenant_id from bud where bud_id=$1 and created_by_user_id=$2 for update",
        [bud, owner],
      )).rows[0];
      if (!owned) throw new BrowserError("browser_not_found");
      // Never reuse another owner's resource/profile, even if ownership changed
      // while this service was down. Claim/unclaim must also retire proactively.
      await client.query(`update browser_resource set retired_at=now(),control_state='paused',
        control_epoch=control_epoch+1,revision=revision+1,updated_at=now()
        where bud_id=$1 and created_by_user_id<>$2 and retired_at is null`, [bud, owner]);
      let resource = (await client.query<BrowserResource>(
        "select * from browser_resource where bud_id=$1 and created_by_user_id=$2 and retired_at is null for update",
        [bud, owner],
      )).rows[0];
      if (!resource && create) resource = (await client.query<BrowserResource>(
        `insert into browser_resource(id,bud_id,created_by_user_id,tenant_id)
         values($1,$2,$3,$4) returning *`, [`managed_${ulid()}`, bud, owner, owned.tenant_id],
      )).rows[0];
      if (!resource) throw new BrowserError("browser_not_found");
      const result = await operation(client, resource);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally { client.release(); }
  }

  ensure(owner: string, bud: string): Promise<BrowserResource> {
    return this.withLocked(owner, bud, async (_client, resource) => resource, true);
  }

  /** Call only for an acknowledged finish_return from the exact captured carrier. */
  acknowledgeReturn(expected: BrowserResource): Promise<BrowserResource> {
    return this.withLocked(expected.created_by_user_id, expected.bud_id, async (client, resource) => {
      this.receipt(resource, expected, "control");
      if (resource.control_state !== "resume_pending" || resource.control_operation !== "finish_return") throw new BrowserError("browser_control_conflict");
      await this.lockThreads(client, resource);
      // Lock invocations before handoffs, matching cancellation and continuation.
      await client.query(`select i.id from agent_invocation i join browser_handoff h on h.invocation_id=i.id
        join browser_session s on s.id=h.session_id where s.browser_id=$1
        and h.created_by_user_id=$2 and i.created_by_user_id=$2 and h.status='pending'
        order by i.id for update of i`, [resource.id, resource.created_by_user_id]);
      await client.query(`update browser_handoff h set status=case when
          i.cancel_requested_at is null and i.status='waiting_for_user' and t.deleted_at is null
          and s.closed_at is null and s.desired_state='open' then 'returned' else 'canceled' end,
          returned_by_user_id=$2,resolved_at=now()
        from agent_invocation i,browser_session s,thread t where h.invocation_id=i.id
        and s.id=h.session_id and t.thread_id=s.thread_id and s.browser_id=$1
        and h.created_by_user_id=$2 and i.created_by_user_id=$2 and s.created_by_user_id=$2
        and t.created_by_user_id=$2 and h.status='pending'`, [resource.id, resource.created_by_user_id]);
      await client.query(`update browser_handoff h
        set status=case when s.closed_at is null and s.desired_state='open' and t.deleted_at is null then 'returned' else 'canceled' end,
        returned_by_user_id=$2,resolved_at=now()
        from browser_session s,thread t where s.id=h.session_id and t.thread_id=s.thread_id and t.created_by_user_id=$2 and s.browser_id=$1
        and h.created_by_user_id=$2 and h.invocation_id is null and h.status='pending'`,
        [resource.id, resource.created_by_user_id]);
      return (await client.query<BrowserResource>(`update browser_resource set control_state='agent',private_content=false,
        control_session_id=null,revision=revision+1,updated_at=now() where id=$1 returning *`, [resource.id])).rows[0];
    });
  }

  /** A late failure must not pause a newer control decision. */
  async failControl(expected: BrowserResource): Promise<boolean> {
    const result = await this.database.query(`update browser_resource r set control_state='paused',
      revision=revision+1,updated_at=now() from bud b where r.id=$1 and r.bud_id=b.bud_id
      and r.created_by_user_id=$2 and b.created_by_user_id=$2 and r.revision=$3
      and r.control_epoch=$4 and r.control_request_id=$5 and r.retired_at is null`,
      [expected.id, expected.created_by_user_id, expected.revision, expected.control_epoch, expected.control_request_id]);
    return Boolean(result.rowCount);
  }

  /** Service recovery never clears private intent or claims that data was reset. */
  async recover(): Promise<void> {
    await this.database.query(`update browser_resource set control_state='paused',revision=revision+1,
      control_epoch=control_epoch+1,updated_at=now() where retired_at is null
      and control_state in ('human_private','resume_pending')`);
  }

  requestLifecycle(owner: string, bud: string, revision: number,
    operation: "stop" | "reset", confirmedReset = false): Promise<BrowserResource> {
    if (operation === "reset" && !confirmedReset) throw new BrowserError("browser_reset_confirmation_required");
    return this.withLocked(owner, bud, async (client, resource) => {
      this.revision(resource, revision);
      if (["stop_pending", "reset_pending"].includes(resource.desired_state))
        throw new BrowserError("browser_lifecycle_pending");
      return (await client.query<BrowserResource>(`update browser_resource set desired_state=$2,
        control_state='paused',control_epoch=control_epoch+1,revision=revision+1,
        lifecycle_request_id=$3,requested_by_user_id=$4,updated_at=now() where id=$1 returning *`,
        [resource.id, operation === "reset" ? "reset_pending" : "stop_pending", ulid(), owner])).rows[0];
    });
  }

  /** Stop/reset completion is recorded only after owned-process/storage acknowledgement. */
  acknowledgeLifecycle(expected: BrowserResource): Promise<BrowserResource> {
    return this.withLocked(expected.created_by_user_id, expected.bud_id, async (client, resource) => {
      this.receipt(resource, expected, "lifecycle");
      if (!["stop_pending", "reset_pending"].includes(resource.desired_state))
        throw new BrowserError("browser_lifecycle_conflict");
      const reset = resource.desired_state === "reset_pending";
      await this.lockThreads(client, resource);
      await client.query(`select i.id from agent_invocation i join browser_handoff h on h.invocation_id=i.id
        join browser_session s on s.id=h.session_id where s.browser_id=$1
        and h.status='pending' order by i.id for update of i`, [resource.id]);
      await client.query(`update browser_session set desired_state='closed',state='closed',closed_at=now(),updated_at=now()
        where browser_id=$1 and closed_at is null`, [resource.id]);
      await client.query(`update browser_handoff h set status='canceled',resolved_at=now()
        from browser_session s where s.id=h.session_id and s.browser_id=$1 and h.status='pending'`, [resource.id]);
      return (await client.query<BrowserResource>(`update browser_resource set desired_state='stopped',
        profile_generation=profile_generation+$2,control_session_id=null,
        private_content=case when $2=1 then false else private_content end,
        revision=revision+1,updated_at=now() where id=$1 returning *`, [resource.id, Number(reset)])).rows[0];
    });
  }

  private async lockThreads(client: PoolClient, resource: BrowserResource) {
    // Lock affected threads in stable order before invocation/workspace mutations.
    await client.query(`select t.thread_id from thread t where t.bud_id=$1
      and t.created_by_user_id=$2 and exists (select 1 from browser_session s
        where s.thread_id=t.thread_id and s.bud_id=$1 and s.created_by_user_id=$2
        and s.browser_id=$3)
      order by t.thread_id for update of t`,
      [resource.bud_id, resource.created_by_user_id, resource.id]);
  }

  private revision(resource: BrowserResource, expected: number) {
    if (resource.revision !== expected) throw new BrowserError("browser_revision_conflict");
  }
  private receipt(resource: BrowserResource, expected: BrowserResource, kind: "control" | "lifecycle") {
    this.revision(resource, expected.revision);
    const field = kind === "control" ? "control_request_id" : "lifecycle_request_id";
    if (resource.id !== expected.id || resource.control_epoch !== expected.control_epoch ||
        !expected[field] || resource[field] !== expected[field] || resource.profile_generation !== expected.profile_generation)
      throw new BrowserError("browser_stale_acknowledgement");
  }
}
