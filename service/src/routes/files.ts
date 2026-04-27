import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAuthorizedBud, requireViewer } from "../auth/session.js";
import { openFileEdgeStream } from "../files/file-edge.js";
import {
  CreateFileSessionBodySchema,
  FileSessionValidationError,
  createFileSession,
  effectiveFileSessionState,
  filePermissionAllowedForSession,
  getAuthorizedFileSession,
  getAuthorizedThreadForFileSession,
  listAuthorizedFileSessionsForBud,
  resolveFileTransportStatus,
  revokeAuthorizedFileSession,
  serializeFileSession,
  serializeFileTransportStatus,
  type FileSessionPermission,
} from "../files/file-session.js";

const BudFileParamsSchema = z.object({
  budId: z.string().min(1),
});

const FileSessionParamsSchema = z.object({
  fileSessionId: z.string().min(1),
});

const RevokeFileSessionBodySchema = z.object({
  reason: z.string().trim().min(1).max(200).optional(),
});

export async function registerFileRoutes(server: FastifyInstance): Promise<void> {
  server.post("/api/buds/:budId/file-sessions", async (request, reply) => {
    const viewer = await requireViewer(request, reply);
    if (!viewer) {
      return;
    }

    const params = BudFileParamsSchema.parse(request.params);
    if (!(await getAuthorizedBud(viewer, params.budId))) {
      return reply.status(404).send({ error: "bud_not_found" });
    }

    const bodyResult = CreateFileSessionBodySchema.safeParse(request.body ?? {});
    if (!bodyResult.success) {
      return reply.status(400).send({
        error: "invalid_file_session_request",
        message: bodyResult.error.issues[0]?.message ?? "Invalid file session request",
      });
    }

    if (bodyResult.data.thread_id) {
      const thread = await getAuthorizedThreadForFileSession({
        viewer,
        threadId: bodyResult.data.thread_id,
        budId: params.budId,
      });
      if (!thread) {
        return reply.status(404).send({ error: "thread_not_found" });
      }
    }

    try {
      const result = await createFileSession({
        viewer,
        budId: params.budId,
        body: bodyResult.data,
      });
      return reply.status(201).send(serializeFileSession(result.session, result.transportStatus));
    } catch (err) {
      if (err instanceof FileSessionValidationError) {
        return reply.status(400).send({
          error: err.code,
          message: err.message,
        });
      }
      throw err;
    }
  });

  server.get("/api/buds/:budId/file-sessions", async (request, reply) => {
    const viewer = await requireViewer(request, reply);
    if (!viewer) {
      return;
    }

    const params = BudFileParamsSchema.parse(request.params);
    if (!(await getAuthorizedBud(viewer, params.budId))) {
      return reply.status(404).send({ error: "bud_not_found" });
    }

    const transportStatus = resolveFileTransportStatus(params.budId);
    const sessions = await listAuthorizedFileSessionsForBud({
      viewer,
      budId: params.budId,
    });

    return {
      file_sessions: sessions.map((session) => serializeFileSession(session, transportStatus)),
      transport: serializeFileTransportStatus(transportStatus),
    };
  });

  server.get("/api/file-sessions/:fileSessionId", async (request, reply) => {
    const viewer = await requireViewer(request, reply);
    if (!viewer) {
      return;
    }

    const params = FileSessionParamsSchema.parse(request.params);
    const session = await getAuthorizedFileSession(viewer, params.fileSessionId);
    if (!session) {
      return reply.status(404).send({ error: "file_session_not_found" });
    }

    return serializeFileSession(session, resolveFileTransportStatus(session.budId));
  });

  server.delete("/api/file-sessions/:fileSessionId", async (request, reply) => {
    const viewer = await requireViewer(request, reply);
    if (!viewer) {
      return;
    }

    const params = FileSessionParamsSchema.parse(request.params);
    const bodyResult = RevokeFileSessionBodySchema.safeParse(request.body ?? {});
    if (!bodyResult.success) {
      return reply.status(400).send({ error: "invalid_revoke_request" });
    }

    const session = await revokeAuthorizedFileSession({
      viewer,
      fileSessionId: params.fileSessionId,
      reason: bodyResult.data.reason,
    });
    if (!session) {
      return reply.status(404).send({ error: "file_session_not_found" });
    }

    return serializeFileSession(session, resolveFileTransportStatus(session.budId));
  });

  server.route({
    method: ["GET", "HEAD"],
    url: "/api/files/:fileSessionId",
    async handler(request, reply) {
      const viewer = await requireViewer(request, reply);
      if (!viewer) {
        return;
      }

      const params = FileSessionParamsSchema.parse(request.params);
      const session = await getAuthorizedFileSession(viewer, params.fileSessionId);
      if (!session) {
        return reply.status(404).send({ error: "file_session_not_found" });
      }

      const requiredPermission: FileSessionPermission =
        request.method === "HEAD" ? "stat" : request.headers.range ? "range" : "read";
      if (!filePermissionAllowedForSession(session, requiredPermission)) {
        return reply.status(403).send({
          error: "file_permission_denied",
          required_permission: requiredPermission,
          permissions: session.permissions,
        });
      }

      const state = effectiveFileSessionState(session);
      if (state === "expired") {
        return reply.status(410).send({ error: "file_session_expired" });
      }
      if (state === "revoked") {
        return reply.status(410).send({ error: "file_session_revoked" });
      }

      const transportStatus = resolveFileTransportStatus(session.budId);
      if (!transportStatus.available || state === "unavailable") {
        return reply.status(424).send({
          error: transportStatus.code ?? "FILE_TRANSPORT_UNAVAILABLE",
          message: transportStatus.message ?? "File session is not currently usable",
          transport: serializeFileTransportStatus(transportStatus),
        });
      }

      return openFileEdgeStream({
        viewer,
        session,
        transportStatus,
        request,
        reply,
        requiredPermission,
      });
    },
  });
}
