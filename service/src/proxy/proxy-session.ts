import { and, desc, eq } from "drizzle-orm";
import { ulid } from "ulid";
import { z } from "zod";
import { config } from "../config.js";
import { db } from "../db/client.js";
import {
  auditEventTable,
  proxySessionTable,
  threadTable,
} from "../db/schema.js";
import type { Viewer } from "../auth/session.js";
import { getActiveGrpcSessionTracker, grpcSessions } from "../transport/grpc-daemon-router.js";
import { getActiveGrpcDataSessionTracker } from "../transport/grpc-data-router.js";

export const LOCALHOST_PROXY_STREAM_TYPE = "localhost_http_proxy";
export const DEFAULT_PROXY_SESSION_TTL_SECONDS = 15 * 60;
export const MIN_PROXY_SESSION_TTL_SECONDS = 60;
export const MAX_PROXY_SESSION_TTL_SECONDS = 60 * 60;
export const DEFAULT_PROXY_ALLOWED_METHODS = ["GET", "HEAD"] as const;
export const PROXY_ALLOWED_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

const proxyMethodSet = new Set<string>(PROXY_ALLOWED_METHODS);

export const CreateProxySessionBodySchema = z.object({
  target_host: z.string().optional().default("127.0.0.1"),
  target_port: z.number().int().min(1).max(65535),
  allowed_methods: z.array(z.string()).optional(),
  ttl_seconds: z
    .number()
    .int()
    .min(MIN_PROXY_SESSION_TTL_SECONDS)
    .max(MAX_PROXY_SESSION_TTL_SECONDS)
    .optional()
    .default(DEFAULT_PROXY_SESSION_TTL_SECONDS),
  thread_id: z.string().uuid().optional(),
  display_metadata: z.record(z.unknown()).optional().default({}),
});

export type CreateProxySessionBody = z.infer<typeof CreateProxySessionBodySchema>;
export type ProxySessionRow = typeof proxySessionTable.$inferSelect;

export type ProxyTransportStatus =
  | {
      available: true;
      code: null;
      message: null;
      deviceSessionId: string;
      controlTransportSessionId: string | null;
      dataTransportSessionId: string | null;
    }
  | {
      available: false;
      code: "GRPC_CONTROL_UNAVAILABLE" | "GRPC_DATA_UNAVAILABLE";
      message: string;
      deviceSessionId: string | null;
      controlTransportSessionId: string | null;
      dataTransportSessionId: string | null;
    };

export class ProxySessionValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ProxySessionValidationError";
  }
}

export function normalizeProxyTargetHost(host: string): string {
  const normalized = host.trim();
  if (normalized !== "127.0.0.1") {
    throw new ProxySessionValidationError(
      "unsupported_proxy_target",
      "Only http://127.0.0.1:<port> proxy targets are allowed",
    );
  }
  return normalized;
}

export function normalizeProxyAllowedMethods(methods?: string[]): string[] {
  const requested = methods && methods.length > 0 ? methods : [...DEFAULT_PROXY_ALLOWED_METHODS];
  const normalized: string[] = [];
  for (const method of requested) {
    const value = method.trim().toUpperCase();
    if (!proxyMethodSet.has(value)) {
      throw new ProxySessionValidationError(
        "unsupported_proxy_method",
        `Proxy method ${method} is not allowed`,
      );
    }
    if (!normalized.includes(value)) {
      normalized.push(value);
    }
  }
  if (normalized.length === 0) {
    throw new ProxySessionValidationError(
      "empty_proxy_methods",
      "At least one proxy method must be allowed",
    );
  }
  if (normalized.includes("GET") && !normalized.includes("HEAD")) {
    normalized.push("HEAD");
  }
  return normalized;
}

