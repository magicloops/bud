import { and, desc, eq } from "drizzle-orm";
import { ulid } from "ulid";
import { z } from "zod";
import { config } from "../config.js";
import { db } from "../db/client.js";
import {
  auditEventTable,
  fileSessionTable,
  threadTable,
} from "../db/schema.js";
import type { Viewer } from "../auth/session.js";
import { getActiveGrpcSessionTracker, grpcSessions } from "../transport/grpc-daemon-router.js";
import { getActiveGrpcDataSessionTracker } from "../transport/grpc-data-router.js";

export const FILE_READ_STREAM_TYPE = "file_read";
export const DEFAULT_FILE_SESSION_TTL_SECONDS = 15 * 60;
export const MIN_FILE_SESSION_TTL_SECONDS = 60;
export const MAX_FILE_SESSION_TTL_SECONDS = 60 * 60;
export const DEFAULT_FILE_SESSION_MAX_BYTES = 64 * 1024 * 1024;
export const MAX_FILE_SESSION_MAX_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_FILE_ROOT_KEY = "workspace";
export const FILE_SESSION_ROOT_KEYS = ["workspace"] as const;
export const FILE_SESSION_PERMISSIONS = ["stat", "read", "range"] as const;

const fileRootKeySet = new Set<string>(FILE_SESSION_ROOT_KEYS);
const filePermissionSet = new Set<string>(FILE_SESSION_PERMISSIONS);

export const CreateFileSessionBodySchema = z.object({
  root_key: z.string().optional().default(DEFAULT_FILE_ROOT_KEY),
  relative_path: z.string().min(1).max(4096),
  permissions: z.array(z.string()).optional(),
  max_bytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_FILE_SESSION_MAX_BYTES)
    .optional()
    .default(DEFAULT_FILE_SESSION_MAX_BYTES),
  ttl_seconds: z
    .number()
    .int()
    .min(MIN_FILE_SESSION_TTL_SECONDS)
    .max(MAX_FILE_SESSION_TTL_SECONDS)
    .optional()
    .default(DEFAULT_FILE_SESSION_TTL_SECONDS),
  thread_id: z.string().uuid().optional(),
  display_metadata: z.record(z.unknown()).optional().default({}),
});

export type CreateFileSessionBody = z.infer<typeof CreateFileSessionBodySchema>;
export type FileSessionRow = typeof fileSessionTable.$inferSelect;
export type FileSessionPermission = (typeof FILE_SESSION_PERMISSIONS)[number];

export type FileTransportStatus =
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

export class FileSessionValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "FileSessionValidationError";
  }
}

export function normalizeFileRootKey(rootKey: string): string {
  const normalized = rootKey.trim();
  if (!fileRootKeySet.has(normalized)) {
    throw new FileSessionValidationError(
      "unsupported_file_root",
      "Only the workspace file root is allowed in this phase",
    );
  }
  return normalized;
}

export function normalizeFileRelativePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new FileSessionValidationError("empty_file_path", "File path must not be empty");
  }
  if (trimmed.includes("\0")) {
    throw new FileSessionValidationError("invalid_file_path", "File path must not contain NUL bytes");
  }
  if (trimmed.startsWith("/") || trimmed.startsWith("~")) {
    throw new FileSessionValidationError("absolute_file_path", "File path must be root-relative");
  }
  if (/^[a-zA-Z]:/.test(trimmed) || trimmed.includes("\\")) {
    throw new FileSessionValidationError(
      "invalid_file_path",
      "File path must use POSIX-style relative separators",
    );
  }

  const parts: string[] = [];
  for (const part of trimmed.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      throw new FileSessionValidationError(
        "file_path_traversal",
        "File path must not contain parent-directory segments",
      );
    }
    parts.push(part);
  }

  if (parts.length === 0) {
    throw new FileSessionValidationError("empty_file_path", "File path must not be empty");
  }

  return parts.join("/");
}

export function normalizeFileSessionPermissions(permissions?: string[]): FileSessionPermission[] {
  const requested = permissions && permissions.length > 0 ? permissions : [...FILE_SESSION_PERMISSIONS];
  const normalized: FileSessionPermission[] = [];

  for (const permission of requested) {
    const value = permission.trim().toLowerCase();
    if (!filePermissionSet.has(value)) {
      throw new FileSessionValidationError(
        "unsupported_file_permission",
        `File permission ${permission} is not allowed`,
      );
    }
    if (!normalized.includes(value as FileSessionPermission)) {
      normalized.push(value as FileSessionPermission);
    }
  }

  if (normalized.length === 0) {
    throw new FileSessionValidationError(
      "empty_file_permissions",
      "At least one file permission must be allowed",
    );
  }

  if (normalized.includes("range") && !normalized.includes("read")) {
    normalized.push("read");
  }
  if ((normalized.includes("read") || normalized.includes("range")) && !normalized.includes("stat")) {
    normalized.push("stat");
  }

  return normalized;
}

