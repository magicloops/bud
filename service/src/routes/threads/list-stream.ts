import type { FastifyInstance } from "fastify";
import { getAuthorizedBud, getAuthorizedThread, getOptionalViewer } from "../../auth/session.js";
import type { ThreadChangeListener } from "./change-listener.js";
import { ThreadListFeed, type ListEvent } from "./list-feed.js";

/** One stream per signed-in client; shared owner reads, per-connection auth checks. */
export async function registerThreadListStream(server: FastifyInstance,
  changes: ThreadChangeListener, feed: ThreadListFeed,
  resolveViewer: typeof getOptionalViewer = getOptionalViewer): Promise<void> {
  server.get("/api/me/thread-list/stream", async (request, reply) => {
    const viewer = await resolveViewer(request);
    if (!viewer) return reply.code(401).send({ error: "unauthorized" });
    await changes.ready();
    const current = await resolveViewer(request);
    if (!current || current.userId !== viewer.userId) return reply.code(401).send({ error: "unauthorized" });
    if (reply.raw.destroyed) return;
    let closed = false, checking = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const queue: ListEvent[] = [];
    const stop = () => {
      if (closed) return;
      closed = true; clearInterval(heartbeat); unsubscribe(); queue.length = 0; reply.raw.end();
    };
    const drain = async () => {
      if (closed || checking) return;
      checking = true;
      try {
        do {
          const actor = await resolveViewer(request);
          if (!actor || actor.userId !== viewer.userId || reply.raw.writableLength > 64 * 1024) { stop(); return; }
          if (closed) return;
          const event = queue.shift();
          if (event?.event === "upsert") {
            const thread = event.data.thread as { thread_id: string; bud_id: string };
            if (!await getAuthorizedThread(actor, thread.thread_id) || !await getAuthorizedBud(actor, thread.bud_id)) {
              reply.sse({ event: "resync_required", data: JSON.stringify({ reason: "membership_changed" }) });
              stop(); return;
            }
            if (closed) return;
          }
          reply.sse(event ? { event: event.event, data: JSON.stringify(event.data) } : { event: "heartbeat", data: "{}" });
          if (event?.event === "resync_required") { stop(); return; }
        } while (queue.length && !closed);
      } catch { stop(); }
      finally { checking = false; }
    };
    const unsubscribe = feed.subscribe(viewer.userId, event => {
      if (closed) return;
      if (queue.length >= 128) { stop(); return; }
      queue.push(event); void drain();
    });
    reply.raw.on("close", stop);
    reply.sse({ event: "ready", data: JSON.stringify(feed.checkpoint(viewer.userId)) });
    heartbeat = setInterval(() => void drain(), 15_000);
  });
}