export function resolveProxyTransportStatus(budId: string): ProxyTransportStatus {
  const controlTracker = getActiveGrpcSessionTracker(budId, grpcSessions.get(budId) ?? null);
  if (!controlTracker || controlTracker.call.destroyed || controlTracker.finalized) {
    return {
      available: false,
      code: "GRPC_CONTROL_UNAVAILABLE",
      message: "Bud does not have an active authenticated gRPC control stream",
      deviceSessionId: null,
      controlTransportSessionId: null,
      dataTransportSessionId: null,
    };
  }

  const deviceSessionId = controlTracker.deviceSessionId ?? controlTracker.sessionId;
  const dataTracker = getActiveGrpcDataSessionTracker(budId, deviceSessionId);
  if (!dataTracker) {
    return {
      available: false,
      code: "GRPC_DATA_UNAVAILABLE",
      message: "Bud does not have an active HTTP/2 data stream attached",
      deviceSessionId,
      controlTransportSessionId: controlTracker.transportSessionId ?? null,
      dataTransportSessionId: null,
    };
  }
  if (!dataTracker.streams.has(LOCALHOST_PROXY_STREAM_TYPE)) {
    return {
      available: false,
      code: "GRPC_DATA_UNAVAILABLE",
      message: "Bud HTTP/2 data stream has not negotiated localhost proxy support",
      deviceSessionId,
      controlTransportSessionId: controlTracker.transportSessionId ?? null,
      dataTransportSessionId: dataTracker.transportSessionId ?? null,
    };
  }

  return {
    available: true,
    code: null,
    message: null,
    deviceSessionId,
    controlTransportSessionId: controlTracker.transportSessionId ?? null,
    dataTransportSessionId: dataTracker.transportSessionId ?? null,
  };
}

export async function createProxySession(args: {
  viewer: Viewer;
  budId: string;
  body: CreateProxySessionBody;
  transportStatus?: ProxyTransportStatus;
}): Promise<{ session: ProxySessionRow; transportStatus: ProxyTransportStatus }> {
  const targetHost = normalizeProxyTargetHost(args.body.target_host);
  const allowedMethods = normalizeProxyAllowedMethods(args.body.allowed_methods);
  const transportStatus = args.transportStatus ?? resolveProxyTransportStatus(args.budId);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + args.body.ttl_seconds * 1000);
  const proxySessionId = `ps_${ulid()}`;
  const auditCorrelationId = `pc_${ulid()}`;

  const session = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(proxySessionTable)
      .values({
        proxySessionId,
        budId: args.budId,
        threadId: args.body.thread_id ?? undefined,
        targetHost,
        targetPort: args.body.target_port,
        allowedMethods,
        state: transportStatus.available ? "ready" : "unavailable",
        displayMetadata: args.body.display_metadata,
        auditCorrelationId,
        expiresAt,
        createdByUserId: args.viewer.userId,
      })
      .returning();

    await tx.insert(auditEventTable).values({
      auditEventId: `aud_${ulid()}`,
      eventType: "proxy.session_create",
      budId: args.budId,
      userId: args.viewer.userId,
      createdByUserId: args.viewer.userId,
      eventData: {
        proxy_session_id: proxySessionId,
        audit_correlation_id: auditCorrelationId,
        thread_id: args.body.thread_id ?? null,
        target_host: targetHost,
        target_port: args.body.target_port,
        allowed_methods: allowedMethods,
        state: transportStatus.available ? "ready" : "unavailable",
        transport: serializeProxyTransportStatus(transportStatus),
      },
    });

    return row;
  });

  return { session, transportStatus };
}

