import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { authUserTable, dataEventTable, deviceDiagnosticEntryTable as entries, deviceDiagnosticLaunchTable as launches } from "../db/schema.js";
import { localTimeToInstant } from "./automation-schedule.js";
import { phoneTimeZone } from "./automation-trigger-text.js";
import { LEVELS } from "./diagnostics.js";

/**
 * Reading uploaded device diagnostics (`pnpm db:diagnostics`): the same timeline, errors and
 * summary as bud-mobile's `scripts/bud-diagnostics`, from the database, plus a batch's story
 * on both sides. Read-only. Times are shown in the phone's time zone.
 */

export type ReportEntry = { seq: number; launchId: string; at: Date; appState: string; area: string; level: number; event: string;
  fields: Record<string, unknown> };
export type ReportLaunch = { id: string; at: Date; reason: string; build: string | null; appVersion: string | null };

const GAP_MS = 60_000;

export function clock(at: Date, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit",
    second: "2-digit" }).formatToParts(at).map(part => [part.type, part.value]));
  return `${parts.hour}:${parts.minute}:${parts.second}.${String(at.getUTCMilliseconds()).padStart(3, "0")}`;
}

export function day(at: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

const fieldsText = (fields: Record<string, unknown>) => Object.entries(fields).map(([key, value]) => `${key}=${value}`).join(" ");
const duration = (ms: number) => {
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

export function entryLine(entry: ReportEntry, timeZone: string) {
  return `${clock(entry.at, timeZone)} ${LEVELS[entry.level].padEnd(6)} ${entry.appState.slice(0, 2)} ${entry.area.padEnd(18)} ${entry.event} ${fieldsText(entry.fields)}`.trimEnd();
}

function launchLine(id: string, known: Map<string, ReportLaunch>, timeZone: string) {
  const launch = known.get(id);
  if (!launch) return `── launch ${id.slice(0, 8)}`;
  return `── launch ${id.slice(0, 8)} at ${day(launch.at, timeZone)} ${clock(launch.at, timeZone).slice(0, 8)} reason=${launch.reason} build=${launch.build ?? "?"}`;
}

/** Entries grouped by launch, with gaps over a minute marked. */
export function timeline(rows: ReportEntry[], known: ReportLaunch[], timeZone: string) {
  const byId = new Map(known.map(launch => [launch.id, launch]));
  const out: string[] = [];
  let previous: ReportEntry | null = null;
  for (const entry of rows) {
    if (!previous || previous.launchId !== entry.launchId) out.push(launchLine(entry.launchId, byId, timeZone));
    else if (entry.at.getTime() - previous.at.getTime() > GAP_MS) out.push(`   … ${duration(entry.at.getTime() - previous.at.getTime())} with nothing logged`);
    out.push(entryLine(entry, timeZone));
    previous = entry;
  }
  return out.length ? out.join("\n") : "No entries.";
}

/** Each error and fault with the entries just before it in the same launch. */
export function errors(rows: ReportEntry[], known: ReportLaunch[], timeZone: string, context = 5) {
  const byId = new Map(known.map(launch => [launch.id, launch]));
  const out: string[] = [];
  rows.forEach((entry, index) => {
    if (entry.level < 3) return;
    out.push(launchLine(entry.launchId, byId, timeZone));
    for (const earlier of rows.slice(Math.max(0, index - context), index)) if (earlier.launchId === entry.launchId) out.push("   " + entryLine(earlier, timeZone));
    out.push(" ▶ " + entryLine(entry, timeZone), "");
  });
  return out.length ? out.join("\n").trimEnd() : "No errors or faults.";
}

/** Launches by reason, entries by level and area, and the longest gaps within a launch. */
export function summary(rows: ReportEntry[], known: ReportLaunch[], timeZone: string) {
  const count = <T>(values: T[]) => [...values.reduce((map, value) => map.set(value, (map.get(value) ?? 0) + 1), new Map<T, number>())];
  const out = [`${rows.length} entries, ${known.length} launches`,
    "launches by reason: " + count(known.map(launch => launch.reason)).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", "),
    "entries by level:   " + count(rows.map(entry => entry.level)).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${LEVELS[k]}=${v}`).join(", "),
    "entries by area:    " + count(rows.map(entry => entry.area)).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ")];
  const gaps = rows.slice(1).map((entry, index) => [entry.at.getTime() - rows[index].at.getTime(), rows[index], entry] as const)
    .filter(([, earlier, later]) => earlier.launchId === later.launchId).sort((a, b) => b[0] - a[0]).slice(0, 5);
  if (gaps.length) {
    out.push("", "longest gaps within a launch (suspensions):");
    for (const [ms, earlier, later] of gaps)
      out.push(`  ${duration(ms).padStart(9)}  ${clock(earlier.at, timeZone).slice(0, 8)} ${earlier.event} → ${clock(later.at, timeZone).slice(0, 8)} ${later.event}`);
  }
  return out.join("\n");
}

export class DiagnosticsReport {
  constructor(private readonly database: Database) {}

  /** A user ID, or an email address. */
  async owner(value: string) {
    if (!value.includes("@")) return value;
    const [row] = await this.database.select({ id: authUserTable.id }).from(authUserTable)
      .where(sql`lower(${authUserTable.email}) = lower(${value})`).limit(1);
    if (!row) throw new Error(`No user with email ${value}`);
    return row.id;
  }

  /** The installation that uploaded most recently. */
  async latestInstallation(owner: string) {
    const [row] = await this.database.select({ installationId: entries.installationId }).from(entries)
      .where(eq(entries.createdByUserId, owner)).orderBy(desc(entries.receivedAt)).limit(1);
    return row?.installationId ?? null;
  }

  async timeZone(owner: string) { return await phoneTimeZone(this.database, owner, new Date()) ?? "UTC"; }

  /** `HH:MM` (today, or the latest entry's day) and `YYYY-MM-DD HH:MM` in the phone's time zone, or ISO. */
  parseTime(text: string, timeZone: string, reference: Date) {
    const local = /^(?:(\d{4})-(\d{2})-(\d{2})[ T])?(\d{1,2}):(\d{2})$/.exec(text.trim());
    if (!local) {
      const date = new Date(text);
      if (!Number.isFinite(date.getTime())) throw new Error(`Can't read the time ${text}`);
      return date;
    }
    const [y, m, d] = local[1] ? [Number(local[1]), Number(local[2]), Number(local[3])] : day(reference, timeZone).split("-").map(Number);
    return localTimeToInstant(y, m, d, Number(local[4]), Number(local[5]), timeZone);
  }

  async entries(owner: string, installationId: string, query: { from?: Date; to?: Date; area?: string; minimumLevel?: number; batch?: string }) {
    const rows = await this.database.select().from(entries).where(and(eq(entries.createdByUserId, owner), eq(entries.installationId, installationId),
      query.from ? gte(entries.at, query.from) : undefined, query.to ? lte(entries.at, query.to) : undefined,
      query.area ? sql`(${entries.area} = ${query.area} or ${entries.area} like ${query.area + ".%"})` : undefined,
      query.minimumLevel ? gte(entries.level, query.minimumLevel) : undefined,
      query.batch ? sql`(${entries.fields} @> ${JSON.stringify({ batch: query.batch })}::jsonb
        or ${entries.fields}->>'batches' like ${"%" + query.batch + "%"})` : undefined))
      .orderBy(entries.at, entries.seq).limit(20_000);
    return rows.map(row => ({ seq: row.seq, launchId: row.launchId, at: row.at, appState: row.appState, area: row.area, level: row.level,
      event: row.event, fields: row.fields as Record<string, unknown> }));
  }

  async launches(owner: string, installationId: string, ids?: string[]) {
    const rows = await this.database.select().from(launches).where(and(eq(launches.createdByUserId, owner), eq(launches.installationId, installationId)))
      .orderBy(launches.at);
    const wanted = ids ? new Set(ids) : null;
    return rows.filter(row => !wanted || wanted.has(row.id))
      .map(row => ({ id: row.id, at: row.at, reason: row.reason, build: row.build, appVersion: row.appVersion }));
  }

  /** What the service stored for a batch: events by type and when they arrived. */
  async serviceBatch(owner: string, batchId: string) {
    return (await this.database.select({ eventType: dataEventTable.eventType, count: sql<number>`count(*)::int`,
      first: sql<Date>`min(${dataEventTable.receivedAt})`, last: sql<Date>`max(${dataEventTable.receivedAt})` })
      .from(dataEventTable).where(and(eq(dataEventTable.createdByUserId, owner), eq(dataEventTable.batchId, batchId)))
      .groupBy(dataEventTable.eventType)).map(row => ({ ...row, first: new Date(row.first), last: new Date(row.last) }));
  }
}
