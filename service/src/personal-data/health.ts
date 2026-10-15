import { createHash } from "node:crypto";
import { and, asc, eq, gte, lte, max, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db, type Database } from "../db/client.js";
import { healthWorkoutTable as workouts, healthSleepSegmentTable as segments,
  healthSampleDeletionTable as deletions, dataEventTable as events } from "../db/schema.js";
import { DataRequestError, isRecord } from "./contracts.js";

export const HEALTH_TYPES = ["health.workout.v2", "health.sleep_segment.v2", "health.sample_deleted.v1"];
/** Health categories an agent grant or app policy may allow. */
export const HEALTH_DATA_TYPES = ["workouts", "sleep"] as const;
export type HealthDataType = typeof HEALTH_DATA_TYPES[number];
const SLEEP_STAGES = ["in_bed", "asleep_unspecified", "awake", "asleep_core", "asleep_deep", "asleep_rem", "unknown"];
const ASLEEP = ["asleep_unspecified", "asleep_core", "asleep_deep", "asleep_rem"];
const DETAILED = ["asleep_core", "asleep_deep", "asleep_rem"];

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type DataEvent = typeof events.$inferSelect;

function timestamp(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
const text = (value: unknown, limit: number) => typeof value === "string" && value.length > 0 && value.length <= limit ? value : null;
const optionalText = (value: unknown, limit: number) => value == null ? null : text(value, limit) ?? undefined;
const optionalNumber = (value: unknown) => value == null ? null : typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Shared identity fields of v2 samples; null when invalid. */
function parseSample(payload: unknown) {
  if (!isRecord(payload)) return null;
  const uuid = text(payload.hk_uuid, 64), start = timestamp(payload.start_at), end = timestamp(payload.end_at);
  const mode = payload.import_mode === "baseline" || payload.import_mode === "incremental" ? payload.import_mode : null;
  const source = isRecord(payload.source) ? payload.source : null;
  const sourceName = text(source?.name, 200), bundle = text(source?.bundle_id, 255);
  const device = payload.device === null ? { name: null, model: null } : isRecord(payload.device)
    ? { name: optionalText(payload.device.name, 200), model: optionalText(payload.device.model, 200) } : null;
  if (!uuid || !start || !end || end < start || !mode || !sourceName || !bundle || !device
    || device.name === undefined || device.model === undefined) return null;
  return { hkUuid: uuid, startAt: start, endAt: end, importMode: mode, sourceName, sourceBundleId: bundle,
    deviceName: device.name, deviceModel: device.model };
}

export function parseHealthPayload(type: string, payload: unknown) {
  if (type === "health.sample_deleted.v1") {
    if (!isRecord(payload)) return null;
    const uuid = text(payload.hk_uuid, 64);
    const kind = payload.sample_kind === "workout" || payload.sample_kind === "sleep_segment" ? payload.sample_kind : null;
    return uuid && kind ? { kind: "deletion" as const, hkUuid: uuid, sampleKind: kind } : null;
  }
  const sample = parseSample(payload);
  if (!sample || !isRecord(payload)) return null;
  if (type === "health.workout.v2") {
    const duration = optionalNumber(payload.duration_s), activity = text(payload.activity_type, 64);
    const raw = payload.activity_type_raw == null ? null : Number.isInteger(payload.activity_type_raw) ? payload.activity_type_raw as number : undefined;
    const energy = optionalNumber(payload.total_energy_kcal), distance = optionalNumber(payload.total_distance_m);
    const indoor = payload.indoor == null ? null : typeof payload.indoor === "boolean" ? payload.indoor : undefined;
    if (duration == null || !activity || raw === undefined || energy === undefined || distance === undefined || indoor === undefined) return null;
    return { kind: "workout" as const, ...sample, durationS: duration, activityType: activity, activityTypeRaw: raw,
      totalEnergyKcal: energy, totalDistanceM: distance, indoor };
  }
  if (type === "health.sleep_segment.v2") {
    const stage = typeof payload.stage === "string" && SLEEP_STAGES.includes(payload.stage) ? payload.stage : null;
    if (!stage || !Number.isInteger(payload.value)) return null;
    return { kind: "sleep_segment" as const, ...sample, stage, value: payload.value as number };
  }
  return null;
}

/** Caller holds the owner lock. Returns false for an invalid payload. Re-imports of a
 * sample update its row; deletions are kept separately so order never matters. */
export async function processHealthEvent(tx: Transaction, owner: string, event: DataEvent) {
  const parsed = parseHealthPayload(event.eventType, event.rawEnvelope.payload);
  if (!parsed) return false;
  if (parsed.kind === "deletion") {
    await tx.insert(deletions).values({ id: ulid(), hkUuid: parsed.hkUuid, sampleKind: parsed.sampleKind,
      rawEventId: event.id, deletedAt: event.occurredAt, createdByUserId: owner }).onConflictDoNothing();
    return true;
  }
  const stored = { rawEventId: event.id, epochId: event.epochId, receivedAt: event.receivedAt };
  // The first import mode is kept: a later re-upload must not turn a baseline sample into a new one.
  if (parsed.kind === "workout") {
    const { kind: _kind, importMode, ...fields } = parsed;
    await tx.insert(workouts).values({ id: ulid(), ...fields, ...stored, importMode, createdByUserId: owner })
      .onConflictDoUpdate({ target: [workouts.createdByUserId, workouts.hkUuid], set: { ...fields, ...stored } });
  } else {
    const { kind: _kind, importMode, ...fields } = parsed;
    await tx.insert(segments).values({ id: ulid(), ...fields, ...stored, importMode, createdByUserId: owner })
      .onConflictDoUpdate({ target: [segments.createdByUserId, segments.hkUuid], set: { ...fields, ...stored } });
  }
  return true;
}

export function healthWindow(query: { from?: string; to?: string }, maxDays: number) {
  const from = timestamp(query.from), to = timestamp(query.to);
  if (!from || !to || from > to || to.getTime() - from.getTime() > maxDays * 86400_000)
    throw new DataRequestError(400, "invalid_time_window", `Provide from/to timestamps spanning at most ${maxDays} days`);
  return { from, to };
}

function localDate(instant: number, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant));
}

