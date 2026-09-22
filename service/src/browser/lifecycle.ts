import { pool } from "../db/client.js";
import { BrowserError } from "./repository.js";
import { BrowserResourceRepository, type BrowserResource } from "./resource-repository.js";
import { browserCarrier, dispatchBrowser } from "./transport.js";
import type { BrowserControl } from "./control.js";

/** Durable human intent; the existing broker tick retries only stop/reset. */
export class BrowserLifecycle {
  constructor(private readonly control: BrowserControl,
    private readonly resources = new BrowserResourceRepository()) {}

  async request(owner: string, bud: string, revision: number, operation: "stop" | "reset", confirmed: boolean) {
    const resource = await this.resources.requestLifecycle(owner, bud, revision, operation, confirmed);
    this.control.onFence(resource.id);
    return resource; // Pending, including when the Bud is offline. Never claim early completion.
  }

  async reconcile(signal: AbortSignal) {
    const pending = await pool.query<BrowserResource>(`select r.* from browser_resource r
      join bud b on b.bud_id=r.bud_id and b.created_by_user_id=r.created_by_user_id
      where r.retired_at is null and r.desired_state in ('stop_pending','reset_pending')
      order by r.updated_at limit 32`);
    for (const resource of pending.rows) {
      if (signal.aborted) return;
      const carrier = browserCarrier(resource.bud_id);
      if (!carrier || !resource.lifecycle_request_id) continue;
      this.control.onFence(resource.id);
      const result = await dispatchBrowser(carrier, {
        request_id: resource.lifecycle_request_id, browser_id: resource.id,
        browser_epoch: resource.control_epoch, private_content: resource.private_content,
        browser_paused: true, owner_user_id: resource.created_by_user_id,
        // Resource lifecycle has no thread/workspace. These routing fields never
        // enter workspace admission, and are correlated by the same transport.
        session_id: resource.id, generation: String(resource.profile_generation),
        thread_id: resource.id, control_epoch: resource.control_epoch,
        sequence: resource.revision + 1, invocation_id: resource.lifecycle_request_id,
        invocation_fence: 1, expires_at_ms: Date.now() + 30_000,
        command: { action: "lifecycle", reset: resource.desired_state === "reset_pending" },
      }, signal);
      if (result.ok && result.data?.lifecycle_acknowledged === true) {
        try { await this.resources.acknowledgeLifecycle(resource); }
        catch (error) {
          if (!(error instanceof BrowserError)) throw error;
          // Another exact acknowledgement or an ownership change won the race.
        }
      }
    }
  }
}
