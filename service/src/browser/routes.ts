import { BrowserMobileAuth, mobileCookie, scopedBrowserOperation, type MobileVisit } from "./mobile-auth.js";
import { BrowserLifecycle } from "./lifecycle.js";
import { BrowserResourceRepository } from "./resource-repository.js";
import { registerAgentCaptures } from "./agent-capture.js";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { and, eq, gt } from "drizzle-orm";
import { db } from "../db/client.js";
import { authSessionTable } from "../db/schema.js";
import { config } from "../config.js";
import {
  requireViewer,
  getOptionalViewer,
  getOptionalBearerViewer,
  getAuthorizedThread,
  getAuthorizedBud,
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
  control_epoch: s.browser_epoch,
  browser_id: s.browser_id,
  control_session_id: s.control_session_id,
  revision: s.revision,
  can_view:
    runtimeStatus === "available" &&
    s.desired_state === "open" &&
    !s.private_content &&
    ["agent", "paused"].includes(s.control_state),
});

type BrowserActor = Viewer & { mobile?: MobileVisit; mobileToken?: string };
const mobileAuth = new BrowserMobileAuth();

async function browserActor(request: FastifyRequest): Promise<BrowserActor | null> {
  const token = request.headers.cookie?.split(";").map(v => v.trim()).find(v => v.startsWith(`${mobileCookie}=`))?.slice(mobileCookie.length + 1);
  if (token) {
    const mobile = await mobileAuth.resolve(token);
    return mobile ? { userId: mobile.created_by_user_id, sessionId: null, email: null, authType: "cookie", mobile, mobileToken: token } : null;
  }
  return getOptionalViewer(request);
}

