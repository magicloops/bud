import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { z } from "zod";
import { db, type Database } from "../db/client.js";
import { invocationTimingTransaction, recordInvocationChange } from "../agent/invocation-timing.js";
import { agentInvocationTable as invocations, budTable as buds, dataSourceRequestTable as requests,
  pushNotificationOutboxTable as outbox, threadTable as threads } from "../db/schema.js";
import { buildGenericNotificationBody, buildNotificationTitle } from "../notifications/payload.js";
import { DataRequestError } from "./contracts.js";
import { DataGrants } from "./grants.js";
import { DataSources, SOURCES, SOURCE_IDS, type SourceId } from "./sources.js";

/**
 * The agent asks the user for a data source it can't use (bud-mobile `plan/data-sources-ux`,
 * Phase 2b). The tool parks the turn; the user's phone or browser shows a card; every change
 * is a tap by the user. The agent supplies a source, a purpose and (location) a level, and can
 * neither allow nor answer a request. What the answer means is read here from the service's
 * own state, never taken from the client.
 */
export const SOURCE_REQUEST_TOOL = "data_source_request";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Row = typeof requests.$inferSelect;
export type SourceRequestOutcome = "granted" | "declined" | "unavailable" | "superseded";
export type SourceRequestContext = { owner: string; invocationId: string; callId: string };

/** How long a request waits before its push, so someone looking at the card never gets one. */
const PUSH_DELAY_MS = 10_000;
/** How long an answer waits for a reading the phone uploaded just before it. */
const READING_WAIT_MS = 5_000;

const requestInput = z.object({
  source: z.enum(SOURCE_IDS as [SourceId, ...SourceId[]]),
  purpose: z.string().trim().min(1).max(120),
  // A strict-schema provider sends null for "not set".
  level: z.enum(["always"]).nullish(),
}).strict().refine(value => value.level == null || value.source === "location");
const answerInput = z.object({
  outcome: z.enum(["granted", "declined", "unavailable"]),
  reading_event_id: z.string().min(1).max(200).optional(),
}).strict();

export function parseSourceRequestInput(input: unknown): { source: SourceId; purpose: string; level?: "always" } {
  const parsed = requestInput.safeParse(input);
  if (!parsed.success) throw new DataRequestError(400, "invalid_source_request",
    "Provide source (location, health or contacts), a purpose of at most 120 characters, and level always only for location");
  const { level, ...rest } = parsed.data;
  return level ? { ...rest, level } : rest;
}

const label = (source: string) => SOURCES.find(entry => entry.id === source)?.label ?? source;

/** What the agent is told. `usable` is what it acts on. */
function result(args: { requestId?: string; source: string; outcome: SourceRequestOutcome; asked: boolean;
  access?: { enabled: boolean; agent_allowed: boolean; permission: string | null; level: string | null };
  reading?: "received" | "not_received" }): Record<string, unknown> {
  const usable = args.access ? args.access.enabled && args.access.agent_allowed : undefined;
  const name = label(args.source);
  const next = args.outcome === "granted"
    ? args.reading === "received" ? `${name} is available and a fresh reading was received. Query it now.`
      : args.reading === "not_received" ? `${name} is available, but the fresh reading hasn't arrived yet. Query now and say if the result is old.`
      : args.asked ? `${name} is available. Query it now; a phone that was only just allowed may not have sent anything yet.`
      : `${name} is already available: nothing needed asking. Query it.`
    : args.outcome === "declined"
      ? args.asked ? `The user chose not to share ${name.toLowerCase()}. Nothing changed. Answer without it and don't ask again unless they say they want to share it.`
        : `The user already declined ${name.toLowerCase()} in this turn, so they were not asked again. Answer without it.`
    : args.outcome === "unavailable" ? `${name} can't be used: the phone or the account's settings don't allow it. Explain briefly and move on.`
    : `The user sent a message instead of answering. Nothing changed. Finish briefly without ${name.toLowerCase()}; their message follows.`;
  return { ...(args.requestId ? { request_id: args.requestId } : {}), source: args.source, outcome: args.outcome, asked: args.asked,
    ...(args.access ? { ...args.access, usable } : {}), ...(args.reading ? { reading: args.reading } : {}), next };
}

export function serializeSourceRequest(row: Row) {
  return { request_id: row.id, source: row.source, purpose: row.purpose, level: row.level, status: row.status,
    thread_id: row.threadId, result: row.settled, answered_at: row.answeredAt, created_at: row.createdAt };
}

/** The tool result for a request that is no longer pending. */
export function sourceRequestToolResult(row: Row): Record<string, unknown> {
  if (row.settled) return row.settled;
  return result({ requestId: row.id, source: row.source, outcome: "superseded", asked: true });
}

export class SourceRequests {
  constructor(private readonly database: Omit<Database, "$client"> = db,
    private readonly sources: DataSources = new DataSources(database), private readonly now = () => new Date()) {}

