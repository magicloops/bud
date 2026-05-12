import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";
import { z } from "zod";
import { PROTO_VERSION } from "../config.js";
import { db } from "../db/client.js";
import { budTable } from "../db/schema.js";
import { daemonTransportRouter } from "../transport/composite-daemon-router.js";
import { EnvelopeSchema } from "../ws/protocol.js";
import { DEFAULT_FILE_ROOT_KEY, VIEWER_FILE_SESSION_MAX_BYTES } from "./file-session.js";

export const FILE_RESOLVE_TIMEOUT_MS = 15_000;

const FileResolveErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean().optional(),
  details: z.record(z.unknown()).optional(),
});

const FileResolveResultSchema = EnvelopeSchema.extend({
  type: z.literal("file_resolve_result"),
  operation_id: z.string(),
  accepted: z.boolean(),
  root_key: z.string().optional(),
  requested_path_kind: z.string().optional(),
  resolved_against: z.string().optional(),
  resolved_relative_path: z.string().optional(),
  content_identity: z.record(z.unknown()).optional(),
  size: z.number().int().nonnegative().optional(),
  error: FileResolveErrorSchema.optional(),
});

export type FileResolveResultFrame = z.infer<typeof FileResolveResultSchema>;
export type FileResolveError = z.infer<typeof FileResolveErrorSchema>;

type PendingFileResolve = {
  resolve: (frame: FileResolveResultFrame) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const pendingFileResolves = new Map<string, PendingFileResolve>();

export function buildFileResolveControlFrame(args: {
  operationId: string;
  requestedPath: string;
  maxBytes?: number;
}): Record<string, unknown> {
  return {
    proto: PROTO_VERSION,
    type: "file_resolve",
    id: `msg_${ulid()}`,
    ts: Date.now(),
    ext: {},
    operation_id: args.operationId,
    root_key: DEFAULT_FILE_ROOT_KEY,
    requested_path: args.requestedPath,
    requested_path_kind: "absolute_posix",
    max_bytes: args.maxBytes ?? VIEWER_FILE_SESSION_MAX_BYTES,
  };
}

export function waitForFileResolveResult(
  operationId: string,
  timeoutMs = FILE_RESOLVE_TIMEOUT_MS,
): Promise<FileResolveResultFrame> {
  clearPendingFileResolve(operationId);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingFileResolves.delete(operationId);
      reject(new Error("file resolve timed out"));
    }, timeoutMs);
    pendingFileResolves.set(operationId, { resolve, reject, timeout });
  });
}

export function clearPendingFileResolve(operationId: string): void {
  const pending = pendingFileResolves.get(operationId);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timeout);
  pendingFileResolves.delete(operationId);
}

export function handleFileResolveResult(raw: unknown): FileResolveResultFrame | null {
  const result = FileResolveResultSchema.safeParse(raw);
  if (!result.success) {
    return null;
  }
  const pending = pendingFileResolves.get(result.data.operation_id);
  if (pending) {
    clearTimeout(pending.timeout);
    pendingFileResolves.delete(result.data.operation_id);
    pending.resolve(result.data);
  }
  return result.data;
}

export function daemonSupportsAbsoluteFileResolve(capabilities: unknown): boolean {
  if (!isRecord(capabilities)) {
    return false;
  }
  const files = capabilities.files;
  if (!isRecord(files)) {
    return false;
  }
  const resolve = files.resolve;
  return isRecord(resolve) && resolve.absolute_posix === true;
}

export async function authorizedBudSupportsAbsoluteFileResolve(args: {
  budId: string;
  viewerUserId: string;
}): Promise<boolean> {
  const bud = await db.query.budTable.findFirst({
    where: and(
      eq(budTable.budId, args.budId),
      eq(budTable.createdByUserId, args.viewerUserId),
    ),
  });
  return daemonSupportsAbsoluteFileResolve(bud?.capabilities);
}

export async function sendFileResolveRequest(args: {
  budId: string;
  operationId: string;
  requestedPath: string;
  maxBytes?: number;
  timeoutMs?: number;
}): Promise<FileResolveResultFrame> {
  const pending = waitForFileResolveResult(args.operationId, args.timeoutMs);
  let sent: boolean;
  try {
    sent = daemonTransportRouter.sendFrameToBud(
      args.budId,
      buildFileResolveControlFrame({
        operationId: args.operationId,
        requestedPath: args.requestedPath,
        maxBytes: args.maxBytes,
      }),
    );
  } catch (err) {
    clearPendingFileResolve(args.operationId);
    throw err;
  }
  if (!sent) {
    clearPendingFileResolve(args.operationId);
    throw new Error("file resolve unavailable");
  }
  return pending;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
