import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, gte, lt, lte, max, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db, type Database } from "../db/client.js";
import { healthWorkoutTable as workouts, healthSleepSegmentTable as segments,
  healthSampleDeletionTable as deletions, dataEventTable as events } from "../db/schema.js";
import { DataRequestError, isRecord } from "./contracts.js";
import { localTimeToInstant } from "./automation-schedule.js";

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

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
/** Local calendar date (YYYY-MM-DD); formatters are reused per zone. */
function localDate(instant: number, timeZone: string) {
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    dateFormatters.set(timeZone, formatter);
  }
  return formatter.format(new Date(instant));
}

/** Local noon of a calendar date: night D runs from noon on D to noon on D + 1. */
function localNoon(date: string, timeZone: string, addDays = 0) {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + addDays));
  return localTimeToInstant(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate(), 12, 0, timeZone);
}

/** When samples overlap, the most specific stage wins for that time. */
const STAGE_PRECEDENCE = ["asleep_deep", "asleep_rem", "asleep_core", "awake", "asleep_unspecified", "in_bed", "unknown"];
export const SLEEP_SELECTION_RULE = "Per night, the source with the most sleep is used; among sources within 10% of that, "
  + "one with sleep stages is preferred. Overlapping samples within a source are merged, with the most specific stage winning.";

type Interval = { start: number; end: number; stage: string };
/** Sweep over boundaries so every instant is counted once, under its winning stage. */
function summarizeIntervals(intervals: Interval[]) {
  const points = [...new Set(intervals.flatMap(row => [row.start, row.end]))].sort((a, b) => a - b);
  const minutes: Record<string, number> = {};
  let sleepStart: number | null = null, sleepEnd: number | null = null;
  for (let index = 0; index + 1 < points.length; index++) {
    const [from, to] = [points[index], points[index + 1]];
    const active = intervals.filter(row => row.start <= from && row.end >= to).map(row => row.stage);
    const stage = STAGE_PRECEDENCE.find(candidate => active.includes(candidate));
    if (!stage) continue;
    minutes[stage] = (minutes[stage] ?? 0) + (to - from) / 60_000;
    if (ASLEEP.includes(stage)) { sleepStart ??= from; sleepEnd = to; }
  }
  const asleep = ASLEEP.reduce((sum, stage) => sum + (minutes[stage] ?? 0), 0);
  return { minutes, asleep, sleepStart, sleepEnd, hasStages: DETAILED.some(stage => minutes[stage]) };
}

export type WorkoutQuery = { from: string; to: string; activity_type?: string; order?: string; limit?: number; cursor?: string };
export type SleepQuery = { from: string; to: string; timezone?: string };
const notDeleted = (table: typeof workouts | typeof segments) => sql`not exists (select 1 from health_sample_deletion d
  where d.created_by_user_id = ${table.createdByUserId} and d.hk_uuid = ${table.hkUuid})`;

