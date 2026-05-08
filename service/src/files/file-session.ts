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
import {
  serializeCarrierHealth,
  serializeCarrierSelectionCandidate,
  type CarrierHealth,
  type CarrierSelectionCandidate,
} from "../transport/carrier-health.js";
import {
  selectDataPlaneCarrier,
  type DataPlaneTransportKind,
  type DataPlaneUnavailableCode,
} from "../transport/data-plane-router.js";

export const FILE_READ_STREAM_TYPE = "file_read";
export const DEFAULT_FILE_SESSION_TTL_SECONDS = 15 * 60;
export const MIN_FILE_SESSION_TTL_SECONDS = 60;
export const MAX_FILE_SESSION_TTL_SECONDS = 60 * 60;
export const MAX_FILE_SESSION_MAX_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_FILE_SESSION_MAX_BYTES = Math.min(
  config.fileSessionDefaultMaxBytes,
  MAX_FILE_SESSION_MAX_BYTES,
);
export const VIEWER_FILE_SESSION_MAX_BYTES = 1024 * 1024;
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
      transportKind: DataPlaneTransportKind;
      health: CarrierHealth;
      selectionReason: string;
      candidateTransports: CarrierSelectionCandidate[];
    }
  | {
      available: false;
      code: DataPlaneUnavailableCode;
      message: string;
      deviceSessionId: string | null;
      controlTransportSessionId: string | null;
      dataTransportSessionId: string | null;
      transportKind: DataPlaneTransportKind | null;
      health: CarrierHealth | null;
      selectionReason: string;
      candidateTransports: CarrierSelectionCandidate[];
    };

export class FileSessionValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "FileSessionValidationError";
  }
}

export type ParsedViewerFilePath = {
  rawPath: string;
  relativePath: string;
  line?: number;
  column?: number;
};

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

export function parseViewerFilePath(
  input: string,
  options: { line?: number; column?: number } = {},
): ParsedViewerFilePath {
  const rawPath = input.trim();
  if (!rawPath) {
    throw new FileSessionValidationError("empty_file_path", "File path must not be empty");
  }
  if (rawPath.includes("\0")) {
    throw new FileSessionValidationError("invalid_file_path", "File path must not contain NUL bytes");
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawPath) || /^mailto:/i.test(rawPath)) {
    throw new FileSessionValidationError("invalid_file_path", "URLs are not supported file paths");
  }
  if (/^[a-zA-Z]:([/\\]|$)/.test(rawPath)) {
    throw new FileSessionValidationError(
      "invalid_file_path",
      "File path must use POSIX-style relative separators",
    );
  }

  let candidatePath = rawPath;
  let parsedLine: number | undefined;
  let parsedColumn: number | undefined;

  const hashLineMatch = /^(?<path>.+?)#L(?<line>\d+)(?:-L?\d+)?$/i.exec(candidatePath);
  if (hashLineMatch?.groups) {
    candidatePath = hashLineMatch.groups.path;
    parsedLine = parsePositiveInteger(hashLineMatch.groups.line, "line");
  } else {
    const colonLineColumnMatch = /^(?<path>.+):(?<line>\d+):(?<column>\d+)$/.exec(candidatePath);
    const colonLineMatch = /^(?<path>.+):(?<line>\d+)$/.exec(candidatePath);
    const match = colonLineColumnMatch ?? colonLineMatch;
    if (match?.groups) {
      candidatePath = match.groups.path;
      parsedLine = parsePositiveInteger(match.groups.line, "line");
      if (match.groups.column) {
        parsedColumn = parsePositiveInteger(match.groups.column, "column");
      }
    }
  }

  if (candidatePath.trim().endsWith("/")) {
    throw new FileSessionValidationError("invalid_file_path", "Directory paths are not supported");
  }

  const relativePath = normalizeFileRelativePath(candidatePath);
  const explicitLine = options.line !== undefined ? validatePositiveInteger(options.line, "line") : undefined;
  const explicitColumn =
    options.column !== undefined ? validatePositiveInteger(options.column, "column") : undefined;
  const line = explicitLine ?? parsedLine;
  const column = explicitColumn ?? parsedColumn;

  return {
    rawPath,
    relativePath,
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  };
}

function parsePositiveInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new FileSessionValidationError("invalid_file_path", `File ${label} must be a positive integer`);
  }
  return validatePositiveInteger(Number(value), label);
}

function validatePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new FileSessionValidationError("invalid_file_path", `File ${label} must be a positive integer`);
  }
  return value;
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
  const carrier = selectDataPlaneCarrier({
    budId,
    streamType: FILE_READ_STREAM_TYPE,
  });

  if (carrier.available) {
    return {
      available: true,
      code: null,
      message: null,
      deviceSessionId: carrier.deviceSessionId,
      controlTransportSessionId: carrier.controlTransportSessionId,
      dataTransportSessionId: carrier.dataTransportSessionId,
      transportKind: carrier.transportKind,
      health: carrier.health,
      selectionReason: carrier.selectionReason,
      candidateTransports: carrier.candidateTransports,
    };
  }

  return {
    available: false,
    code: carrier.code,
    message: carrier.message,
    deviceSessionId: carrier.deviceSessionId,
    controlTransportSessionId: carrier.controlTransportSessionId,
    dataTransportSessionId: carrier.dataTransportSessionId,
    transportKind: carrier.transportKind,
    health: carrier.health,
    selectionReason: carrier.selectionReason,
    candidateTransports: carrier.candidateTransports,
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
      raw_path:
        typeof session.displayMetadata?.raw_path === "string"
          ? session.displayMetadata.raw_path
          : null,
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
    transport_kind: status.transportKind,
    health: serializeCarrierHealth(status.health),
    selection_reason: status.selectionReason,
    candidate_transports: status.candidateTransports.map(serializeCarrierSelectionCandidate),
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