  /**
   * Opens a request inside the transaction that parks its tool action, or answers at once when
   * there is nothing to show: access is already in order, or the user declined this source
   * earlier in the same turn (so the agent can't nag).
   */
  async requestInTransaction(tx: Transaction, context: SourceRequestContext, input: unknown): Promise<
    { kind: "request"; request: ReturnType<typeof serializeSourceRequest> } | { kind: "settled"; result: Record<string, unknown> }> {
    const value = parseSourceRequestInput(input);
    const [invocation] = await tx.select().from(invocations)
      .where(and(eq(invocations.id, context.invocationId), eq(invocations.createdByUserId, context.owner))).limit(1);
    if (!invocation) throw new DataRequestError(404, "invocation_not_found", "Invocation not found");
    // Nobody is in an automation's conversation to answer.
    if (invocation.origin !== "human") throw new DataRequestError(409, "no_user_present", "Only a conversation with the user can ask for a data source");
    const [existing] = await tx.select().from(requests).where(and(eq(requests.invocationId, invocation.id),
      eq(requests.callId, context.callId), eq(requests.createdByUserId, context.owner)));
    if (existing) return { kind: "request", request: serializeSourceRequest(existing) };
    const access = await this.sources.access(context.owner, value.source, tx);
    const [declined] = await tx.select({ id: requests.id }).from(requests).where(and(eq(requests.createdByUserId, context.owner),
      eq(requests.threadId, invocation.threadId), eq(requests.turnId, invocation.turnId), eq(requests.source, value.source),
      eq(requests.status, "declined"))).limit(1);
    if (declined) return { kind: "settled", result: result({ source: value.source, outcome: "declined", asked: false, access }) };
    // Location always offers a fresh reading, so its card is shown even when access is in order.
    const inOrder = access.enabled && access.agent_allowed && (access.permission === "granted" || access.permission === "unknowable");
    if (inOrder && value.source !== "location") return { kind: "settled", result: result({ source: value.source, outcome: "granted", asked: false, access }) };
    const [row] = await tx.insert(requests).values({ id: `dsr_${ulid()}`, invocationId: invocation.id, threadId: invocation.threadId,
      budId: invocation.budId, turnId: invocation.turnId, callId: context.callId, source: value.source, purpose: value.purpose,
      level: value.level ?? null, createdByUserId: context.owner, tenantId: invocation.tenantId, createdAt: this.now(), updatedAt: this.now() }).returning();
    await this.enqueuePush(tx, row);
    return { kind: "request", request: serializeSourceRequest(row) };
  }

  /**
   * A push for a request the user may not be looking at. It is sent after a short delay and only
   * if the request is still open and no client has shown its card (`pushDue`). It says nothing
   * about which source or why.
   */
  private async enqueuePush(tx: Transaction, row: Row) {
    const [thread] = await tx.select({ title: threads.title, budDisplayName: buds.displayName, budName: buds.name })
      .from(threads).innerJoin(buds, eq(buds.budId, threads.budId)).where(eq(threads.threadId, row.threadId)).limit(1);
    await tx.insert(outbox).values({ notificationId: ulid(), userId: row.createdByUserId, threadId: row.threadId,
      kind: "human_input_requested", status: "pending",
      dedupeKey: `user:${row.createdByUserId}:source_request:${row.id}`, collapseKey: `thread:${row.threadId}`,
      title: buildNotificationTitle(thread?.title ?? null, thread?.budDisplayName ?? thread?.budName ?? "Bud"),
      body: buildGenericNotificationBody("human_input_requested"),
      payload: { kind: "human_input_requested", thread_id: row.threadId, bud_id: row.budId, request_id: row.id,
        sent_at: this.now().toISOString() },
      nextAttemptAt: new Date(this.now().getTime() + PUSH_DELAY_MS), createdByUserId: row.createdByUserId, tenantId: row.tenantId,
    }).onConflictDoNothing();
  }

  /** Whether a request's push should still be sent: open, and its card not yet shown anywhere. */
  async pushDue(requestId: string): Promise<boolean> {
    const [row] = await this.database.select({ id: requests.id }).from(requests)
      .where(and(eq(requests.id, requestId), eq(requests.status, "pending"), isNull(requests.seenAt))).limit(1);
    return Boolean(row);
  }

  private async load(database: Pick<Database, "select">, owner: string, id: string, lock = false) {
    const query = database.select().from(requests).where(and(eq(requests.id, id), eq(requests.createdByUserId, owner))).limit(1);
    const [row] = await (lock ? query.for("update") : query);
    if (!row) throw new DataRequestError(404, "source_request_not_found", "Request not found");
    return row;
  }

