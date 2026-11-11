import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { and, eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db as defaultDb, type Database } from "../db/client.js";
import { deviceDiagnosticEntryTable as entries, deviceDiagnosticLaunchTable as launches } from "../db/schema.js";
import { DataRequestError } from "./contracts.js";

/**
 * Device diagnostics (bud-mobile `design/diagnostics-upload.md`): the phone's diagnostics journal,
 * uploaded when the phone's sharing setting is on. The phone's field rules (`LogField`) are
 * enforced again here, so a buggy or modified client can't store content: strings must be tokens,
 * Bud-generated IDs, route templates or timestamps, or they're stored as "invalid".
 */

export const DIAGNOSTICS_FORMAT = "bud.diagnostics.v1";
export const DIAGNOSTICS_LIMITS = {
  compressed_bytes: 256 * 1024,
  decoded_bytes: 4 * 1024 * 1024,
  entries: 1_000,
  fields: 40,
  string_chars: 128,
  /** Entries older than this, or further ahead than `future_ms`, are rejected. */
  past_ms: 30 * 86_400_000,
  future_ms: 86_400_000,
  /** Per installation per UTC day. */
  daily_entries: 100_000,
} as const;

export const LEVELS = ["debug", "info", "notice", "error", "fault"] as const;

const TOKEN = /^[a-z][a-z0-9_.:-]{0,63}$/;
const ROUTE = /^(\/([a-z][a-z0-9_.:-]{0,31}|:id))+$|^\/$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
/** Header and launch descriptors (`iOS 26.1`, `iPhone17,1`, `1.0`): short and plain. */
const DESCRIPTOR = /^[A-Za-z0-9 ._,:()-]{1,64}$/;

export const isToken = (value: string) => TOKEN.test(value);

/** Letters, digits, `-` and `_`, 6–128 characters, with a letter and a digit (UUIDs, ULIDs, hex);
 * `fix:` keys too. The phone's `LogField.isID`. */
export function isId(value: string) {
  const body = value.startsWith("fix:") ? value.slice(4) : value;
  return body.length >= 6 && body.length <= 128 && /^[A-Za-z0-9_-]+$/.test(body) && /[0-9]/.test(body) && /[A-Za-z]/.test(body);
}

/** A field value as the phone's rules allow it, or "invalid". Null (a non-finite double) is dropped. */
export function fieldValue(value: unknown): string | number | boolean | null | undefined {
  if (value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.length > DIAGNOSTICS_LIMITS.string_chars) return "invalid";
  if (isToken(value) || isId(value) || ROUTE.test(value) || TIMESTAMP.test(value)) return value;
  // `.ids`: up to 8 IDs joined with commas.
  const parts = value.split(",");
  if (parts.length > 1 && parts.length <= 8 && parts.every(part => isId(part) || part === "invalid_id")) return value;
  return "invalid";
}

const descriptor = (value: unknown) => typeof value === "string" && DESCRIPTOR.test(value) ? value : null;
const timestamp = (value: unknown) => {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
};

export type DiagnosticsHeader = { journalId: string; appVersion: string | null; build: string | null; os: string | null; device: string | null;
  bundleId: string | null; environment: string | null };
export type DiagnosticsLaunch = { id: string; at: Date; reason: string } & Omit<DiagnosticsHeader, "journalId">;
export type DiagnosticsEntry = { seq: number; launchId: string; at: Date; uptime: number | null; appState: string; area: string;
  level: number; event: string; fields: Record<string, string | number | boolean> };
export type ParsedDiagnostics = { header: DiagnosticsHeader; launches: DiagnosticsLaunch[]; entries: DiagnosticsEntry[];
  rejected: number; maxSeq: number | null };

const unzip = promisify(gunzip);

/** Gzip (or identity) JSON Lines: a header, then launch and entry lines. Bad lines are counted and
 * skipped; a bad header or an oversized batch rejects the request. */
