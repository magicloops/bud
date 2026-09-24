import type { Pool, PoolClient } from 'pg';

export type BrowserStateHint = { bud_id: string; thread_id?: string | null };
type Listener = { change: (hint: BrowserStateHint) => void; lost: () => void };

/** One session-preserving LISTEN connection per gateway. No metadata polling. */
export class BrowserStateEvents {
  private client?: PoolClient;
  private connecting?: Promise<void>;
  private stopped = false;
  private readonly listeners = new Set<Listener>();
  constructor(private readonly database: Pool) {}

  async ready() {
    if (this.stopped) throw new Error('browser_state_stopped');
    if (this.client) return;
    if (!this.connecting) this.connecting = this.connect().finally(() => { this.connecting = undefined; });
    await this.connecting;
  }
  private async connect() {
    const client = await this.database.connect();
    const lost = () => {
      if (this.client !== client) return;
      this.client = undefined;
      client.release(true);
      for (const listener of this.listeners) listener.lost();
    };
    client.on('error', lost);
    client.on('end', lost);
    try {
      const schema = (await client.query('select current_schema() as name')).rows[0].name;
      const installed = await client.query(`select count(*)::int n from pg_trigger t
        join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
        where n.nspname=current_schema() and not t.tgisinternal and t.tgenabled <> 'D'
          and t.tgname = any($1::text[])`, [[
        'browser_state_resource','browser_state_session','browser_state_handoff','browser_state_bud','browser_state_thread',
      ]]);
      if (installed.rows[0].n !== 5) throw new Error('browser_state_migration_required_0042');
      client.on('notification', message => {
        if (message.channel !== 'bud_browser_state' || !message.payload || message.payload.length > 2048) return;
        try {
          const value = JSON.parse(message.payload);
          if (value.schema === schema && typeof value.bud_id === 'string' &&
              (value.thread_id == null || typeof value.thread_id === 'string')) this.publish(value);
        } catch { /* A malformed hint never supplies state or authority. */ }
      });
      await client.query('LISTEN bud_browser_state');
      if (this.stopped) throw new Error('browser_state_stopped');
      this.client = client;
    } catch (error) { client.release(true); throw error; }
  }
  subscribe(change: Listener['change'], lost: Listener['lost']) {
    if (!this.client) throw new Error('browser_state_not_ready');
    const listener = { change, lost };
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Local in-memory controller changes supplement committed DB transitions. */
  publish(hint: BrowserStateHint) {
    for (const listener of this.listeners) listener.change(hint);
  }
  async close() {
    this.stopped = true;
    await this.connecting?.catch(() => {});
    for (const listener of this.listeners) listener.lost();
    this.listeners.clear();
    const client = this.client;
    this.client = undefined;
    if (client) { await client.query('UNLISTEN bud_browser_state').catch(() => {}); client.release(true); }
  }
}
