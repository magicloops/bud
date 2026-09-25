import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { pool } from "../../db/client.js";
import { getAuthorizedBud, getOptionalViewer } from "../../auth/session.js";

/** One shared LISTEN connection; notifications contain hints, never thread data. */
export async function registerThreadListStream(server: FastifyInstance, dependencies: {
  database: Pick<Pool, "connect">;
  resolveViewer: typeof getOptionalViewer;
  authorizeBud: typeof getAuthorizedBud;
} = { database: pool, resolveViewer: getOptionalViewer, authorizeBud: getAuthorizedBud }): Promise<void> {
  const { database, resolveViewer, authorizeBud } = dependencies;
  const listeners = new Set<{ change: (budId: string) => void; lost: () => void }>();
  let client: PoolClient | undefined;
  let connecting: Promise<void> | undefined;
  let stopped = false;
  const ready = async () => {
    if (stopped) throw new Error("thread_list_stopped");
    if (client) return;
    connecting ??= (async () => {
      const connection = await database.connect();
      const lost = () => {
        if (client !== connection) return;
        client = undefined;
        connection.release(true);
        for (const listener of [...listeners]) listener.lost();
      };
      connection.on("error", lost);
      connection.on("end", lost);
      try {
        const schema = (await connection.query("select current_schema() as name")).rows[0].name;
        const installed = await connection.query(`select count(*)::int as count from pg_trigger t
          join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
          where n.nspname=current_schema() and t.tgenabled in ('O','A')
            and ((c.relname='thread' and t.tgname='thread_list_change')
              or (c.relname='message' and t.tgname='thread_conversation_message'))`);
        if (installed.rows[0].count !== 2) throw new Error("thread_order_migration_required: apply migration 0043");
        connection.on("notification", (event) => {
          if (event.channel !== "bud_thread_list" || !event.payload) return;
          try {
            const hint = JSON.parse(event.payload);
            if (hint.schema === schema && typeof hint.bud_id === "string") {
              for (const listener of listeners) listener.change(hint.bud_id);
            }
          } catch { /* Invalid hints never provide state or authority. */ }
        });
        await connection.query("LISTEN bud_thread_list");
        if (stopped) throw new Error("thread_list_stopped");
        client = connection;
      } catch (error) { connection.release(true); throw error; }
    })().finally(() => { connecting = undefined; });
    await connecting;
  };
  server.addHook("preClose", async () => {
    stopped = true;
    for (const listener of [...listeners]) listener.lost();
    await connecting?.catch(() => {});
    const connection = client;
    client = undefined;
    if (connection) { await connection.query("UNLISTEN bud_thread_list").catch(() => {}); connection.release(true); }
  });

  server.get<{ Params: { budId: string } }>("/api/buds/:budId/thread-list/stream", async (request, reply) => {
    const viewer = await resolveViewer(request);
    if (!viewer) return reply.code(401).send({ error: "unauthorized" });
    const { budId } = request.params;
    if (!await authorizeBud(viewer, budId)) return reply.code(404).send({ error: "bud_not_found" });
    await ready();
    if (reply.raw.destroyed) return;
    // Ownership may have changed while establishing the shared LISTEN connection.
    if (!await authorizeBud(viewer, budId)) return reply.code(404).send({ error: "bud_not_found" });
    if (reply.raw.destroyed) return;
    if (!client) return reply.code(503).send({ error: "thread_list_unavailable" });
    let closed = false;
    let checking = false;
    let dirty = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      listeners.delete(listener);
      reply.raw.end();
    };
    const check = async () => {
      if (closed || checking) return;
      checking = true;
      try {
        do {
          const changed = dirty;
          dirty = false;
          // Re-resolve the current session and ownership, including expiry/revocation.
          const current = await resolveViewer(request);
          if (!current || current.userId !== viewer.userId || !await authorizeBud(current, budId)) { stop(); return; }
          if (reply.raw.writableLength > 64 * 1024) { stop(); return; }
          if (!closed) reply.sse({ event: changed ? "changed" : "heartbeat", data: "{}" });
        } while (dirty && !closed);
      } catch { stop(); }
      finally { checking = false; }
    };
    const listener = {
      change: (id: string) => { if (id === budId) { dirty = true; void check(); } },
      lost: stop,
    };
    listeners.add(listener);
    reply.raw.on("close", stop);
    reply.sse({ event: "ready", data: "{}" });
    heartbeat = setInterval(() => void check(), 15_000);
  });
}