export class HealthQueries {
  constructor(private readonly database: Pick<Database, "select"> = db, private readonly now: () => Date = () => new Date()) {}

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
    if (query.order !== undefined && query.order !== "asc" && query.order !== "desc")
      throw new DataRequestError(400, "invalid_query", "order must be asc or desc");
    const descending = query.order === "desc";
    const binding = createHash("sha256").update(JSON.stringify([owner, from.toISOString(), to.toISOString(),
      query.activity_type ?? null, descending, ...(policy ? [policy.cursorBinding] : [])])).digest("hex");
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
      cursor ? descending ? sql`(${workouts.startAt}, ${workouts.id}) < (${new Date(cursor.time)}, ${cursor.id})`
        : sql`(${workouts.startAt}, ${workouts.id}) > (${new Date(cursor.time)}, ${cursor.id})` : undefined))
      .orderBy(...descending ? [desc(workouts.startAt), desc(workouts.id)] : [asc(workouts.startAt), asc(workouts.id)]).limit(limit + 1);
    const page = rows.slice(0, limit), last = page.at(-1);
    return { items: page.map(row => ({ id: row.id, hk_uuid: row.hkUuid, start_at: row.startAt, end_at: row.endAt,
        duration_s: row.durationS, activity_type: row.activityType, total_energy_kcal: row.totalEnergyKcal,
        total_distance_m: row.totalDistanceM, indoor: row.indoor, source: { name: row.sourceName, bundle_id: row.sourceBundleId },
        device: row.deviceName || row.deviceModel ? { name: row.deviceName, model: row.deviceModel } : null, received_at: row.receivedAt })),
      next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ binding, time: last.startAt.toISOString(), id: last.id })).toString("base64url") : null,
      coverage: { from: from.toISOString(), to: to.toISOString(), last_received_at: await this.lastReceived(owner, workouts),
        read_access: "unknown", note: "HealthKit hides read denial; no workouts can mean none recorded, no access or not yet synced." } };
  }

  /** Complete nights for every local date from `from` to `to`, where night D runs from
   * noon on D to noon on D + 1 in `timezone`. Segments overlapping a night are clipped
   * to it. A night is partial when the approved history (`notBefore`) cuts it, or when
   * it has not ended yet. Within one source, overlapping samples are merged. Several
   * sources for one night follow SLEEP_SELECTION_RULE, and every source's totals are listed. */
  async sleep(owner: string, query: SleepQuery, limits: { notBefore?: Date } = {}) {
    const { from, to } = healthWindow(query, 92);
    const timeZone = query.timezone ?? "UTC";
    try { localDate(0, timeZone); } catch { throw new DataRequestError(400, "invalid_timezone", "Provide an IANA timezone"); }
    const first = localDate(from.getTime(), timeZone), last = localDate(to.getTime(), timeZone);
    const nights: { date: string; start: number; end: number }[] = [];
    for (let day = 0; nights.at(-1)?.date !== last && day <= 93; day++) {
      const start = localNoon(first, timeZone, day), end = localNoon(first, timeZone, day + 1);
      nights.push({ date: localDate(start.getTime(), timeZone), start: start.getTime(), end: end.getTime() });
    }
    const notBefore = limits.notBefore?.getTime() ?? Number.NEGATIVE_INFINITY;
    const windowStart = Math.max(nights[0].start, notBefore), windowEnd = nights.at(-1)!.end;
    // Segments longer than a day are not expected; the lower bound keeps the start-time index usable.
    const rows = await this.database.select().from(segments).where(and(eq(segments.createdByUserId, owner),
      gte(segments.startAt, new Date(windowStart - 86400_000)), lt(segments.startAt, new Date(windowEnd)),
      gt(segments.endAt, new Date(windowStart)), notDeleted(segments)))
      .orderBy(asc(segments.startAt), asc(segments.id)).limit(20_001);
    if (rows.length > 20_000) throw new DataRequestError(400, "invalid_time_window", "Too many sleep records; request a shorter window");
    const now = this.now().getTime();
    const items = [], empty: string[] = [];
    for (const night of nights) {
      const start = Math.max(night.start, notBefore);
      const bySource = new Map<string, { name: string; intervals: Interval[] }>();
      for (const row of rows) {
        const clippedStart = Math.max(row.startAt.getTime(), start), clippedEnd = Math.min(row.endAt.getTime(), night.end);
        if (clippedEnd <= clippedStart) continue;
        const entry = bySource.get(row.sourceBundleId) ?? { name: row.sourceName, intervals: [] };
        entry.intervals.push({ start: clippedStart, end: clippedEnd, stage: row.stage });
        bySource.set(row.sourceBundleId, entry);
      }
      if (!bySource.size) { empty.push(night.date); continue; }
      const sources = [...bySource.entries()].map(([bundle, entry]) => ({ bundle, name: entry.name, ...summarizeIntervals(entry.intervals) }));
      const top = Math.max(...sources.map(source => source.asleep));
      const chosen = [...sources].sort((a, b) => Number(b.asleep >= top * 0.9) - Number(a.asleep >= top * 0.9)
        || Number(b.hasStages) - Number(a.hasStages) || b.asleep - a.asleep || a.bundle.localeCompare(b.bundle))[0];
      const partial = [...(notBefore > night.start ? ["before_history_limit"] : []), ...(night.end > now ? ["in_progress"] : [])];
      items.push({ night_of: night.date, window: { start: new Date(night.start), end: new Date(night.end) },
        complete: !partial.length, partial_reasons: partial,
        asleep_minutes: Math.round(chosen.asleep), in_bed_minutes: Math.round(chosen.minutes.in_bed ?? 0),
        stage_minutes: Object.fromEntries(Object.entries(chosen.minutes).map(([stage, value]) => [stage, Math.round(value)]).filter(([, value]) => Number(value) > 0)),
        sleep_start: chosen.sleepStart === null ? null : new Date(chosen.sleepStart),
        sleep_end: chosen.sleepEnd === null ? null : new Date(chosen.sleepEnd),
        source: { name: chosen.name, bundle_id: chosen.bundle },
        other_sources: sources.filter(source => source !== chosen).map(source => ({ name: source.name, bundle_id: source.bundle })),
        sources: [chosen, ...sources.filter(source => source !== chosen).sort((a, b) => b.asleep - a.asleep || a.bundle.localeCompare(b.bundle))]
          .map(source => ({ name: source.name, bundle_id: source.bundle, asleep_minutes: Math.round(source.asleep),
          has_stages: source.hasStages, selected: source === chosen })) });
    }
    return { items, nights_without_records: empty, timezone: timeZone, selection_rule: SLEEP_SELECTION_RULE,
      coverage: { first_night: nights[0].date, last_night: nights.at(-1)!.date, last_received_at: await this.lastReceived(owner, segments),
        read_access: "unknown", note: "Nights without records can mean no sleep tracked, no access or not yet synced." } };
  }

  async status(owner: string) {
    return { workouts_last_received_at: await this.lastReceived(owner, workouts),
      sleep_last_received_at: await this.lastReceived(owner, segments) };
  }
}