export function resolveFileTransportStatus(budId: string): FileTransportStatus {
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
  if (!dataTracker.streams.has(FILE_READ_STREAM_TYPE)) {
    return {
      available: false,
      code: "GRPC_DATA_UNAVAILABLE",
      message: "Bud HTTP/2 data stream has not negotiated file-read support",
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

export async function createFileSession(args: {
  viewer: Viewer;
  budId: string;
  body: CreateFileSessionBody;
  transportStatus?: FileTransportStatus;
}): Promise<{ session: FileSessionRow; transportStatus: FileTransportStatus }> {
  const rootKey = normalizeFileRootKey(args.body.root_key);
  const relativePath = normalizeFileRelativePath(args.body.relative_path);
  const permissions = normalizeFileSessionPermissions(args.body.permissions);
  const transportStatus = args.transportStatus ?? resolveFileTransportStatus(args.budId);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + args.body.ttl_seconds * 1000);
  const fileSessionId = `fs_${ulid()}`;
  const auditCorrelationId = `fc_${ulid()}`;

  const session = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(fileSessionTable)
      .values({
        fileSessionId,
        budId: args.budId,
        threadId: args.body.thread_id ?? undefined,
        rootKey,
        relativePath,
        permissions,
        maxBytes: args.body.max_bytes,
        state: transportStatus.available ? "ready" : "unavailable",
        displayMetadata: args.body.display_metadata,
        auditCorrelationId,
        expiresAt,
        createdByUserId: args.viewer.userId,
      })
      .returning();

    await tx.insert(auditEventTable).values({
      auditEventId: `aud_${ulid()}`,
      eventType: "file.session_create",
      budId: args.budId,
      userId: args.viewer.userId,
      createdByUserId: args.viewer.userId,
      eventData: {
        file_session_id: fileSessionId,
        audit_correlation_id: auditCorrelationId,
        thread_id: args.body.thread_id ?? null,
        root_key: rootKey,
        relative_path: relativePath,
        permissions,
        max_bytes: args.body.max_bytes,
        state: transportStatus.available ? "ready" : "unavailable",
        transport: serializeFileTransportStatus(transportStatus),
      },
    });

    return row;
  });

  return { session, transportStatus };
}

export async function getAuthorizedFileSession(
  viewer: Viewer,
  fileSessionId: string,
): Promise<FileSessionRow | null> {
  const [row] = await db
    .select()
    .from(fileSessionTable)
    .where(
      and(
        eq(fileSessionTable.fileSessionId, fileSessionId),
        eq(fileSessionTable.createdByUserId, viewer.userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listAuthorizedFileSessionsForBud(args: {
  viewer: Viewer;
  budId: string;
  limit?: number;
}): Promise<FileSessionRow[]> {
  return db
    .select()
    .from(fileSessionTable)
    .where(
      and(
        eq(fileSessionTable.budId, args.budId),
        eq(fileSessionTable.createdByUserId, args.viewer.userId),
      ),
    )
    .orderBy(desc(fileSessionTable.createdAt))
    .limit(args.limit ?? 50);
}

export async function revokeAuthorizedFileSession(args: {
  viewer: Viewer;
  fileSessionId: string;
  reason?: string;
}): Promise<FileSessionRow | null> {
  const existing = await getAuthorizedFileSession(args.viewer, args.fileSessionId);
  if (!existing) {
    return null;
  }
  if (existing.revokedAt) {
    return existing;
  }

  const now = new Date();
  const [row] = await db
    .update(fileSessionTable)
    .set({
      state: "revoked",
      revokedAt: now,
      revokedByUserId: args.viewer.userId,
      revokeReason: args.reason ?? "user_requested",
      updatedAt: now,
    })
    .where(
      and(
        eq(fileSessionTable.fileSessionId, args.fileSessionId),
        eq(fileSessionTable.createdByUserId, args.viewer.userId),
      ),
    )
    .returning();

  await db.insert(auditEventTable).values({
    auditEventId: `aud_${ulid()}`,
    eventType: "file.session_revoke",
    budId: existing.budId,
    userId: args.viewer.userId,
    createdByUserId: args.viewer.userId,
    eventData: {
      file_session_id: args.fileSessionId,
      audit_correlation_id: existing.auditCorrelationId,
      reason: args.reason ?? "user_requested",
    },
  });

  return row ?? existing;
}

export async function getAuthorizedThreadForFileSession(args: {
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

export function serializeFileSession(
  session: FileSessionRow,
  transportStatus?: FileTransportStatus,
): Record<string, unknown> {
  const degraded = transportStatus?.available === false
    ? {
        available: false,
        code: transportStatus.code,
        message: transportStatus.message,
      }
    : null;

  return {
    file_session_id: session.fileSessionId,
    bud_id: session.budId,
    thread_id: session.threadId,
    operation_id: session.operationId,
    active_stream_id: session.activeStreamId,
    root: {
      key: session.rootKey,
    },
    path: {
      relative_path: session.relativePath,
    },
    permissions: session.permissions,
    state: effectiveFileSessionState(session),
    file_url: fileSessionUrl(session.fileSessionId),
    max_bytes: session.maxBytes,
    content_identity: session.contentIdentity ?? null,
    expires_at: session.expiresAt.toISOString(),
    revoked_at: session.revokedAt?.toISOString() ?? null,
    audit_correlation_id: session.auditCorrelationId,
    display_metadata: session.displayMetadata,
    transport: transportStatus ? serializeFileTransportStatus(transportStatus) : null,
    degraded,
    created_at: session.createdAt.toISOString(),
    updated_at: session.updatedAt.toISOString(),
  };
}

export function serializeFileTransportStatus(status: FileTransportStatus): Record<string, unknown> {
  return {
    available: status.available,
    code: status.code,
    message: status.message,
    device_session_id: status.deviceSessionId,
    control_transport_session_id: status.controlTransportSessionId,
    data_transport_session_id: status.dataTransportSessionId,
  };
}

export function effectiveFileSessionState(session: FileSessionRow): FileSessionRow["state"] {
  if (session.revokedAt) {
    return "revoked";
  }
  if (session.expiresAt.getTime() <= Date.now()) {
    return "expired";
  }
  return session.state;
}

export function fileSessionUrl(fileSessionId: string): string {
  return new URL(`/api/files/${fileSessionId}`, config.appBaseUrl).toString();
}

export function filePermissionAllowedForSession(
  session: FileSessionRow,
  permission: FileSessionPermission,
): boolean {
  return session.permissions.includes(permission);
}
