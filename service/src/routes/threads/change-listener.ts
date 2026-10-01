import type { Pool, PoolClient } from "pg";
import { pool } from "../../db/client.js";

export type ThreadChange = { owner: string; thread_id: string | null;
  kind: "summary" | "message" | "transcript" | "reset"; message_id: string | null };

/** Shared by list and transcript publishers; exactly one checked-out connection. */
export class ThreadChangeListener {
  private client: PoolClient | undefined;
  private connecting: Promise<void> | undefined;
  private stopped = false;
  private readonly listeners = new Set<{ change: (hint: ThreadChange) => void; lost: () => void }>();
  constructor(private readonly database: Pick<Pool, "connect"> = pool) {}
  subscribe(change: (hint: ThreadChange) => void, lost: () => void) {
    const listener = { change, lost }; this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  async ready(): Promise<void> {
    if (this.stopped) throw new Error("thread_changes_stopped");
    if (this.client) return;
    this.connecting ??= this.connect().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private async connect(): Promise<void> {
    const connection = await this.database.connect();
    let failed = false;
    const lost = () => {
      failed = true;
      if (this.client !== connection) return;
      this.client = undefined;
      connection.release(true);
      for (const listener of [...this.listeners]) listener.lost();
    };
    connection.on("error", lost); connection.on("end", lost);
    try {
      const schema = (await connection.query("select current_schema() as name")).rows[0].name;
      const installed = await connection.query(`select count(*)::int as count from pg_trigger t
        join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
        where n.nspname=current_schema() and t.tgenabled in ('O','A') and t.tgname in
        ('bud_thread_changed','bud_thread_read_changed','bud_thread_terminal_changed','bud_thread_owner_changed','bud_transcript_changed')`);
      if (installed.rows[0].count !== 5) throw new Error("thread_changes_migration_required: apply migration 0049");
      connection.on("notification", event => {
        if (event.channel !== "bud_thread_changes" || !event.payload || event.payload.length > 4096) return;
        try {
          const hint = JSON.parse(event.payload);
          if (hint.schema !== schema || typeof hint.owner !== "string" ||
            !["summary", "message", "transcript", "reset"].includes(hint.kind) ||
            !(hint.thread_id === null || typeof hint.thread_id === "string") ||
            !(hint.message_id === null || typeof hint.message_id === "string")) return;
          for (const listener of this.listeners) listener.change(hint);
        } catch { for (const listener of this.listeners) listener.lost(); }
      });
      await connection.query("LISTEN bud_thread_changes");
      if (this.stopped || failed) throw new Error("thread_changes_unavailable");
      this.client = connection;
    } catch (error) { connection.release(true); throw error; }
  }
  async close(): Promise<void> {
    this.stopped = true;
    for (const listener of [...this.listeners]) listener.lost();
    this.listeners.clear();
    await this.connecting?.catch(() => {});
    const client = this.client; this.client = undefined;
    if (client) { await client.query("UNLISTEN bud_thread_changes").catch(() => {}); client.release(true); }
  }
}