export async function getAuthorizedProxySession(
  viewer: Viewer,
  proxySessionId: string,
): Promise<ProxySessionRow | null> {
  const [row] = await db
    .select()
    .from(proxySessionTable)
    .where(
      and(
        eq(proxySessionTable.proxySessionId, proxySessionId),
        eq(proxySessionTable.createdByUserId, viewer.userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listAuthorizedProxySessionsForBud(args: {
  viewer: Viewer;
  budId: string;
  limit?: number;
}): Promise<ProxySessionRow[]> {
  return db
    .select()
    .from(proxySessionTable)
    .where(
      and(
        eq(proxySessionTable.budId, args.budId),
        eq(proxySessionTable.createdByUserId, args.viewer.userId),
      ),
    )
    .orderBy(desc(proxySessionTable.createdAt))
    .limit(args.limit ?? 50);
}

export async function revokeAuthorizedProxySession(args: {
  viewer: Viewer;
  proxySessionId: string;
  reason?: string;
}): Promise<ProxySessionRow | null> {
  const existing = await getAuthorizedProxySession(args.viewer, args.proxySessionId);
  if (!existing) {
    return null;
  }
  if (existing.revokedAt) {
    return existing;
  }

  const now = new Date();
  const [row] = await db
    .update(proxySessionTable)
    .set({
      state: "revoked",
      revokedAt: now,
      revokedByUserId: args.viewer.userId,
      revokeReason: args.reason ?? "user_requested",
      updatedAt: now,
    })
    .where(
      and(
        eq(proxySessionTable.proxySessionId, args.proxySessionId),
        eq(proxySessionTable.createdByUserId, args.viewer.userId),
      ),
    )
    .returning();

  await db.insert(auditEventTable).values({
    auditEventId: `aud_${ulid()}`,
    eventType: "proxy.session_revoke",
    budId: existing.budId,
    userId: args.viewer.userId,
    createdByUserId: args.viewer.userId,
    eventData: {
      proxy_session_id: args.proxySessionId,
      audit_correlation_id: existing.auditCorrelationId,
      reason: args.reason ?? "user_requested",
    },
  });

  return row ?? existing;
}

export async function getAuthorizedThreadForProxySession(args: {
  viewer: Viewer;
  threadId: string;
  budId: string;
}): Promise<typeof threadTable.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(threadTable)
    .where(
      and(
        eq(threadTable.threadId, args.threadId),
        eq(threadTable.budId, args.budId),
        eq(threadTable.createdByUserId, args.viewer.userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export function serializeProxySession(
  session: ProxySessionRow,
  transportStatus?: ProxyTransportStatus,
): Record<string, unknown> {
  const degraded = transportStatus?.available === false
    ? {
        available: false,
        code: transportStatus.code,
        message: transportStatus.message,
      }
    : null;

  return {
    proxy_session_id: session.proxySessionId,
    bud_id: session.budId,
    thread_id: session.threadId,
    operation_id: session.operationId,
    active_stream_id: session.activeStreamId,
    target: {
      host: session.targetHost,
      port: session.targetPort,
      url: `http://${session.targetHost}:${session.targetPort}`,
    },
    allowed_methods: session.allowedMethods,
    state: effectiveProxySessionState(session),
    proxy_url: proxySessionUrl(session.proxySessionId),
    expires_at: session.expiresAt.toISOString(),
    revoked_at: session.revokedAt?.toISOString() ?? null,
    audit_correlation_id: session.auditCorrelationId,
    transport: transportStatus ? serializeProxyTransportStatus(transportStatus) : null,
    degraded,
    created_at: session.createdAt.toISOString(),
    updated_at: session.updatedAt.toISOString(),
  };
}

export function serializeProxyTransportStatus(status: ProxyTransportStatus): Record<string, unknown> {
  return {
    available: status.available,
    code: status.code,
    message: status.message,
    device_session_id: status.deviceSessionId,
    control_transport_session_id: status.controlTransportSessionId,
    data_transport_session_id: status.dataTransportSessionId,
  };
}

export function effectiveProxySessionState(session: ProxySessionRow): ProxySessionRow["state"] {
  if (session.revokedAt) {
    return "revoked";
  }
  if (session.expiresAt.getTime() <= Date.now()) {
    return "expired";
  }
  return session.state;
}

export function proxySessionUrl(proxySessionId: string): string {
  return new URL(`/api/proxy/${proxySessionId}/`, config.appBaseUrl).toString();
}

export function methodAllowedForProxySession(session: ProxySessionRow, method: string): boolean {
  const normalized = method.toUpperCase();
  return session.allowedMethods.includes(normalized);
}