async function alive(viewer: BrowserActor): Promise<boolean> {
  if (viewer.mobileToken) return !!(await mobileAuth.resolve(viewer.mobileToken));
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

/**
 * Reads the viewer hello, then runs `attach`, which registers the media
 * listener after authorization I/O. Messages sent behind the hello are held
 * until that listener exists instead of being dropped by the bare emitter.
 */
export function viewerHandshake(socket: WebSocket, attach: (hello: string) => Promise<void>) {
  const timer = setTimeout(() => socket.terminate(), 3000);
  socket.once("message", (raw) => {
    clearTimeout(timer);
    const held: RawData[] = [];
    const hold = (later: RawData) => {
      if (held.push(later) > 16) socket.terminate();
    };
    socket.on("message", hold);
    attach(raw.toString())
      .then(() => {
        socket.off("message", hold);
        for (const later of held) socket.emit("message", later, false);
      })
      .catch(() => socket.terminate());
  });
  socket.on("close", () => clearTimeout(timer));
  socket.on("error", () => {});
}

/** Browser session is owner/Bud/thread scoped. No page content is persisted here. */
export async function registerBrowserRoutes(
  server: FastifyInstance,
  control: BrowserControl,
  media: BrowserMedia,
) {
  await registerAgentCaptures(server);
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
  const identity = (viewer: BrowserActor, client: string) => {
    if (viewer.mobile && viewer.mobile.viewer_id !== client) throw new BrowserError("browser_not_found");
    return `${viewer.mobile ? `mobile_${viewer.mobile.id}` : viewer.sessionId}:${client}`;
  };
  const viewer = async (request: FastifyRequest, reply: FastifyReply) => {
    reply
      .header("Cache-Control", "no-store")
      .header("Referrer-Policy", "no-referrer");
    const actor = await browserActor(request);
    if (!actor) { reply.code(401).send({error:"unauthorized"}); return null; }
    if (actor.mobile && (request.params as {session_id?:string}).session_id !== actor.mobile.session_id) {
      reply.code(404).send({error:"browser_not_found"}); return null;
    }
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
    // Native bearer mints/revokes only. The embedded page receives no OAuth token.
    routes.post("/api/browser/sessions/:session_id/viewer-grants", {bodyLimit:1024}, async (request, reply) => {
      reply.header("Cache-Control","no-store");
      const actor = await getOptionalBearerViewer(request);
      if (!actor) return reply.code(401).send({error:"unauthorized"});
      const body = z.object(bodyBase).strict().parse(request.body);
      const session = await control.repository.get(actor.userId,sessionId(request));
      return {...await mobileAuth.mint(session,body.viewer_id), bootstrap_path:"/api/browser/viewer-bootstrap"};
    });
    routes.post("/api/browser/viewer-bootstrap", {bodyLimit:1024}, async (request, reply) => {
      reply.header("Cache-Control","no-store").header("Referrer-Policy","no-referrer");
      const {grant} = z.object({grant:z.string().regex(/^[\w-]{43}$/)}).strict().parse(request.body);
      const result = await mobileAuth.redeem(grant);
      if (!result) return reply.code(401).send({error:"browser_grant_expired"});
      await control.repository.get(result.visit.created_by_user_id,result.visit.session_id);
      reply.header("Set-Cookie",`${mobileCookie}=${result.token}; Path=/api/browser/sessions/${result.visit.session_id}; Secure; HttpOnly; SameSite=Strict; Max-Age=28800`);
      return reply.code(303).header("Location",`/browser-mobile/${result.visit.session_id}?viewer_id=${result.visit.viewer_id}&visit_id=${result.visit.id}`).send();
    });
    routes.post("/api/browser/viewer-visits/:visit_id", {bodyLimit:1024}, async (request,reply) => {
      reply.header("Cache-Control","no-store");
      const actor = await getOptionalBearerViewer(request);
      if (!actor) return reply.code(401).send({error:"unauthorized"});
      const visit = z.object({visit_id:id}).parse(request.params).visit_id;
      const body = z.discriminatedUnion("operation",[
        z.object({operation:z.literal("revoke")}).strict(),
        z.object({operation:z.literal("refresh"),grant:z.string().regex(/^[\w-]{43}$/)}).strict(),
      ]).parse(request.body);
      if (body.operation === "revoke") await mobileAuth.revoke(actor.userId,visit);
      else if (!await mobileAuth.refresh(actor.userId,visit,body.grant)) return reply.code(401).send({error:"browser_visit_expired"});
      return {ok:true};
    });
    // Bud owns the shared profile; actor and owner are resolved before resource I/O.
    routes.get("/api/buds/:bud_id/browser", async (request, reply) => {
      const actor = await viewer(request, reply);
      if (!actor) return;
      const { bud_id } = z.object({ bud_id: id }).parse(request.params);
      if (!(await getAuthorizedBud(actor, bud_id))) throw new BrowserError("browser_not_found");
      const resource = await new BrowserResourceRepository().get(actor.userId, bud_id);
      return { browser: resource && { browser_id: resource.id, revision: resource.revision,
        desired_state: resource.desired_state, control_state: resource.control_state } };
    });
    routes.post("/api/buds/:bud_id/browser/lifecycle", { bodyLimit: 1024 }, async (request, reply) => {
      const actor = await viewer(request, reply);
      if (!actor) return;
      const { bud_id } = z.object({ bud_id: id }).parse(request.params);
      if (!(await getAuthorizedBud(actor, bud_id))) throw new BrowserError("browser_not_found");
      const body = z.object({ revision: z.number().int().nonnegative(), operation: z.enum(["stop", "reset"]),
        confirmed: z.boolean().default(false) }).strict().parse(request.body);
      const resource = await new BrowserLifecycle(control).request(actor.userId, bud_id, body.revision, body.operation, body.confirmed);
      return reply.code(202).send({ browser_id: resource.id, desired_state: resource.desired_state, revision: resource.revision });
    });
    routes.get(
      "/api/threads/:thread_id/browser-sessions",
      async (request, reply) => {
        const actor = await requireViewer(request, reply);
        if (!actor) return;
        reply.header("Cache-Control", "no-store");
        const threadId = z
          .object({ thread_id: z.string().uuid() })
          .parse(request.params).thread_id;
        if (!(await getAuthorizedThread(actor, threadId)))
          throw new BrowserError("browser_not_found");
        return {
          sessions: await Promise.all((await control.repository.list(actor.userId, threadId)).map(
            async (session) => ({
              ...publicSession(session, control.viewportAvailable(session), control.captureAvailable(session),
                control.historyAvailable(session), control.agentViewportAvailable(session), control.runtimeStatus(session)),
              handoff: await control.repository.pending(actor.userId, session.id),
            }),
          )),
        };
      },
    );
    routes.get("/api/browser/sessions/:session_id", async (request, reply) => {
      const actor = await viewer(request, reply);
      if (!actor) return;
      const id = sessionId(request);
      const session = await control.repository.get(actor.userId, id);
      const { viewer_id } = z.object({ viewer_id: z.string().uuid().optional() }).parse(request.query);
      return {
        can_show_window: control.windowAvailable(session),
        ...publicSession(session, control.viewportAvailable(session), control.captureAvailable(session),
          control.historyAvailable(session), control.agentViewportAvailable(session), control.runtimeStatus(session)),
        ...(viewer_id ? { owns_control: control.ownsControl(actor.userId, id, identity(actor, viewer_id)) } : {}),
        handoff: await control.repository.pending(actor.userId, id),
        can_take_control: control.canTakeControl(session),
      };
    });
    routes.post(
      "/api/browser/sessions/:session_id/control",
      { bodyLimit: 4096 },
      async (request, reply) => {
        const actor = await viewer(request, reply);
        if (!actor) return;
        const body = z
          .object({
            ...bodyBase,
            revision: z.number().int().nonnegative(),
            target_id: id.optional(),
            recovery_ticket: z.string().min(1).max(2048).optional(),
            operation: z.enum([
              "acquire",
              "renew",
              "release",
              "return",
              "close",
              "recover",
              "reopen",
              "show_window",
              "hide_window",
            ]),
          })
          .strict()
          .parse(request.body);
        if (actor.mobile && !scopedBrowserOperation(body.operation)) return reply.code(403).send({error:"browser_scope_denied"});
        const args = [
          actor.userId,
          sessionId(request),
          identity(actor, body.viewer_id),
        ] as const;
        const result =
          body.operation === "show_window" || body.operation === "hide_window"
            ? await control.nativeWindow(...args, body.revision, body.operation === "show_window", body.target_id)
            : body.operation === "recover"
            ? await control.recoverViewer(...args, body.recovery_ticket ?? "")
            : body.operation === "close"
            ? await control.close(
                actor.userId,
                sessionId(request),
                body.revision,
              )
            : body.operation === "acquire" || body.operation === "reopen"
              ? await control.acquire(...args, body.revision, body.operation === "reopen")
              : body.operation === "renew"
                ? await control.renew(...args)
                : body.operation === "release"
                  ? await control.release(...args)
                  : await control.returnToAgent(...args, body.revision);
        return {
          ...("page_recovery" in result ? { page_recovery: result.page_recovery } : {}),
          can_show_window: control.windowAvailable(result),
          ...publicSession(result, control.viewportAvailable(result), control.captureAvailable(result),
            control.historyAvailable(result), control.agentViewportAvailable(result), control.runtimeStatus(result)),
          recovery_ticket: control.recoveryTicket(result, identity(actor, body.viewer_id)),
        };
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
      (socket, request) => viewerHandshake(socket, async (hello) => {
        if (Buffer.byteLength(hello) > 256) throw new Error("size");
        const body = z.object(bodyBase).strict().parse(JSON.parse(hello));
        const actor = await browserActor(request);
        if (!actor || (actor.mobile && actor.mobile.session_id !== sessionId(request)) || !(await alive(actor))) throw new Error("auth");
        await media.attachViewer(
          socket,
          actor.userId,
          sessionId(request),
          identity(actor, body.viewer_id),
          () => alive(actor),
        );
      }),
    );
    // A one-use ticket from the authenticated daemon control carrier authorizes
    // this subordinate connection. No ticket appears in its URL/access log.
    routes.get("/ws/browser-media", { websocket: true }, (socket) =>
      media.attachDaemon(socket),
    );
  });
}
