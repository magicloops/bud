import { and, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db, type Database } from "../db/client.js";
import { agentDataGrantHistoryTable as grantHistory, automationTable as automations, dataAccessLogTable as log,
  dataAccessRequestTable as accessRequests, dataAppKeyTable as appKeys, dataSourceRequestTable as sourceRequests, dataSourceSettingHistoryTable as switchHistory,
  threadTable as threads } from "../db/schema.js";
import { DataRequestError } from "./contracts.js";
import { SOURCES, SOURCE_IDS, appScopes, sourcesOfScopes, type SourceId } from "./sources.js";

/**
 * The access log (bud-mobile `plan/data-sources-ux`, Phase 3): what read each source, when, and
 * on whose behalf. One row per read and per source. Content-free: an operation name, a time
 * window, a count and an outcome, never coordinates, names or field values.
 */
export type AccessActorKind = "agent" | "automation" | "app" | "processor";
export const ACCESS_ACTOR_KINDS: AccessActorKind[] = ["agent", "automation", "app", "processor"];
/** `ref` is the thread (agent), the automation, the app key, or the processor's name. */
export type AccessActor = { kind: AccessActorKind; ref: string; threadId?: string | null; turnId?: string | null };
export type AccessEntry = {
  owner: string; actor: AccessActor; sources: readonly SourceId[]; operation: string;
  window?: { from?: Date | null; to?: Date | null }; recordCount?: number | null; policyVersion?: number | null;
  /** `ok` (the default), or the code the read was refused or failed with. */
  outcome?: string;
};

/** The third party the service sends location to for place names. */
export const GEOAPIFY = "geoapify";
const RECENT_DAYS = 7, RECENT_GROUPS = 5, PAGE = 50, MAX_PAGE = 200;
type Writer = Pick<Database, "insert">;

/** How many records a result holds, from its shape. Never looks at values. */
export function countRecords(data: unknown): number | null {
  if (data == null) return 0;
  if (Array.isArray(data)) return data.length;
  if (typeof data !== "object") return 1;
  const record = data as Record<string, unknown>;
  for (const key of ["items", "places", "nights", "segments", "recent_readings"]) if (Array.isArray(record[key])) return (record[key] as unknown[]).length;
  if ("location" in record) return record.location ? 1 : 0;
  if ("evidence" in record) return record.evidence ? 1 : 0;
  return 1;
}

/** The time window a query asked for, when its arguments name one. */
export function queryWindow(args: unknown): { from?: Date; to?: Date } | undefined {
  if (!args || typeof args !== "object") return undefined;
  const date = (value: unknown) => {
    const parsed = typeof value === "string" && value.length <= 40 ? new Date(value) : null;
    return parsed && Number.isFinite(parsed.getTime()) ? parsed : undefined;
  };
  const from = date((args as Record<string, unknown>).from), to = date((args as Record<string, unknown>).to);
  return from || to ? { from, to } : undefined;
}

export class AccessLog {
  constructor(private readonly database: Omit<Database, "$client"> = db) {}

  /** Appends one row per source. Throws when it can't: a caller about to hand data over withholds it. */
  async record(entry: AccessEntry, database: Writer = this.database): Promise<void> {
    if (!entry.sources.length) return;
    // Set here, to the millisecond: the list's cursor carries the time as a JavaScript date, so
    // a finer database time would let a page boundary skip or repeat a row.
    const at = new Date();
    await database.insert(log).values(entry.sources.map(source => ({
      id: ulid(), at, createdByUserId: entry.owner, actorKind: entry.actor.kind, actorRef: entry.actor.ref.slice(0, 200),
      threadId: entry.actor.threadId ?? null, turnId: entry.actor.turnId ?? null, source, operation: entry.operation.slice(0, 80),
      windowFrom: entry.window?.from ?? null, windowTo: entry.window?.to ?? null, recordCount: entry.recordCount ?? null,
      policyVersion: entry.policyVersion ?? null, outcome: (entry.outcome ?? "ok").slice(0, 80) })));
  }

  /** For a refusal or an outbound lookup already made: the log must not turn it into a different failure. */
  async recordQuietly(entry: AccessEntry, database: Writer = this.database): Promise<void> {
    try { await this.record(entry, database); } catch { /* the read's own outcome stands */ }
  }

