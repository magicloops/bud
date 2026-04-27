import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAuthorizedBud, requireViewer } from "../auth/session.js";
import {
  CreateProxySessionBodySchema,
  ProxySessionValidationError,
  createProxySession,
  effectiveProxySessionState,
  getAuthorizedProxySession,
  getAuthorizedThreadForProxySession,
  listAuthorizedProxySessionsForBud,
  methodAllowedForProxySession,
  resolveProxyTransportStatus,
  revokeAuthorizedProxySession,
  serializeProxySession,
  serializeProxyTransportStatus,
} from "../proxy/proxy-session.js";
import { openProxyEdgeStream } from "../proxy/proxy-edge.js";

const BudProxyParamsSchema = z.object({
  budId: z.string().min(1),
});

const ProxySessionParamsSchema = z.object({
  proxySessionId: z.string().min(1),
});

const RevokeProxySessionBodySchema = z.object({
  reason: z.string().trim().min(1).max(200).optional(),
});

export async function registerProxyRoutes(server: FastifyInstance): Promise<void> {
  server.post("/api/buds/:budId/proxy-sessions", async (request, reply) => {
    const viewer = await requireViewer(request, reply);
    if (!viewer) {
      return;
    }

    const params = BudProxyParamsSchema.parse(request.params);
    if (!(await getAuthorizedBud(viewer, params.budId))) {
      return reply.status(404).send({ error: "bud_not_found" });
    }

    const bodyResult = CreateProxySessionBodySchema.safeParse(request.body ?? {});
    if (!bodyResult.success) {
      return reply.status(400).send({
        error: "invalid_proxy_session_request",
        message: bodyResult.error.issues[0]?.message ?? "Invalid proxy session request",
      });
    }

    if (bodyResult.data.thread_id) {
      const thread = await getAuthorizedThreadForProxySession({
        viewer,
        threadId: bodyResult.data.thread_id,
        budId: params.budId,
      });
      if (!thread) {
        return reply.status(404).send({ error: "thread_not_found" });
      }
    }

    try {
      const result = await createProxySession({
        viewer,
        budId: params.budId,
        body: bodyResult.data,
      });
      return reply.status(201).send(serializeProxySession(result.session, result.transportStatus));
    } catch (err) {
      if (err instanceof ProxySessionValidationError) {
        return reply.status(400).send({
          error: err.code,
          message: err.message,
        });
      }
      throw err;
    }
  });

  server.get("/api/buds/:budId/proxy-sessions", async (request, reply) => {
    const viewer = await requireViewer(request, reply);
    if (!viewer) {
      return;
    }

    const params = BudProxyParamsSchema.parse(request.params);
    if (!(await getAuthorizedBud(viewer, params.budId))) {
      return reply.status(404).send({ error: "bud_not_found" });
    }

    const transportStatus = resolveProxyTransportStatus(params.budId);
    const sessions = await listAuthorizedProxySessionsForBud({
      viewer,
      budId: params.budId,
    });

    return {
      proxy_sessions: sessions.map((session) => serializeProxySession(session, transportStatus)),
      transport: serializeProxyTransportStatus(transportStatus),
    };
  });

  server.get("/api/proxy-sessions/:proxySessionId", async (request, reply) => {
    const viewer = await requireViewer(request, reply);
    if (!viewer) {
      return;
    }

    const params = ProxySessionParamsSchema.parse(request.params);
    const session = await getAuthorizedProxySession(viewer, params.proxySessionId);
    if (!session) {
      return reply.status(404).send({ error: "proxy_session_not_found" });
    }

    return serializeProxySession(session, resolveProxyTransportStatus(session.budId));
  });

  server.delete("/api/proxy-sessions/:proxySessionId", async (request, reply) => {
    const viewer = await requireViewer(request, reply);
    if (!viewer) {
      return;
    }

    const params = ProxySessionParamsSchema.parse(request.params);
    const bodyResult = RevokeProxySessionBodySchema.safeParse(request.body ?? {});
    if (!bodyResult.success) {
      return reply.status(400).send({ error: "invalid_revoke_request" });
    }

    const session = await revokeAuthorizedProxySession({
      viewer,
      proxySessionId: params.proxySessionId,
      reason: bodyResult.data.reason,
    });
    if (!session) {
      return reply.status(404).send({ error: "proxy_session_not_found" });
    }

    return serializeProxySession(session, resolveProxyTransportStatus(session.budId));
  });

  server.route({
    method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    url: "/api/proxy/:proxySessionId/*",
    async handler(request, reply) {
      const viewer = await requireViewer(request, reply);
      if (!viewer) {
        return;
      }

      const params = ProxySessionParamsSchema.parse(request.params);
      const session = await getAuthorizedProxySession(viewer, params.proxySessionId);
      if (!session) {
        return reply.status(404).send({ error: "proxy_session_not_found" });
      }

      if (!methodAllowedForProxySession(session, request.method)) {
        reply.header("Allow", session.allowedMethods.join(", "));
        return reply.status(405).send({
          error: "proxy_method_not_allowed",
          allowed_methods: session.allowedMethods,
        });
      }

      const state = effectiveProxySessionState(session);
      if (state === "expired") {
        return reply.status(410).send({ error: "proxy_session_expired" });
      }
      if (state === "revoked") {
        return reply.status(410).send({ error: "proxy_session_revoked" });
      }

      const transportStatus = resolveProxyTransportStatus(session.budId);
      if (!transportStatus.available || state === "unavailable") {
        return reply.status(424).send({
          error: transportStatus.code ?? "PROXY_TRANSPORT_UNAVAILABLE",
          message: transportStatus.message ?? "Proxy session is not currently usable",
          transport: serializeProxyTransportStatus(transportStatus),
        });
      }

      return openProxyEdgeStream({
        viewer,
        session,
        transportStatus,
        request,
        reply,
      });
    },
  });
}
