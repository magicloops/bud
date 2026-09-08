import { createHash } from "node:crypto";

export const INGEST_LIMITS = {
  compressed_bytes: 5 * 1024 * 1024,
  decoded_bytes: 25 * 1024 * 1024,
  line_bytes: 256 * 1024,
  events: 500,
} as const;

export class DataRequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly retryAfterSeconds = 0,
  ) { super(message); }
}

export type RejectedEvent = {
  line: number;
  event_id?: string;
  code: string;
  message: string;
  retryable: boolean;
};
export type IngestContext = { userId: string; installationId: string; collectionEpoch: string; batchId: string };
export type ValidEvent = {
  line: number;
  eventId: string;
  eventType: string;
  schemaVersion: number;
  occurredAt: Date;
  recordedAt: Date;
  envelope: Record<string, unknown>;
  payloadHash: string;
  byteLength: number;
};
export type ParsedBatch = { events: ValidEvent[]; rejected: RejectedEvent[] };
export type BatchResult = {
  accepted_count: number;
  duplicate_count: number;
  acked_event_ids: string[];
  rejected: RejectedEvent[];
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200
    && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
}

// Hash semantic JSON, independent of object key ordering. Reject excessive depth
// and values PostgreSQL JSONB cannot represent before attempting a transaction.
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 64) throw new Error("JSON nesting exceeds limit");
  if (typeof value === "string") {
    if (/[\u0000\ud800-\udfff]/u.test(value)) throw new Error("Invalid JSON string");
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v, depth + 1)).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((k) =>
    `${canonicalJson(k, depth + 1)}:${canonicalJson(value[k], depth + 1)}`).join(",")}}`;
  throw new Error("Invalid JSON value");
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

export function validateEvent(value: unknown, line: number, context: IngestContext): ValidEvent | RejectedEvent {
  const eventId = isRecord(value) && validIdentifier(value.event_id) ? value.event_id : undefined;
  const reject = (code: string, message: string): RejectedEvent => ({ line, event_id: eventId, code, message, retryable: false });
  if (!isRecord(value) || !eventId) return reject("invalid_event_id", "A bounded event_id is required");
  if (!Number.isSafeInteger(value.schema_version) || Number(value.schema_version) < 1)
    return reject("invalid_schema_version", "schema_version must be a positive integer");
  if (!validIdentifier(value.event_type)) return reject("invalid_event_type", "A bounded event_type is required");
  if (!validTimestamp(value.occurred_at) || !validTimestamp(value.recorded_at))
    return reject("invalid_timestamp", "Event timestamps must be ISO-8601 timestamps with a timezone");
  if (!isRecord(value.actor) || value.actor.installation_id !== context.installationId)
    return reject("installation_id_mismatch", "actor.installation_id must match X-Installation-Id");
  if (value.actor.user_id != null && value.actor.user_id !== context.userId)
    return reject("actor_mismatch", "actor.user_id must match the authenticated owner");
  if ((value.collection_epoch ?? "legacy") !== context.collectionEpoch)
    return reject("collection_epoch_mismatch", "collection_epoch must match X-Collection-Epoch");
  if (!isRecord(value.payload)) return reject("invalid_payload", "payload must be an object");
  let canonical: string;
  try { canonical = canonicalJson(value); }
  catch { return reject("invalid_json_value", "Event contains unsupported JSON values or nesting"); }
  return {
    line, eventId, eventType: value.event_type, schemaVersion: Number(value.schema_version),
    occurredAt: new Date(value.occurred_at), recordedAt: new Date(value.recorded_at), envelope: value,
    payloadHash: createHash("sha256").update(canonical).digest("hex"), byteLength: Buffer.byteLength(canonical),
  };
}
