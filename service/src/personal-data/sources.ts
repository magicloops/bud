import { and, eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { z } from "zod";
import { db, type Database } from "../db/client.js";
import { contactTable as contacts, dataAccessRequestTable as accessRequests, dataAppKeyTable as appKeys,
  dataInstallationSourceStateTable as states, dataInstallationTable as installations,
  dataSourceSettingHistoryTable as history, dataSourceSettingTable as settings, healthSleepSegmentTable as sleep,
  healthWorkoutTable as workouts, locationObservationTable as observations, locationVisitTable as visits } from "../db/schema.js";
import { DataRequestError, validIdentifier } from "./contracts.js";
import { DataGrants, type DataScope } from "./grants.js";

/**
 * A data source (bud-mobile `plan/data-sources-ux`): what a phone collects under one switch.
 * Each maps to one read scope and to the event types it uploads.
 */
export const SOURCES = [
  { id: "location", scope: "location.read", eventPrefix: "location.", label: "Location" },
  { id: "health", scope: "health.read", eventPrefix: "health.", label: "Health" },
  { id: "contacts", scope: "contacts.read", eventPrefix: "contacts.", label: "Contacts" },
] as const;
export type SourceId = typeof SOURCES[number]["id"];
export const SOURCE_IDS = SOURCES.map(source => source.id) as SourceId[];

/** The source an uploaded event belongs to; null for types outside every source. */
export function sourceOfEventType(eventType: string): SourceId | null {
  return SOURCES.find(source => eventType.startsWith(source.eventPrefix))?.id ?? null;
}

export function sourcesOfScopes(scopes: readonly string[]): SourceId[] {
  return SOURCES.filter(source => scopes.includes(source.scope)).map(source => source.id);
}

const PERMISSIONS = ["not_asked", "granted", "denied", "restricted", "unknowable"] as const;
const timestamp = z.string().max(40).refine(value => Number.isFinite(Date.parse(value)));
const sourceState = z.object({
  permission: z.enum(PERMISSIONS),
  level: z.enum(["while_using", "always"]).optional(),
  caveats: z.array(z.enum(["reduced_accuracy", "limited"])).max(4).optional(),
  asked_at: timestamp.optional(),
}).strict();
const stateReport = z.object({
  reported_at: timestamp,
  sources: z.object({ location: sourceState.optional(), health: sourceState.optional(), contacts: sourceState.optional() }).strict(),
}).strict();
const switchChange = z.object({ enabled: z.boolean() }).strict();

type Reader = Pick<Database, "select">;

export class DataSources {
  constructor(private readonly database: Omit<Database, "$client"> = db,
    private readonly grants: Pick<DataGrants, "get"> = new DataGrants(database)) {}

  /** The sources that are on. No row means off. */
  async enabled(owner: string, database: Reader = this.database): Promise<Set<SourceId>> {
    const rows = await database.select({ source: settings.source }).from(settings)
      .where(and(eq(settings.createdByUserId, owner), eq(settings.enabled, true)));
    return new Set(rows.map(row => row.source as SourceId));
  }

  /** Refuses a read of a source that is off: the agent's and apps' shared gate. */
  async requireOn(owner: string, scopes: readonly DataScope[]): Promise<void> {
    const on = await this.enabled(owner);
    const off = sourcesOfScopes(scopes).find(source => !on.has(source));
    if (off) throw sourceOff(off);
  }

  async set(owner: string, source: string, body: unknown, changedBy: string) {
    if (!SOURCE_IDS.includes(source as SourceId)) throw new DataRequestError(404, "unknown_source", "Unknown data source");
    const parsed = switchChange.safeParse(body);
    if (!parsed.success) throw new DataRequestError(400, "invalid_source_setting", "Provide enabled as true or false");
    const { enabled } = parsed.data;
    await this.database.transaction(async tx => {
      const [prior] = await tx.select({ enabled: settings.enabled }).from(settings)
        .where(and(eq(settings.createdByUserId, owner), eq(settings.source, source))).for("update");
      if (prior?.enabled === enabled) return;
      const changedAt = new Date();
      await tx.insert(settings).values({ createdByUserId: owner, source, enabled, changedAt, changedBy })
        .onConflictDoUpdate({ target: [settings.createdByUserId, settings.source], set: { enabled, changedAt, changedBy } });
      await tx.insert(history).values({ id: ulid(), createdByUserId: owner, source, enabled, changedAt, changedBy });
    });
    return (await this.document(owner)).sources.find(entry => entry.id === source)!;
  }

  /** A phone's permission state per source: the latest report replaces the earlier one. */
  async report(owner: string, installationId: string, body: unknown) {
    if (!validIdentifier(installationId)) throw new DataRequestError(400, "invalid_installation", "A valid installation identifier is required");
    const parsed = stateReport.safeParse(body);
    if (!parsed.success) throw new DataRequestError(400, "invalid_source_state", "Invalid source state report");
    const reportedAt = new Date(parsed.data.reported_at);
    const rows = SOURCE_IDS.flatMap(source => {
      const state = parsed.data.sources[source];
      return state ? [{ createdByUserId: owner, installationId, source, permission: state.permission, level: state.level ?? null,
        caveats: state.caveats ?? [], askedAt: state.asked_at ? new Date(state.asked_at) : null, reportedAt, receivedAt: new Date() }] : [];
    });
    if (rows.length) {
      await this.database.insert(states).values(rows).onConflictDoUpdate({
        target: [states.createdByUserId, states.installationId, states.source],
        set: { permission: sql`excluded.permission`, level: sql`excluded.level`, caveats: sql`excluded.caveats`,
          askedAt: sql`excluded.asked_at`, reportedAt: sql`excluded.reported_at`, receivedAt: sql`excluded.received_at` },
        // An older report arriving late doesn't replace a newer one.
        setWhere: sql`${states.reportedAt} <= excluded.reported_at`,
      });
    }
    return { reported: rows.length, enabled: Object.fromEntries(await this.switches(owner)) };
  }

  private async switches(owner: string) {
    const on = await this.enabled(owner);
    return SOURCE_IDS.map(source => [source, on.has(source)] as const);
  }

  /** One entry per source: the switch, what is stored, each phone's state, and who can read it. */
  async document(owner: string) {
    const [rows, phoneStates, phones, grant, keys, stored] = await Promise.all([
      this.database.select().from(settings).where(eq(settings.createdByUserId, owner)),
      this.database.select().from(states).where(eq(states.createdByUserId, owner)).orderBy(states.installationId).limit(600),
      this.database.select({ installationId: installations.installationId, lastReceivedAt: installations.lastReceivedAt })
        .from(installations).where(eq(installations.createdByUserId, owner)).limit(200),
      this.grants.get(owner),
      this.database.select({ id: appKeys.id, definition: accessRequests.definition, lastUsedAt: appKeys.lastUsedAt })
        .from(appKeys).innerJoin(accessRequests, and(eq(accessRequests.id, appKeys.requestId), eq(accessRequests.createdByUserId, owner)))
        .where(and(eq(appKeys.createdByUserId, owner), eq(appKeys.status, "installed"))).orderBy(appKeys.id).limit(200),
      this.stored(owner),
    ]);
    const lastReceived = new Map(phones.map(phone => [phone.installationId, phone.lastReceivedAt]));
    const detail = (source: SourceId) => source === "contacts" ? { history_days: grant.history_days, fields: grant.fields }
      : source === "health" ? { history_days: grant.history_days, health_types: grant.health_types }
      : { history_days: grant.history_days, location_precision: grant.location_precision };
    return { sources: SOURCES.map(source => {
      const setting = rows.find(row => row.source === source.id);
      return {
        id: source.id, label: source.label, enabled: setting?.enabled ?? false, changed_at: setting?.changedAt ?? null,
        stored: stored[source.id],
        installations: phoneStates.filter(state => state.source === source.id).map(state => ({
          installation_id: state.installationId, permission: state.permission, level: state.level, caveats: state.caveats,
          asked_at: state.askedAt, reported_at: state.reportedAt, last_received_at: lastReceived.get(state.installationId) ?? null })),
        agent: { allowed: grant.scopes.includes(source.scope), grant_version: grant.version, detail: detail(source.id) },
        apps: keys.filter(key => appScopes(key.definition).includes(source.scope)).map(key => ({
          key_id: key.id, label: typeof key.definition.app_label === "string" ? key.definition.app_label : null,
          last_used_at: key.lastUsedAt })),
        // The access log (plan phase 3) fills this in.
        recent_access: [] as unknown[],
      };
    }) };
  }

  /** Counts and the span of what is stored, per source. Never content. */
  private async stored(owner: string) {
    const count = sql<number>`count(*)::integer`;
    const [[location], [visitCount], [workout], [sleepRow], [contact]] = await Promise.all([
      this.database.select({ points: sql<number>`count(*) filter (where ${observations.kind} <> 'visit')::integer`,
        first: sql<Date | null>`min(${observations.occurredAt})`.mapWith(observations.occurredAt),
        last: sql<Date | null>`max(${observations.receivedAt})`.mapWith(observations.receivedAt) })
        .from(observations).where(eq(observations.createdByUserId, owner)),
      this.database.select({ count }).from(visits).where(eq(visits.createdByUserId, owner)),
      this.database.select({ count, first: sql<Date | null>`min(${workouts.startAt})`.mapWith(workouts.startAt),
        last: sql<Date | null>`max(${workouts.receivedAt})`.mapWith(workouts.receivedAt) })
        .from(workouts).where(eq(workouts.createdByUserId, owner)),
      this.database.select({ count, first: sql<Date | null>`min(${sleep.startAt})`.mapWith(sleep.startAt),
        last: sql<Date | null>`max(${sleep.receivedAt})`.mapWith(sleep.receivedAt) })
        .from(sleep).where(eq(sleep.createdByUserId, owner)),
      this.database.select({ count: sql<number>`count(*) filter (where ${contacts.visible})::integer`,
        first: sql<Date | null>`min(${contacts.firstObservedAt})`.mapWith(contacts.firstObservedAt),
        last: sql<Date | null>`max(${contacts.observedAt})`.mapWith(contacts.observedAt) })
        .from(contacts).where(eq(contacts.createdByUserId, owner)),
    ]);
    const earliest = (...dates: (Date | null)[]) => dates.filter((date): date is Date => !!date).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
    const latest = (...dates: (Date | null)[]) => dates.filter((date): date is Date => !!date).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    return {
      location: { first_at: location.first, last_received_at: location.last, counts: { visits: visitCount.count, points: location.points } },
      health: { first_at: earliest(workout.first, sleepRow.first), last_received_at: latest(workout.last, sleepRow.last),
        counts: { workouts: workout.count, sleep_segments: sleepRow.count } },
      contacts: { first_at: contact.first, last_received_at: contact.last, counts: { contacts: contact.count } },
    } satisfies Record<SourceId, unknown>;
  }
}

function appScopes(definition: Record<string, unknown>): string[] {
  const access = definition.data_access;
  const scopes = access && typeof access === "object" ? (access as Record<string, unknown>).scopes : definition.scopes;
  return Array.isArray(scopes) ? scopes.filter((scope): scope is string => typeof scope === "string") : [];
}

export function sourceOff(source: SourceId) {
  const label = SOURCES.find(entry => entry.id === source)!.label;
  return new DataRequestError(403, "source_off", `${label} is turned off in Data sources. Only the user can turn it on.`, false, 0, { source });
}