export async function parseDiagnostics(body: Buffer, encoding: string, now = new Date()): Promise<ParsedDiagnostics> {
  if (body.length > DIAGNOSTICS_LIMITS.compressed_bytes) throw new DataRequestError(413, "payload_too_large", "Diagnostics batch exceeds byte limit");
  let decoded: Buffer;
  if (encoding === "gzip") {
    try { decoded = await unzip(body, { maxOutputLength: DIAGNOSTICS_LIMITS.decoded_bytes }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE")
        throw new DataRequestError(413, "payload_too_large", "Decoded diagnostics batch exceeds byte limit");
      throw new DataRequestError(400, "invalid_gzip", "Invalid or truncated gzip batch");
    }
  } else if (encoding === "identity" || encoding === "") decoded = body;
  else throw new DataRequestError(415, "unsupported_encoding", "Use gzip or identity encoding");

  const lines = decoded.toString("utf8").split("\n").map(line => line.trim()).filter(Boolean);
  const rows = lines.map(line => { try { return JSON.parse(line) as unknown; } catch { return undefined; } });
  const first = rows[0] as Record<string, unknown> | undefined;
  if (!first || typeof first !== "object" || first.type !== "header" || first.format !== DIAGNOSTICS_FORMAT
    || typeof first.journal !== "string" || !isId(first.journal))
    throw new DataRequestError(400, "invalid_header", `The first line must be a ${DIAGNOSTICS_FORMAT} header with the journal's ID`);
  const header: DiagnosticsHeader = { journalId: first.journal, appVersion: descriptor(first.app_version), build: descriptor(first.build), os: descriptor(first.os),
    device: descriptor(first.device), bundleId: descriptor(first.bundle_id), environment: descriptor(first.environment) };

  const result: ParsedDiagnostics = { header, launches: [], entries: [], rejected: 0, maxSeq: null };
  const earliest = now.getTime() - DIAGNOSTICS_LIMITS.past_ms, latest = now.getTime() + DIAGNOSTICS_LIMITS.future_ms;
  let entryCount = 0;
  for (const raw of rows.slice(1)) {
    const row = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    if (row?.type === "launch") {
      const at = timestamp(row.at);
      if (typeof row.id !== "string" || !isId(row.id) || !at || typeof row.reason !== "string" || !isToken(row.reason)) { result.rejected++; continue; }
      result.launches.push({ id: row.id, at, reason: row.reason, appVersion: descriptor(row.app_version), build: descriptor(row.build),
        os: descriptor(row.os), device: descriptor(row.device) ?? header.device, bundleId: descriptor(row.bundle_id),
        environment: descriptor(row.environment) });
      continue;
    }
    if (row?.type !== "entry") { result.rejected++; continue; }
    if (++entryCount > DIAGNOSTICS_LIMITS.entries) throw new DataRequestError(413, "payload_too_large", "Too many entries in batch");
    const seq = row.seq;
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) { result.rejected++; continue; }
    result.maxSeq = Math.max(result.maxSeq ?? 0, seq);
    const at = timestamp(row.at);
    const level = LEVELS.indexOf(row.level as typeof LEVELS[number]);
    const fields = row.fields && typeof row.fields === "object" && !Array.isArray(row.fields) ? row.fields as Record<string, unknown> : null;
    if (!at || at.getTime() < earliest || at.getTime() > latest || typeof row.launch !== "string" || !isId(row.launch)
      || typeof row.state !== "string" || !isToken(row.state) || typeof row.area !== "string" || !isToken(row.area)
      || typeof row.event !== "string" || !isToken(row.event) || level < 0 || !fields || Object.keys(fields).length > DIAGNOSTICS_LIMITS.fields) {
      result.rejected++; continue;
    }
    const clean: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (!isToken(key)) continue;
      const checked = fieldValue(value);
      if (checked !== undefined && checked !== null) clean[key] = checked;
    }
    result.entries.push({ seq, launchId: row.launch, at, uptime: typeof row.uptime === "number" && Number.isFinite(row.uptime) ? row.uptime : null,
      appState: row.state, area: row.area, level, event: row.event, fields: clean });
  }
  return result;
}

/** Entries accepted per installation per UTC day, in this process (the service runs one instance). */
export class DailyDiagnosticsBudget {
  private day = "";
  private readonly used = new Map<string, number>();
  constructor(private readonly limit: number = DIAGNOSTICS_LIMITS.daily_entries, private readonly now = () => new Date()) {}
  take(key: string, count: number): boolean {
    const day = this.now().toISOString().slice(0, 10);
    if (day !== this.day) { this.day = day; this.used.clear(); }
    const used = this.used.get(key) ?? 0;
    if (used + count > this.limit) return false;
    this.used.set(key, used + count);
    return true;
  }
}

export class DeviceDiagnostics {
  constructor(private readonly database: Database = defaultDb) {}

  /** Stores launches and entries; retries are idempotent (entries by seq, launches by ID, with a
   * launch's reason filled in when it was `unknown`). Returns how many entries were new. */
  async store(owner: string, installationId: string, batch: ParsedDiagnostics): Promise<number> {
    return this.database.transaction(async tx => {
      if (batch.launches.length) {
        await tx.insert(launches).values(batch.launches.map(launch => ({ createdByUserId: owner, installationId, id: launch.id, at: launch.at,
          reason: launch.reason, appVersion: launch.appVersion, build: launch.build, os: launch.os, device: launch.device,
          bundleId: launch.bundleId, environment: launch.environment })))
          .onConflictDoUpdate({ target: [launches.createdByUserId, launches.installationId, launches.id],
            set: { reason: sql`case when ${launches.reason} = 'unknown' then excluded.reason else ${launches.reason} end` } });
      }
      if (!batch.entries.length) return 0;
      const inserted = await tx.insert(entries).values(batch.entries.map(entry => ({ id: ulid(), createdByUserId: owner, installationId,
        journalId: batch.header.journalId, seq: entry.seq, launchId: entry.launchId, at: entry.at, uptime: entry.uptime, appState: entry.appState, area: entry.area,
        level: entry.level, event: entry.event, fields: entry.fields })))
        .onConflictDoNothing({ target: [entries.createdByUserId, entries.installationId, entries.journalId, entries.seq] }).returning({ id: entries.id });
      return inserted.length;
    });
  }

  /** Deletes an installation's shared diagnostics. */
  async delete(owner: string, installationId: string) {
    return this.database.transaction(async tx => {
      const removed = await tx.delete(entries).where(and(eq(entries.createdByUserId, owner), eq(entries.installationId, installationId)))
        .returning({ id: entries.id });
      await tx.delete(launches).where(and(eq(launches.createdByUserId, owner), eq(launches.installationId, installationId)));
      return removed.length;
    });
  }
}