  /** The owner's log, newest first, with what each actor is called. */
  async list(owner: string, query: Record<string, unknown>) {
    const text = (key: string) => typeof query[key] === "string" && query[key] ? String(query[key]) : undefined;
    const source = text("source"), kind = text("actor_kind"), ref = text("actor_ref"), cursor = text("cursor");
    if (source && !SOURCE_IDS.includes(source as SourceId)) throw new DataRequestError(400, "invalid_query", "Unknown source");
    if (kind && !ACCESS_ACTOR_KINDS.includes(kind as AccessActorKind)) throw new DataRequestError(400, "invalid_query", "Unknown actor kind");
    const date = (key: string) => {
      const value = text(key);
      if (!value) return undefined;
      const parsed = new Date(value);
      if (!Number.isFinite(parsed.getTime())) throw new DataRequestError(400, "invalid_query", `Invalid ${key}`);
      return parsed;
    };
    const from = date("from"), to = date("to");
    const limit = query.limit === undefined ? PAGE : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new DataRequestError(400, "invalid_limit", `Limit must be 1–${MAX_PAGE}`);
    let before: { at: Date; id: string } | undefined;
    if (cursor) {
      const [at, id] = cursor.split("|");
      const parsed = new Date(at);
      if (!id || !Number.isFinite(parsed.getTime())) throw new DataRequestError(400, "invalid_cursor", "Invalid cursor");
      before = { at: parsed, id };
    }
    const rows = await this.database.select().from(log).where(and(eq(log.createdByUserId, owner),
      source ? eq(log.source, source) : undefined, kind ? eq(log.actorKind, kind) : undefined, ref ? eq(log.actorRef, ref) : undefined,
      from ? gte(log.at, from) : undefined, to ? lte(log.at, to) : undefined,
      before ? or(lt(log.at, before.at), and(eq(log.at, before.at), lt(log.id, before.id))) : undefined))
      .orderBy(desc(log.at), desc(log.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    const names = await this.names(owner, page);
    const last = page.at(-1);
    return {
      items: page.map(row => ({ id: row.id, at: row.at, source: row.source, operation: row.operation, outcome: row.outcome,
        actor: { kind: row.actorKind, ref: row.actorRef, ...names.actor(row) },
        thread: row.threadId ? { id: row.threadId, turn_id: row.turnId, ...names.thread(row.threadId) } : null,
        window: row.windowFrom || row.windowTo ? { from: row.windowFrom, to: row.windowTo } : null,
        record_count: row.recordCount, policy_version: row.policyVersion })),
      next_cursor: rows.length > limit && last ? `${last.at.toISOString()}|${last.id}` : null,
    };
  }

  /** Per source, who read it in the last week: a few groups, most recent first. */
  async recent(owner: string, now = new Date()) {
    const since = new Date(now.getTime() - RECENT_DAYS * 86400_000);
    // An agent's reads are grouped by conversation; a processor's by the processor, whoever it worked for.
    const rows = await this.database.select({ source: log.source, actorKind: log.actorKind, actorRef: log.actorRef,
      threadId: sql<string | null>`case when ${log.actorKind} = 'agent' then ${log.threadId} end`,
      reads: sql<number>`count(*) filter (where ${log.outcome} = 'ok')::integer`,
      refused: sql<number>`count(*) filter (where ${log.outcome} <> 'ok')::integer`,
      lastAt: sql<Date>`max(${log.at})`.mapWith(log.at) }).from(log)
      .where(and(eq(log.createdByUserId, owner), gte(log.at, since)))
      .groupBy(log.source, log.actorKind, log.actorRef, sql`case when ${log.actorKind} = 'agent' then ${log.threadId} end`)
      .orderBy(desc(sql`max(${log.at})`)).limit(300);
    const names = await this.names(owner, rows);
    return { since, groups: (source: SourceId) => rows.filter(row => row.source === source).slice(0, RECENT_GROUPS).map(row => ({
      actor: { kind: row.actorKind, ref: row.actorRef, ...names.actor(row) },
      thread: row.threadId ? { id: row.threadId, ...names.thread(row.threadId) } : null,
      reads: row.reads, refused: row.refused, last_at: row.lastAt })) };
  }

  /** Reads by each app key that touched a source in the last week. */
  async appReads(owner: string, now = new Date()) {
    const since = new Date(now.getTime() - RECENT_DAYS * 86400_000);
    const rows = await this.database.select({ source: log.source, keyId: log.actorRef,
      reads: sql<number>`count(*) filter (where ${log.outcome} = 'ok')::integer`, lastAt: sql<Date>`max(${log.at})`.mapWith(log.at) })
      .from(log).where(and(eq(log.createdByUserId, owner), eq(log.actorKind, "app"), gte(log.at, since)))
      .groupBy(log.source, log.actorRef).limit(600);
    return (source: SourceId, keyId: string) => rows.find(row => row.source === source && row.keyId === keyId) ?? null;
  }

  /**
   * What changed about who may read a source, newest first: the switch, the agent's permission
   * (from its history) and app keys approved or revoked.
   */
  async changes(owner: string, source: string) {
    const entry = SOURCES.find(candidate => candidate.id === source);
    if (!entry) throw new DataRequestError(404, "unknown_source", "Unknown data source");
    const [switches, grants, keys] = await Promise.all([
      this.database.select().from(switchHistory).where(and(eq(switchHistory.createdByUserId, owner), eq(switchHistory.source, entry.id)))
        .orderBy(desc(switchHistory.changedAt)).limit(100),
      this.database.select().from(grantHistory).where(eq(grantHistory.createdByUserId, owner)).orderBy(desc(grantHistory.version)).limit(200),
      this.database.select({ id: appKeys.id, definition: accessRequests.definition, installedAt: appKeys.installedAt, revokedAt: appKeys.revokedAt })
        .from(appKeys).innerJoin(accessRequests, and(eq(accessRequests.id, appKeys.requestId), eq(accessRequests.createdByUserId, owner)))
        .where(eq(appKeys.createdByUserId, owner)).orderBy(desc(appKeys.createdAt)).limit(200),
    ]);
    // What the agent asked for in a conversation and how the user answered (plan phase 2b). Never the purpose.
    const asked = await this.database.select({ status: sourceRequests.status, threadId: sourceRequests.threadId, at: sourceRequests.answeredAt })
      .from(sourceRequests).where(and(eq(sourceRequests.createdByUserId, owner), eq(sourceRequests.source, entry.id),
        inArray(sourceRequests.status, ["granted", "declined", "unavailable"]))).orderBy(desc(sourceRequests.answeredAt)).limit(100);
    type Change = { at: Date; kind: "switch" | "agent" | "agent_detail" | "app" | "request"; [key: string]: unknown };
    const changes: Change[] = switches.map(row => ({ at: row.changedAt, kind: "switch", enabled: row.enabled, by: row.changedBy }));
    const detail = (row: typeof grants[number]) => entry.id === "contacts" ? { history_days: row.historyDays, fields: row.contactFields }
      : entry.id === "health" ? { history_days: row.historyDays, health_types: row.healthTypes } : { history_days: row.historyDays };
    // Newest first: each version against the one before it. The oldest has nothing to be compared with.
    grants.forEach((row, index) => {
      const earlier = grants[index + 1];
      const allowed = row.scopes.includes(entry.scope), was = earlier?.scopes.includes(entry.scope) ?? false;
      if (allowed !== was && (earlier || allowed)) changes.push({ at: row.changedAt, kind: "agent", allowed });
      else if (earlier && allowed && JSON.stringify(detail(row)) !== JSON.stringify(detail(earlier)))
        changes.push({ at: row.changedAt, kind: "agent_detail", detail: detail(row) });
    });
    for (const key of keys) {
      if (!sourcesOfScopes(appScopes(key.definition)).includes(entry.id)) continue;
      const label = appLabel(key.definition);
      if (key.installedAt) changes.push({ at: key.installedAt, kind: "app", key_id: key.id, label, action: "approved" });
      if (key.revokedAt) changes.push({ at: key.revokedAt, kind: "app", key_id: key.id, label, action: "revoked" });
    }
    for (const row of asked) if (row.at) changes.push({ at: row.at, kind: "request", outcome: row.status, thread_id: row.threadId });
    return { source: entry.id, changes: changes.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 100) };
  }

  /** What to call each actor and thread in a set of rows. Only the owner's own. */
  private async names(owner: string, rows: readonly { actorKind: string; actorRef: string; threadId: string | null }[]) {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const threadIds = [...new Set(rows.flatMap(row => row.threadId && uuid.test(row.threadId) ? [row.threadId] : []))];
    const automationIds = [...new Set(rows.filter(row => row.actorKind === "automation").map(row => row.actorRef))];
    const keyIds = [...new Set(rows.filter(row => row.actorKind === "app").map(row => row.actorRef))];
    const [threadRows, automationRows, keyRows] = await Promise.all([
      threadIds.length ? this.database.select({ id: threads.threadId, title: threads.title, budId: threads.budId }).from(threads)
        .where(and(inArray(threads.threadId, threadIds), eq(threads.createdByUserId, owner), isNull(threads.deletedAt))) : [],
      automationIds.length ? this.database.select({ id: automations.id, name: sql<string | null>`${automations.draft}->>'name'` }).from(automations)
        .where(and(inArray(automations.id, automationIds), eq(automations.createdByUserId, owner))) : [],
      keyIds.length ? this.database.select({ id: appKeys.id, definition: accessRequests.definition, status: appKeys.status }).from(appKeys)
        .innerJoin(accessRequests, and(eq(accessRequests.id, appKeys.requestId), eq(accessRequests.createdByUserId, owner)))
        .where(and(inArray(appKeys.id, keyIds), eq(appKeys.createdByUserId, owner))) : [],
    ]);
    const threadById = new Map(threadRows.map(row => [row.id, row]));
    const automationById = new Map(automationRows.map(row => [row.id, row.name]));
    const keyById = new Map(keyRows.map(row => [row.id, row]));
    return {
      /** `exists: false` once the conversation was deleted: the row stays, the link doesn't. */
      thread: (id: string) => ({ title: threadById.get(id)?.title ?? null, bud_id: threadById.get(id)?.budId ?? null, exists: threadById.has(id) }),
      actor: (row: { actorKind: string; actorRef: string }) => row.actorKind === "automation" ? { label: automationById.get(row.actorRef) ?? null }
        : row.actorKind === "app" ? { label: keyById.has(row.actorRef) ? appLabel(keyById.get(row.actorRef)!.definition) : null,
          revoked: keyById.get(row.actorRef)?.status === "revoked" }
        : row.actorKind === "processor" ? { label: row.actorRef === GEOAPIFY ? "Geoapify" : row.actorRef } : { label: null },
    };
  }
}

function appLabel(definition: Record<string, unknown>): string | null {
  return typeof definition.app_label === "string" ? definition.app_label : null;
}