  /** The request and its source's current state, for the card. Showing it counts as seen. */
  async get(owner: string, id: string) {
    const row = await this.load(this.database, owner, id);
    if (!row.seenAt && row.status === "pending")
      await this.database.update(requests).set({ seenAt: this.now() }).where(and(eq(requests.id, id), isNull(requests.seenAt)));
    const source = (await this.sources.document(owner)).sources.find(entry => entry.id === row.source)!;
    return { request: serializeSourceRequest(row), source };
  }

  /**
   * The card's one tap: turns the source on and lets the agent read it, together. Both are the
   * ordinary changes (switch history, permission history), so they appear in Changes. It doesn't
   * answer the request; the card does that once the phone's own permission is settled.
   */
  async allow(owner: string, id: string, client: "ios" | "web") {
    await this.database.transaction(async tx => {
      const row = await this.load(tx, owner, id, true);
      if (row.status !== "pending") throw new DataRequestError(409, "source_request_not_pending", "This request is no longer open");
      const scope = SOURCES.find(entry => entry.id === row.source)!.scope;
      const grants = new DataGrants(tx);
      const grant = await grants.get(owner);
      if (!grant.scopes.includes(scope)) await grants.update(owner, { scopes: [...grant.scopes, scope], version: grant.version,
        history_days: grant.history_days, fields: grant.fields, health_types: grant.health_types });
      const access = await this.sources.access(owner, row.source as SourceId, tx);
      if (!access.enabled) await new DataSources(tx, grants).set(owner, row.source, { enabled: true }, client);
    });
    return this.get(owner, id);
  }

  /** The user's answer. The outcome is the client's; what it amounts to is read here. */
  async respond(owner: string, id: string, body: unknown, client: "ios" | "web") {
    const parsed = answerInput.safeParse(body);
    if (!parsed.success) throw new DataRequestError(400, "invalid_source_response", "Provide outcome granted, declined or unavailable");
    const answer = parsed.data;
    // Before the transaction: let a reading the phone just uploaded be stored and projected, so
    // the agent's next query sees it. Bounded; a late reading is reported as not received.
    if (answer.reading_event_id) await this.sources.readingArrived(owner, answer.reading_event_id, READING_WAIT_MS);
    await invocationTimingTransaction(this.database as Database, async tx => {
      const row = await this.load(tx, owner, id, true);
      if (row.status !== "pending") {
        // The same answer again (a retry) is fine; a different one is too late.
        if (row.answeredAt && row.settled?.given === answer.outcome) return;
        throw new DataRequestError(409, "source_request_not_pending", "This request is no longer open");
      }
      const access = await this.sources.access(owner, row.source as SourceId, tx);
      const usable = access.enabled && access.agent_allowed;
      // A client can't report access that doesn't exist.
      const outcome = answer.outcome === "granted" && !usable ? "unavailable" : answer.outcome;
      const reading = row.source !== "location" || !answer.reading_event_id || outcome !== "granted" ? undefined
        : await this.sources.readingArrived(owner, answer.reading_event_id, 0, tx) ? "received" as const : "not_received" as const;
      const settled = { ...result({ requestId: row.id, source: row.source, outcome, asked: true,
        access: { enabled: access.enabled, agent_allowed: access.agent_allowed, permission: access.permission, level: access.level }, reading }),
        given: answer.outcome };
      await tx.update(requests).set({ status: outcome, settled, readingEventId: answer.reading_event_id ?? null,
        answeredFrom: client, answeredAt: this.now(), updatedAt: this.now() }).where(eq(requests.id, id));
      recordInvocationChange(tx, row.invocationId);
    });
    return { request: serializeSourceRequest(await this.load(this.database, owner, id)) };
  }

  /**
   * A follow-up message replaces an unanswered request: the waiting turn resumes with
   * `superseded` and finishes, then the new message runs. Not a decline.
   */
  async supersedeInTransaction(tx: Transaction, owner: string, threadId: string) {
    const rows = await tx.update(requests).set({ status: "superseded", updatedAt: sql`clock_timestamp()` })
      .where(and(eq(requests.createdByUserId, owner), eq(requests.threadId, threadId), eq(requests.status, "pending")))
      .returning({ invocationId: requests.invocationId });
    for (const row of rows) recordInvocationChange(tx, row.invocationId);
    return rows.length;
  }

  /** A source's requests and how each ended, newest first, for Changes. Never the purpose. */
  async history(owner: string, source: string, limit = 50) {
    const rows = await this.database.select({ id: requests.id, status: requests.status, threadId: requests.threadId,
      at: sql<Date>`coalesce(${requests.answeredAt}, ${requests.createdAt})`.mapWith(requests.createdAt) })
      .from(requests).where(and(eq(requests.createdByUserId, owner), eq(requests.source, source),
        sql`${requests.status} in ('granted', 'declined', 'unavailable')`))
      .orderBy(desc(requests.createdAt)).limit(limit);
    return rows;
  }
}
