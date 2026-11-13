import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getAuthorizedBud, getAuthorizedThread, requireViewer, type Viewer } from "../auth/session.js";
import { config } from "../config.js";
import { GoogleCallbackError, googleConnections, type GoogleConnections } from "./connections.js";
import { googleApprovals, serializeGoogleApproval, type GoogleApprovals } from "./approvals.js";
import { googleConfigured, googleWritesEnabled, GoogleError, GOOGLE_SERVICES } from "./config.js";

function failure(reply: FastifyReply, error: unknown) {
  const code = error instanceof GoogleError ? error.code : error instanceof z.ZodError ? "google_invalid_request" : "google_connection_failed";
  return reply.code(code === "google_not_found" ? 404 : code === "google_invalid_request" ? 400 : 409).send({ error: code });
}
async function returnThread(actor: Viewer, threadId: string) {
  const thread = await getAuthorizedThread(actor, threadId);
  if (!thread || !await getAuthorizedBud(actor, thread.budId)) return null;
  return { threadId: thread.threadId, budId: thread.budId };
}
export async function registerGoogleRoutes(server: FastifyInstance, manager: GoogleConnections = googleConnections,
  resolveViewer = requireViewer, configured = googleConfigured, resolveReturnThread = returnThread, approvals: GoogleApprovals = googleApprovals): Promise<void> {
  async function viewer(request: FastifyRequest, reply: FastifyReply, mutation = false) {
    reply.header("Cache-Control", "no-store"); reply.header("Referrer-Policy", "no-referrer");
    const actor = await resolveViewer(request, reply);
    if (actor && mutation && actor.authType === "cookie" &&
      (!request.headers.origin || !config.betterAuthTrustedOrigins.includes(request.headers.origin))) {
      reply.code(403).send({ error: "google_origin_denied" }); return null;
    }
    return actor;
  }
  server.get("/api/google/connection", async (request, reply) => {
    const actor = await viewer(request, reply); if (!actor) return;
    try { return { configured: configured(), writes_enabled: googleWritesEnabled(), connections: configured() ? await manager.list(actor.userId) : [] }; }
    catch (error) { return failure(reply, error); }
  });
  server.post("/api/google/connect", { bodyLimit: 1024 }, async (request, reply) => {
    const actor = await viewer(request, reply, true); if (!actor) return;
    if (!actor.sessionId || actor.authType !== "cookie") return reply.code(400).send({ error: "google_browser_session_required" });
    try {
      const body = z.object({ thread_id: z.string().min(1).max(80).optional(),
        selections: z.array(z.object({ service: z.enum(GOOGLE_SERVICES), access: z.enum(["read_only", "read_write"]) }).strict())
          .min(1).max(GOOGLE_SERVICES.length).refine(items => new Set(items.map(item => item.service)).size === items.length)
          .default([{ service: "calendar", access: "read_write" }]),
      }).strict().parse(request.body ?? {});
      if (body.thread_id && !await resolveReturnThread(actor, body.thread_id)) throw new GoogleError("google_not_found");
      return { authorization_url: await manager.begin(actor.userId, actor.sessionId, body.thread_id, body.selections) };
    }
    catch (error) { return failure(reply, error); }
  });
  server.patch("/api/google/connection/:connection_id/policy", { bodyLimit: 1024 }, async (request, reply) => {
    const actor = await viewer(request, reply, true); if (!actor) return;
    try {
      const { connection_id } = z.object({ connection_id: z.string().min(1).max(80) }).parse(request.params);
      const body = z.object({ service: z.enum(GOOGLE_SERVICES), policy: z.enum(["read_only", "ask_before_write"]) }).strict().parse(request.body);
      await manager.setPolicy(actor.userId, connection_id, body.service, body.policy);
      return reply.code(204).send();
    } catch (error) { return failure(reply, error); }
  });
  server.get("/api/google/approvals/:approval_id", async (request, reply) => {
    const actor = await viewer(request, reply); if (!actor) return;
    try {
      const { approval_id } = z.object({ approval_id: z.string().min(1).max(80) }).parse(request.params);
      return { approval: serializeGoogleApproval(await approvals.get(actor.userId, approval_id)) };
    } catch (error) { return failure(reply, error); }
  });
  server.post("/api/google/approvals/:approval_id/decision", { bodyLimit: 1024 }, async (request, reply) => {
    const actor = await viewer(request, reply, true); if (!actor) return;
    try {
      const { approval_id } = z.object({ approval_id: z.string().min(1).max(80) }).parse(request.params);
      const { decision } = z.object({ decision: z.enum(["approved", "rejected"]) }).strict().parse(request.body);
      const approval = await approvals.get(actor.userId, approval_id);
      const context = decision === "approved" ? await manager.writeContext(actor.userId, approval.connection_id, approval.service) : undefined;
      return { approval: serializeGoogleApproval(await approvals.decide(actor.userId, approval_id, decision, context)) };
    } catch (error) { return failure(reply, error); }
  });
  server.get("/api/google/callback", async (request, reply) => {
    const actor = await viewer(request, reply); if (!actor) return;
    const target = new URL("/settings", manager.config.redirectUri);
    let returnThreadId: string | undefined;
    try {
      if (!actor.sessionId || actor.authType !== "cookie") throw new GoogleError("google_browser_session_required");
      const values = z.object({ state: z.string().min(1).max(128), code: z.string().max(4096).optional(), error: z.string().max(128).optional() }).parse(request.query);
      const params = new URLSearchParams();
      for (const [name, value] of Object.entries(values)) if (value !== undefined) params.set(name, value);
      returnThreadId = await manager.finish(actor.userId, actor.sessionId, params); target.searchParams.set("google", "connected");
    } catch (error) {
      if (error instanceof GoogleCallbackError) returnThreadId = error.returnThreadId;
      target.searchParams.set("google", error instanceof GoogleError && error.code === "google_calendar_permissions_required" ? "permissions_required" : "failed");
    }
    if (returnThreadId) {
      const thread = await resolveReturnThread(actor, returnThreadId);
      if (thread) target.pathname = `/${encodeURIComponent(thread.budId)}/${encodeURIComponent(thread.threadId)}`;
    }
    return reply.redirect(303, target.href);
  });
  server.delete("/api/google/connection/:connection_id", async (request, reply) => {
    const actor = await viewer(request, reply, true); if (!actor) return;
    try {
      const { connection_id } = z.object({ connection_id: z.string().max(80) }).parse(request.params);
      await manager.disconnect(actor.userId, connection_id); return reply.code(204).send();
    } catch (error) { return failure(reply, error); }
  });
}