export type WorkoutQuery = { from: string; to: string; activity_type?: string; limit?: number; cursor?: string };
export type SleepQuery = { from: string; to: string; timezone?: string };
const notDeleted = (table: typeof workouts | typeof segments) => sql`not exists (select 1 from health_sample_deletion d
  where d.created_by_user_id = ${table.createdByUserId} and d.hk_uuid = ${table.hkUuid})`;

export class HealthQueries {
  constructor(private readonly database: Pick<Database, "select"> = db) {}

  private async lastReceived(owner: string, table: typeof workouts | typeof segments) {
    const [row] = await this.database.select({ at: max(table.receivedAt) }).from(table).where(eq(table.createdByUserId, owner));
    return row?.at ?? null;
  }

  /** Bounded workout list by start time. Empty results are not evidence of no activity. */
  async workouts(owner: string, query: WorkoutQuery, policy?: { cursorBinding: string }) {
    const { from, to } = healthWindow(query, 366);
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new DataRequestError(400, "invalid_limit", "Limit must be 1–200");
    if (query.activity_type !== undefined && !text(query.activity_type, 64))
      throw new DataRequestError(400, "invalid_query", "Invalid activity_type");
    const binding = createHash("sha256").update(JSON.stringify([owner, from.toISOString(), to.toISOString(),
      query.activity_type ?? null, ...(policy ? [policy.cursorBinding] : [])])).digest("hex");
    let cursor: { time: string; id: string } | undefined;
    if (query.cursor) {
      try {
        if (query.cursor.length > 600) throw new Error();
        const parsed = JSON.parse(Buffer.from(query.cursor, "base64url").toString());
        if (parsed.binding !== binding || !timestamp(parsed.time) || typeof parsed.id !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(parsed.id)) throw new Error();
        cursor = parsed;
      } catch { throw new DataRequestError(400, "invalid_cursor", "Cursor does not match this workout query"); }
    }
    const rows = await this.database.select().from(workouts).where(and(eq(workouts.createdByUserId, owner),
      gte(workouts.startAt, from), lte(workouts.startAt, to), notDeleted(workouts),
      query.activity_type ? eq(workouts.activityType, query.activity_type) : undefined,
      cursor ? sql`(${workouts.startAt}, ${workouts.id}) > (${new Date(cursor.time)}, ${cursor.id})` : undefined))
      .orderBy(asc(workouts.startAt), asc(workouts.id)).limit(limit + 1);
    const page = rows.slice(0, limit), last = page.at(-1);
    return { items: page.map(row => ({ id: row.id, hk_uuid: row.hkUuid, start_at: row.startAt, end_at: row.endAt,
        duration_s: row.durationS, activity_type: row.activityType, total_energy_kcal: row.totalEnergyKcal,
        total_distance_m: row.totalDistanceM, indoor: row.indoor, source: { name: row.sourceName, bundle_id: row.sourceBundleId },
        device: row.deviceName || row.deviceModel ? { name: row.deviceName, model: row.deviceModel } : null, received_at: row.receivedAt })),
      next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ binding, time: last.startAt.toISOString(), id: last.id })).toString("base64url") : null,
      coverage: { from: from.toISOString(), to: to.toISOString(), last_received_at: await this.lastReceived(owner, workouts),
        read_access: "unknown", note: "HealthKit hides read denial; no workouts can mean none recorded, no access or not yet synced." } };
  }

  /** Sleep grouped into nights. A night is labeled by the local date 12 hours before
   * each segment's start (a 23:00 Monday bedtime and 02:00 Tuesday both belong to
   * Monday's night). When several sources record a night, the one with stage detail,
   * then the most sleep, is used and the others are listed. */
  async sleep(owner: string, query: SleepQuery) {
    const { from, to } = healthWindow(query, 92);
    const timeZone = query.timezone ?? "UTC";
    try { localDate(0, timeZone); } catch { throw new DataRequestError(400, "invalid_timezone", "Provide an IANA timezone"); }
    const rows = await this.database.select().from(segments).where(and(eq(segments.createdByUserId, owner),
      gte(segments.startAt, from), lte(segments.startAt, to), notDeleted(segments)))
      .orderBy(asc(segments.startAt), asc(segments.id)).limit(20_001);
    if (rows.length > 20_000) throw new DataRequestError(400, "invalid_time_window", "Too many sleep records; request a shorter window");
    const nights = new Map<string, Map<string, typeof rows>>();
    for (const row of rows) {
      const night = localDate(row.startAt.getTime() - 12 * 3600_000, timeZone);
      const sources = nights.get(night) ?? new Map<string, typeof rows>();
      sources.set(row.sourceBundleId, [...sources.get(row.sourceBundleId) ?? [], row]);
      nights.set(night, sources);
    }
    const minutes = (list: typeof rows) => list.reduce((sum, row) => sum + (row.endAt.getTime() - row.startAt.getTime()) / 60_000, 0);
    const items = [...nights.entries()].map(([night, sources]) => {
      const ranked = [...sources.entries()].map(([bundle, list]) => ({ bundle, list,
        detailed: list.some(row => DETAILED.includes(row.stage)), asleep: minutes(list.filter(row => ASLEEP.includes(row.stage))) }))
        .sort((a, b) => Number(b.detailed) - Number(a.detailed) || b.asleep - a.asleep || a.bundle.localeCompare(b.bundle));
      const chosen = ranked[0];
      const stages: Record<string, number> = Object.fromEntries(SLEEP_STAGES
        .map(stage => [stage, Math.round(minutes(chosen.list.filter(row => row.stage === stage)))] as const).filter(([, value]) => value > 0));
      const asleep = chosen.list.filter(row => ASLEEP.includes(row.stage));
      return { night_of: night, asleep_minutes: Math.round(chosen.asleep), in_bed_minutes: Number(stages.in_bed ?? 0), stage_minutes: stages,
        sleep_start: asleep[0]?.startAt ?? null, sleep_end: asleep.length ? new Date(Math.max(...asleep.map(row => row.endAt.getTime()))) : null,
        source: { name: chosen.list[0].sourceName, bundle_id: chosen.bundle },
        other_sources: ranked.slice(1).map(entry => ({ name: entry.list[0].sourceName, bundle_id: entry.bundle })) };
    }).sort((a, b) => a.night_of.localeCompare(b.night_of));
    return { items, timezone: timeZone,
      coverage: { from: from.toISOString(), to: to.toISOString(), last_received_at: await this.lastReceived(owner, segments),
        read_access: "unknown", note: "Nights without records can mean no sleep tracked, no access or not yet synced." } };
  }

  async status(owner: string) {
    return { workouts_last_received_at: await this.lastReceived(owner, workouts),
      sleep_last_received_at: await this.lastReceived(owner, segments) };
  }
}
