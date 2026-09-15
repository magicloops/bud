import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { WebSocketServer } from "ws";
import { and, eq, gt } from "drizzle-orm";
import { db } from "../db/client.js";
import { authSessionTable } from "../db/schema.js";
import { config } from "../config.js";
import {
  requireViewer,
  getOptionalViewer,
  getAuthorizedThread,
  type Viewer,
} from "../auth/session.js";
import { BrowserControl } from "./control.js";
import { BrowserMedia } from "./media.js";
import { BrowserError } from "./repository.js";
import type { BrowserSession } from "./control-repository.js";

const id = z.string().min(1).max(128);
const bodyBase = { viewer_id: z.string().uuid() };
const point = {
  x: z.number().min(0).max(8192),
  y: z.number().min(0).max(8192),
};
const input = z
  .object({
    ...bodyBase,
    target_id: id,
    document_id: id,
    frame_token: id,
    input: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("back") }).strict(),
      z.object({ kind: z.literal("click"), ...point }).strict(),
      z
        .object({
          kind: z.literal("scroll"),
          ...point,
          delta_y: z.number().min(-2000).max(2000),
        })
        .strict(),
      z
        .object({
          kind: z.literal("text"),
          focus_token: id,
          text: z.string().min(1).max(8192),
        })
        .strict(),
      z
        .object({
          kind: z.literal("key"),
          focus_token: id,
          key: z.enum([
            "Tab",
            "Enter",
            "Backspace",
            "Delete",
            "ArrowLeft",
            "ArrowRight",
            "Home",
            "End",
          ]),
        })
        .strict(),
    ]),
  })
  .strict();
const publicSession = (s: BrowserSession, canResize = false, canCapture = false, canGoBack = false, canAgentResize = false, runtimeStatus = "available") => ({
  runtime_status: runtimeStatus,
  can_resize_agent_viewport: canAgentResize,
  can_navigate_history: canGoBack,
  can_capture_hidpi: canCapture,
  can_resize_viewport: canResize,
  session_id: s.id,
  thread_id: s.thread_id,
  bud_id: s.bud_id,
  generation: s.generation,
  state: s.desired_state === "closed" ? "closing" : s.state,
  control_state: s.control_state,
  control_epoch: s.control_epoch,
  revision: s.revision,
  can_view:
    runtimeStatus === "available" &&
    s.desired_state === "open" &&
    !s.private_content &&
    ["agent", "paused"].includes(s.control_state),
});

async function alive(viewer: Viewer): Promise<boolean> {
  if (!viewer.sessionId) return false;
  const rows = await db
    .select({ id: authSessionTable.id })
    .from(authSessionTable)
    .where(
      and(
        eq(authSessionTable.id, viewer.sessionId),
        eq(authSessionTable.userId, viewer.userId),
        gt(authSessionTable.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return rows.length === 1;
}

/** Browser session is owner/Bud/thread scoped. No page content is persisted here. */
export async function registerBrowserRoutes(
  server: FastifyInstance,
  control: BrowserControl,
  media: BrowserMedia,
) {
  const diagnostic = (fields: Record<string, string | number | boolean>) =>
    server.log.info({ component: "browser_lifecycle", ...fields }, "Browser lifecycle");
  control.onDiagnostic = diagnostic;
  media.onDiagnostic = diagnostic;
  // @fastify/websocket exposes one upgrader, with no per-route receive limit.
  // Delegate just these routes to a bounded receiver, retaining Fastify's
  // authorization-before-upgrade flow and leaving other carriers unchanged.
  const bounded = new WebSocketServer({
    noServer: true,
    maxPayload: 1_420_000,
    perMessageDeflate: false,
  });
  const upgrade = server.websocketServer.handleUpgrade.bind(
    server.websocketServer,
  );
  server.websocketServer.handleUpgrade = (request, socket, head, callback) => {
    const path = request.url?.split("?")[0] ?? "";
    if (
      path === "/ws/browser-media" ||
      /^\/api\/browser\/sessions\/[^/]+\/media$/.test(path)
    ) {
      bounded.handleUpgrade(request, socket, head, callback);
    } else upgrade(request, socket, head, callback);
  };
  server.addHook("preClose", async () => {
    for (const socket of bounded.clients) socket.terminate();
    bounded.close();
  });
  const sessionId = (request: FastifyRequest) =>
    z.object({ session_id: id }).parse(request.params).session_id;
  const identity = (viewer: Viewer, client: string) =>
    `${viewer.sessionId}:${client}`;
  const viewer = async (request: FastifyRequest, reply: FastifyReply) => {
    reply
      .header("Cache-Control", "no-store")
      .header("Referrer-Policy", "no-referrer");
    const actor = await requireViewer(request, reply);
    if (!actor) return null;
    if (!(await alive(actor))) {
      reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    if (request.method !== "GET" || request.headers.upgrade) {
      if (
        !request.headers.origin ||
        !config.betterAuthTrustedOrigins.includes(request.headers.origin)
      ) {
        reply.code(403).send({ error: "origin_denied" });
        return null;
      }
    }
    return actor;
  };
  await server.register(async (routes) => {
    routes.setErrorHandler((error, _request, reply) => {
      const code =
        error instanceof BrowserError
          ? error.code
          : error instanceof z.ZodError
            ? "browser_invalid_request"
            : "browser_unavailable";
      reply
        .code(
          code === "browser_not_found"
            ? 404
            : code === "browser_invalid_request"
              ? 400
              : 409,
        )
        .send({ error: code });
    });
    routes.get(
      "/api/threads/:thread_id/browser-sessions",
      async (request, reply) => {
        const actor = await viewer(request, reply);
        if (!actor) return;
        const threadId = z
          .object({ thread_id: z.string().uuid() })
          .parse(request.params).thread_id;
        if (!(await getAuthorizedThread(actor, threadId)))
          throw new BrowserError("browser_not_found");
        return {
          sessions: await Promise.all((await control.repository.list(actor.userId, threadId)).map(
            async (session) => ({ ...publicSession(session, control.viewportAvailable(session), control.captureAvailable(session), control.historyAvailable(session), control.agentViewportAvailable(session), control.runtimeStatus(session)), handoff: await control.repository.pending(actor.userId, session.id) }),
          )),
        };
      },
    );
    routes.get("/api/browser/sessions/:session_id", async (request, reply) => {
      const actor = await viewer(request, reply);
      if (!actor) return;
      const id = sessionId(request);
      const session = await control.repository.get(actor.userId, id);
      return {
        ...publicSession(session, control.viewportAvailable(session), control.captureAvailable(session), control.historyAvailable(session), control.agentViewportAvailable(session), control.runtimeStatus(session)),
        handoff: await control.repository.pending(actor.userId, id),
        can_take_control: control.runtimeStatus(session) === "available" && !(await control.repository.hasRunningInvocation(
          actor.userId,
          id,
        )),
      };
    });
    routes.post(
      "/api/browser/sessions/:session_id/control",
      { bodyLimit: 2048 },
      async (request, reply) => {
        const actor = await viewer(request, reply);
        if (!actor) return;
        const body = z
          .object({
            ...bodyBase,
            revision: z.number().int().nonnegative(),
            operation: z.enum([
              "acquire",
              "renew",
              "release",
              "return",
              "close",
            ]),
          })
          .strict()
          .parse(request.body);
        const args = [
          actor.userId,
          sessionId(request),
          identity(actor, body.viewer_id),
        ] as const;
        const result =
          body.operation === "close"
            ? await control.close(
                actor.userId,
                sessionId(request),
                body.revision,
              )
            : body.operation === "acquire"
              ? await control.acquire(...args, body.revision)
              : body.operation === "renew"
                ? await control.renew(...args)
                : body.operation === "release"
                  ? await control.release(...args)
                  : await control.returnToAgent(...args, body.revision);
        return publicSession(result, control.viewportAvailable(result), control.captureAvailable(result), control.historyAvailable(result), control.agentViewportAvailable(result), control.runtimeStatus(result));
      },
    );
    routes.post("/api/browser/sessions/:session_id/viewport", { bodyLimit: 2048 }, async (request, reply) => {
      const actor = await viewer(request, reply);
      if (!actor) return;
      const { viewer_id, ...viewport } = z.object({ ...bodyBase, target_id: id, document_id: id,
        width: z.number().int().min(240).max(2560), height: z.number().int().min(160).max(2560),
      }).strict().parse(request.body);
      return control.resizeViewport(actor.userId, sessionId(request), identity(actor, viewer_id), viewport);
    });
    routes.post(
      "/api/browser/sessions/:session_id/input",
      { bodyLimit: 24 * 1024 },
      async (request, reply) => {
        const actor = await viewer(request, reply);
        if (!actor) return;
        const { viewer_id, ...command } = input.parse(request.body);
        return control.input(
          actor.userId,
          sessionId(request),
          identity(actor, viewer_id),
          command,
        );
      },
    );
    routes.get(
      "/api/browser/sessions/:session_id/media",
      {
        websocket: true,
        preValidation: async (request, reply) => {
          const actor = await viewer(request, reply);
          if (!actor) return;
          await control.repository.get(actor.userId, sessionId(request));
        },
      },
      (socket, request) => {
        const timer = setTimeout(() => socket.terminate(), 3000);
        socket.once("message", (raw) => {
          clearTimeout(timer);
          void (async () => {
            if (Buffer.byteLength(raw.toString()) > 256)
              throw new Error("size");
            const body = z
              .object(bodyBase)
              .strict()
              .parse(JSON.parse(raw.toString()));
            const actor = await getOptionalViewer(request);
            if (!actor || !(await alive(actor))) throw new Error("auth");
            await media.attachViewer(
              socket,
              actor.userId,
              sessionId(request),
              identity(actor, body.viewer_id),
              () => alive(actor),
            );
          })().catch(() => socket.terminate());
        });
        socket.on("close", () => clearTimeout(timer));
        socket.on("error", () => {});
      },
    );
    // A one-use ticket from the authenticated daemon control carrier authorizes
    // this subordinate connection. No ticket appears in its URL/access log.
    routes.get("/ws/browser-media", { websocket: true }, (socket) =>
      media.attachDaemon(socket),
    );
  });
}
