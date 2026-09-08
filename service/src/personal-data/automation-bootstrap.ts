import { and, asc, desc, eq, gt, lt, ilike, inArray, isNull, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { isDeepStrictEqual } from "node:util";
import { db, type Database } from "../db/client.js";
import { automationBootstrapTable as requests, automationBootstrapMemberTable as members, automationBootstrapGroupTable as groups, agentInvocationTable as invocations,
  automationTable as rules, automationRevisionTable as revisions, dataOwnerStateTable as owners,
  agentDataGrantTable as grants, contactTable as contacts, contactRevisionTable as contactRevisions,
  contactScanTable as scans, contactSourceTable as sources, dataCollectionEpochTable as epochs,
  dataInstallationTable as installations } from "../db/schema.js";
import { automationBootstrapSchema, automationBootstrapPreviewSchema, automationDefinitionSchema, AUTOMATION_LIMITS, parseAutomationInput } from "./automation-contracts.js";
import { InvocationRepository } from "../agent/invocation-repository.js";
import { Automations } from "./automations.js";
import { automationActivationSchema } from "./automation-contracts.js";
import { DataRequestError } from "./contracts.js";
import { automationBootstrapReviewRequestSchema, frozenBootstrapReviewSchema, type FrozenBootstrapReview } from "./automation-bootstrap-review-contracts.js";

function receipt(row: typeof requests.$inferSelect) {
  return { bootstrap_id: row.id, automation_id: row.automationId, revision: row.revision,
    publication_boundary: row.publicationBoundary, member_count: row.memberCount,
    group_count: Math.ceil(row.memberCount / row.groupSize), group_size: row.groupSize,
    status: row.status, latest_start_at: row.latestStartAt, created_at: row.createdAt };
}

/** Snapshot capture only; group admission/execution is a separate durable step. */
export class AutomationBootstrap {
  constructor(private readonly database: Database = db) {}

  async list(owner: string, automationId: string, query: { limit?: number; cursor?: string } = {}) {
    const [rule] = await this.database.select({ id: rules.id }).from(rules).where(and(
      eq(rules.id, automationId), eq(rules.createdByUserId, owner))).limit(1);
    if (!rule) throw new DataRequestError(404, "automation_not_found", "Automation not found");
    const limit = query.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new DataRequestError(400, "invalid_bootstrap_query", "Limit must be between 1 and 100");
    let before: string | undefined;
    if (query.cursor !== undefined) {
      try {
        if (query.cursor.length > 2048) throw new Error();
        const cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
        if (cursor.owner !== owner || cursor.automation !== automationId || typeof cursor.before !== "string" ||
          !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(cursor.before)) throw new Error();
        before = cursor.before;
      } catch { throw new DataRequestError(400, "invalid_bootstrap_cursor", "Invalid bootstrap cursor"); }
    }
    const rows = await this.database.select().from(requests).where(and(eq(requests.createdByUserId, owner),
      eq(requests.automationId, automationId), before ? lt(requests.id, before) : undefined))
      .orderBy(desc(requests.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    return { items: page.map(receipt), next_cursor: rows.length > limit ? Buffer.from(JSON.stringify({
      owner, automation: automationId, before: page[page.length - 1].id })).toString("base64url") : null };
  }

  async get(owner: string, automationId: string, bootstrapId: string) {
    const [row] = await this.database.select().from(requests).where(and(
      eq(requests.createdByUserId, owner), eq(requests.automationId, automationId),
      eq(requests.id, bootstrapId))).limit(1);
    if (!row) throw new DataRequestError(404, "bootstrap_not_found", "Bootstrap request not found");
    return receipt(row);
  }

  async progress(owner: string, automationId: string, bootstrapId: string,
    query: { limit?: number; after?: number } = {}) {
    const request = await this.get(owner, automationId, bootstrapId);
    const limit = query.limit ?? 25;
    const after = query.after ?? -1;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(after) || after < -1 || after > 999)
      throw new DataRequestError(400, "invalid_bootstrap_query", "Invalid group page bounds");
    const effectiveState = sql<string>`coalesce(${invocations.status}, ${groups.status})`;
    const counts = await this.database.select({ status: effectiveState, count: sql<number>`count(*)::integer` }).from(groups)
      .leftJoin(invocations, and(eq(invocations.id, groups.invocationId), eq(invocations.createdByUserId, owner)))
      .where(and(eq(groups.bootstrapId, bootstrapId), eq(groups.createdByUserId, owner))).groupBy(effectiveState);
    const rows = await this.database.select({ group_index: groups.groupIndex, status: effectiveState,
      outcome_code: sql<string | null>`coalesce(${invocations.outcomeCode}, ${groups.outcomeCode})`,
      invocation_id: groups.invocationId, thread_id: invocations.threadId, bud_id: invocations.budId,
      cancel_requested_at: invocations.cancelRequestedAt }).from(groups)
      .leftJoin(invocations, and(eq(invocations.id, groups.invocationId), eq(invocations.createdByUserId, owner)))
      .where(and(eq(groups.bootstrapId, bootstrapId), eq(groups.createdByUserId, owner), gt(groups.groupIndex, after)))
      .orderBy(asc(groups.groupIndex)).limit(limit + 1);
    const terminal = new Set(["succeeded", "failed", "canceled", "expired"]);
    const settled = counts.reduce((sum, row) => sum + (terminal.has(row.status) ? row.count : 0), 0);
    const items = rows.slice(0, limit);
    return { bootstrap_id: bootstrapId, request_status: request.status,
      settled: settled === request.group_count, group_count: request.group_count, settled_group_count: settled,
      counts: Object.fromEntries(counts.map(row => [row.status, row.count])), items,
      next_after: rows.length > limit ? items[items.length - 1].group_index : null };
  }

  async cancel(owner: string, automationId: string, bootstrapId: string) {
    return this.database.transaction(async tx => {
      await tx.select().from(owners).where(eq(owners.createdByUserId, owner)).for("update");
      const [request] = await tx.select().from(requests).where(and(eq(requests.id, bootstrapId),
        eq(requests.automationId, automationId), eq(requests.createdByUserId, owner))).for("update").limit(1);
      if (!request) throw new DataRequestError(404, "bootstrap_not_found", "Bootstrap request not found");
      if (request.status === "completed" || request.status === "failed") return receipt(request);
      const [updated] = await tx.update(requests).set({ status: "canceled" }).where(and(
        eq(requests.id, bootstrapId), eq(requests.createdByUserId, owner))).returning();
      await tx.update(groups).set({ status: "canceled", outcomeCode: "user_canceled", updatedAt: sql`clock_timestamp()` })
        .where(and(eq(groups.bootstrapId, bootstrapId), eq(groups.createdByUserId, owner), eq(groups.status, "pending")));
      const admitted = await tx.select({ invocationId: groups.invocationId }).from(groups).where(and(
        eq(groups.bootstrapId, bootstrapId), eq(groups.createdByUserId, owner), eq(groups.status, "admitted")))
        .orderBy(asc(groups.groupIndex)).limit(AUTOMATION_LIMITS.bootstrap_contacts);
      const repository = new InvocationRepository(this.database);
      for (const group of admitted) {
        if (group.invocationId) await repository.requestCancelInTransaction(tx, owner, group.invocationId);
      }
      return receipt(updated);
    });
  }

  async page(owner: string, automationId: string, bootstrapId: string,
    query: { limit?: number; cursor?: string } = {}) {
    await this.get(owner, automationId, bootstrapId);
    const limit = query.limit ?? AUTOMATION_LIMITS.bootstrap_group_size;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new DataRequestError(400, "invalid_bootstrap_query", "Limit must be between 1 and 100");
    let after = -1;
    if (query.cursor !== undefined) {
      try {
        if (query.cursor.length > 2048) throw new Error();
        const cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
        if (cursor.owner !== owner || cursor.automation !== automationId || cursor.bootstrap !== bootstrapId ||
          !Number.isInteger(cursor.after) || cursor.after < 0 || cursor.after >= AUTOMATION_LIMITS.bootstrap_contacts) throw new Error();
        after = cursor.after;
      } catch { throw new DataRequestError(400, "invalid_bootstrap_cursor", "Invalid bootstrap cursor"); }
    }
    // Return frozen evidence IDs, never silently substitute a newer projection.
    const rows = await this.database.select({ ordinal: members.ordinal, group_index: members.groupIndex,
      contact_revision_id: members.contactRevisionId }).from(members).where(and(
      eq(members.createdByUserId, owner), eq(members.bootstrapId, bootstrapId), gt(members.ordinal, after)))
      .orderBy(asc(members.ordinal)).limit(limit + 1);
    const items = rows.slice(0, limit);
    return { items, next_cursor: rows.length > limit ? Buffer.from(JSON.stringify({ owner,
      automation: automationId, bootstrap: bootstrapId, after: items[items.length - 1].ordinal })).toString("base64url") : null };
  }

  async preview(owner: string, automationId: string, input: unknown) {
    const value = parseAutomationInput(automationBootstrapPreviewSchema, input);
    return this.database.transaction(async tx => {
      const [rule] = await tx.select().from(rules).where(and(eq(rules.id, automationId), eq(rules.createdByUserId, owner))).limit(1);
      if (!rule || rule.state === "deleted") throw new DataRequestError(404, "automation_not_found", "Automation not found");
      if (rule.version !== value.expected_version) throw new DataRequestError(409, "automation_conflict", "Automation changed; reload before previewing");
      const [grant] = await tx.select().from(grants).where(eq(grants.createdByUserId, owner));
      if (!grant || grant.version !== value.expected_grant_version)
        throw new DataRequestError(409, "grant_conflict", "Data permissions changed; reload before previewing");
      const [active] = rule.activeRevision === null ? [] : await tx.select().from(revisions).where(and(
        eq(revisions.automationId, automationId), eq(revisions.revision, rule.activeRevision), eq(revisions.createdByUserId, owner))).limit(1);
      if (!value.use_draft && !active) throw new DataRequestError(409, "automation_not_activated", "Activate a saved revision first");
      const definition = parseAutomationInput(automationDefinitionSchema, value.use_draft ? rule.draft : active!.definition);
      if ((!value.use_draft && active!.grantVersion !== grant.version) || definition.data_access.history_days > grant.historyDays ||
        !definition.data_access.scopes.every(scope => grant.scopes.includes(scope)))
        throw new DataRequestError(403, "data_permission_changed", "Approve current data permissions before previewing");
      const revision = value.use_draft ? rule.version + 1 : active!.revision;
      const snapshot = await this.selectSnapshot(tx, owner, automationId, revision, definition, value);
      const groupSize = value.mode === "per_contact" ? 1 : AUTOMATION_LIMITS.bootstrap_group_size;
      return { automation_id: automationId, version: rule.version, revision, use_draft: value.use_draft,
        grant_version: grant.version, member_count: snapshot.length, group_size: groupSize,
        group_count: Math.ceil(snapshot.length / groupSize), max_contacts: value.max_contacts,
        snapshot_frozen: false };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  private async selectSnapshot(tx: Parameters<Parameters<Database["transaction"]>[0]>[0], owner: string,
    automationId: string, revisionNumber: number, definition: ReturnType<typeof automationDefinitionSchema.parse>,
    value: Pick<ReturnType<typeof automationBootstrapPreviewSchema.parse>, "sources" | "search" | "max_contacts" | "exclude_previously_delivered">,
    reviewedIDs?: string[]) {
      const availableSources = value.sources.source_ids.length ? await tx.select({ id: sources.id }).from(sources)
        .innerJoin(epochs, and(eq(epochs.id, sources.epochId), eq(epochs.createdByUserId, owner), isNull(epochs.revokedAt)))
        .innerJoin(installations, and(eq(installations.id, epochs.installationId), eq(installations.createdByUserId, owner), isNull(installations.revokedAt)))
        .where(and(eq(sources.createdByUserId, owner), inArray(sources.id, value.sources.source_ids))) : [];
      if (value.sources.source_ids.length && availableSources.length !== value.sources.source_ids.length)
        throw new DataRequestError(404, "automation_source_not_found", "Source not found or revoked");
      const allowedSources = availableSources.map(source => source.id).filter(id => !definition.sources.source_ids.length || definition.sources.source_ids.includes(id));
      const search = `%${value.search.replace(/[\\%_]/g, "\\$&")}%`;
      const snapshot = await tx.select({ revisionId: contactRevisions.id }).from(contacts)
        .innerJoin(contactRevisions, and(eq(contactRevisions.contactId, contacts.id), eq(contactRevisions.createdByUserId, owner)))
        .innerJoin(scans, and(eq(scans.id, contactRevisions.scanId), eq(scans.createdByUserId, owner), eq(scans.generation, contacts.generation)))
        .innerJoin(sources, and(eq(sources.id, contacts.sourceId), eq(sources.createdByUserId, owner)))
        .innerJoin(epochs, and(eq(epochs.id, sources.epochId), eq(epochs.createdByUserId, owner), isNull(epochs.revokedAt)))
        .innerJoin(installations, and(eq(installations.id, epochs.installationId), eq(installations.createdByUserId, owner), isNull(installations.revokedAt)))
        .where(and(eq(contacts.createdByUserId, owner), eq(contacts.visible, true),
          reviewedIDs ? (reviewedIDs.length ? inArray(contactRevisions.id, reviewedIDs) : sql`false`) : undefined,
          value.sources.source_ids.length ? (allowedSources.length ? inArray(contacts.sourceId, allowedSources) : sql`false`)
            : definition.sources.source_ids.length ? inArray(contacts.sourceId, definition.sources.source_ids) : undefined,
          sql`${contactRevisions.observedAt} >= clock_timestamp() - ${definition.data_access.history_days} * interval '1 day'`,
          value.search ? ilike(sql`concat_ws(' ', ${contacts.fields}->>'given_name', ${contacts.fields}->>'family_name', ${contacts.fields}->>'organization', jsonb_path_query_array(${contacts.fields}, '$.phones[*].value')::text, jsonb_path_query_array(${contacts.fields}, '$.emails[*].value')::text)`, search) : undefined,
          value.exclude_previously_delivered ? sql`not exists (
            select 1 from automation_delivery d join data_domain_event e on e.id = d.domain_event_id and e.created_by_user_id = ${owner}
            join contact_revision cr on cr.id = e.revision_id and cr.created_by_user_id = ${owner}
            where d.created_by_user_id = ${owner} and d.automation_id = ${automationId} and d.revision = ${revisionNumber}
              and d.status in ('pending','admitted') and cr.contact_id = ${contacts.id})` : undefined,
          value.exclude_previously_delivered ? sql`not exists (
            select 1 from automation_bootstrap b join automation_bootstrap_member m on m.bootstrap_id = b.id and m.created_by_user_id = ${owner}
            join contact_revision cr on cr.id = m.contact_revision_id and cr.created_by_user_id = ${owner}
            where b.created_by_user_id = ${owner} and b.automation_id = ${automationId} and b.revision = ${revisionNumber}
              and cr.contact_id = ${contacts.id} and exists (select 1 from automation_bootstrap_group g
                where g.bootstrap_id = b.id and g.group_index = m.group_index and g.created_by_user_id = ${owner}
                  and g.status in ('pending','admitted')))` : undefined))
        .orderBy(asc(contacts.id)).limit(value.max_contacts);
      return snapshot;
  }

  async capture(owner: string, automationId: string, input: unknown) {
    return this.captureRequest(owner, automationId, input);
  }

  /** Caller persists this evidence with the fenced proposal in the same transaction. */
  async freezeReviewInTransaction(tx: Parameters<Parameters<Database["transaction"]>[0]>[0], owner: string, input: unknown): Promise<FrozenBootstrapReview> {
    const selection = parseAutomationInput(automationBootstrapReviewRequestSchema, input);
    const [boundary] = await tx.select().from(owners).where(eq(owners.createdByUserId, owner)).for("update");
    if (!boundary) throw new DataRequestError(404, "automation_not_found", "Automation not found");
    const [rule] = await tx.select().from(rules).where(and(eq(rules.id, selection.automation_id), eq(rules.createdByUserId, owner))).limit(1);
    if (!rule || rule.state === "deleted") throw new DataRequestError(404, "automation_not_found", "Automation not found");
    if (rule.version !== selection.expected_version) throw new DataRequestError(409, "automation_conflict", "Automation changed; request a new review");
    const [revision] = rule.activeRevision === null ? [] : await tx.select().from(revisions).where(and(
      eq(revisions.automationId, rule.id), eq(revisions.revision, rule.activeRevision), eq(revisions.createdByUserId, owner))).limit(1);
    if (!revision) throw new DataRequestError(409, "automation_not_activated", "Activate a saved revision first");
    const definition = parseAutomationInput(automationDefinitionSchema, revision.definition);
    const [grant] = await tx.select().from(grants).where(eq(grants.createdByUserId, owner));
    if (!grant || grant.version !== revision.grantVersion || definition.data_access.history_days > grant.historyDays ||
      !definition.data_access.scopes.every(scope => grant.scopes.includes(scope)))
      throw new DataRequestError(403, "data_permission_changed", "Approve current data permissions before reviewing existing contacts");
    const snapshot = await this.selectSnapshot(tx, owner, rule.id, revision.revision, definition, selection);
    return frozenBootstrapReviewSchema.parse({ owner, selection, revision: revision.revision,
      grant_version: grant.version, publication_boundary: boundary.publicationSequence, definition,
      contact_revision_ids: snapshot.map(member => member.revisionId) });
  }

  /** Human decision repository only: this method does not itself authorize approval. */
  async captureReviewedInTransaction(tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
    owner: string, evidence: FrozenBootstrapReview, idempotencyKey: string) {
    const reviewed = parseAutomationInput(frozenBootstrapReviewSchema, evidence);
    if (reviewed.owner !== owner) throw new DataRequestError(404, "bootstrap_review_not_found", "Review not found");
    const { automation_id, ...selection } = reviewed.selection;
    return this.captureInTransaction(tx, owner, automation_id, { ...selection, idempotency_key: idempotencyKey,
      acknowledge_existing_contacts: true, acknowledge_repeated_actions: !selection.exclude_previously_delivered }, undefined, reviewed);
  }

  async activateAndCapture(owner: string, automationId: string, activation: unknown, input: unknown) {
    return this.captureRequest(owner, automationId, input, parseAutomationInput(automationActivationSchema, activation));
  }

  private async captureRequest(owner: string, automationId: string, input: unknown,
    activation?: ReturnType<typeof automationActivationSchema.parse>) {
    return this.database.transaction(tx => this.captureInTransaction(tx, owner, automationId, input, activation));
  }

  /** Internal composition boundary: the authenticated decision and captured work share this transaction. */
  async captureInTransaction(tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
    owner: string, automationId: string, input: unknown,
    activation?: ReturnType<typeof automationActivationSchema.parse>, reviewed?: FrozenBootstrapReview) {
    const value = parseAutomationInput(automationBootstrapSchema, input);
    if (activation && activation.expected_version !== value.expected_version)
      throw new DataRequestError(400, "invalid_automation", "Activation and snapshot must refer to the same saved version");
    const requestIdentity = reviewed ? { ...value, reviewed } : activation ? { ...value, activation } : value;
    await tx.insert(owners).values({ createdByUserId: owner }).onConflictDoNothing();
    const [boundary] = await tx.select().from(owners).where(eq(owners.createdByUserId, owner)).for("update");
    let [rule] = await tx.select().from(rules).where(and(eq(rules.id, automationId), eq(rules.createdByUserId, owner))).limit(1);
    if (!rule) throw new DataRequestError(404, "automation_not_found", "Automation not found");
    const [existing] = await tx.select().from(requests).where(and(eq(requests.createdByUserId, owner), eq(requests.idempotencyKey, value.idempotency_key))).limit(1);
    if (existing) {
      if (existing.automationId !== automationId || !isDeepStrictEqual(existing.request, requestIdentity))
        throw new DataRequestError(409, "bootstrap_conflict", "This retry key already identifies a different request");
      return receipt(existing);
    }
    if (rule.state === "deleted") throw new DataRequestError(404, "automation_not_found", "Automation not found");
    if (rule.version !== value.expected_version) throw new DataRequestError(409, "automation_conflict", "Automation changed; reload before processing existing contacts");
    if (activation) {
      // Same transaction and owner lock as publication and snapshot membership.
      // Failure below rolls back activation as well as the snapshot.
      await new Automations(this.database).activateInTransaction(tx, owner, automationId, activation);
      [rule] = await tx.select().from(rules).where(and(eq(rules.id, automationId), eq(rules.createdByUserId, owner))).limit(1);
    }
    if (rule.activeRevision === null) throw new DataRequestError(409, "automation_not_activated", "Activate a saved revision first");
    const [revision] = await tx.select().from(revisions).where(and(eq(revisions.automationId, automationId), eq(revisions.revision, rule.activeRevision), eq(revisions.createdByUserId, owner))).limit(1);
    if (!revision) throw new DataRequestError(409, "automation_not_activated", "Active revision is unavailable");
    const definition = parseAutomationInput(automationDefinitionSchema, revision.definition);
    const [grant] = await tx.select().from(grants).where(eq(grants.createdByUserId, owner));
    if (!grant || grant.version !== revision.grantVersion || definition.data_access.history_days > grant.historyDays ||
      !definition.data_access.scopes.every(scope => grant.scopes.includes(scope)))
      throw new DataRequestError(403, "data_permission_changed", "Approve current data permissions before processing existing contacts");
    if (reviewed && (reviewed.owner !== owner || reviewed.selection.automation_id !== automationId ||
      reviewed.revision !== revision.revision || reviewed.grant_version !== grant.version ||
      !isDeepStrictEqual(reviewed.definition, definition)))
      throw new DataRequestError(409, "bootstrap_review_stale", "Automation or permissions changed; request a new review");
    const snapshot = await this.selectSnapshot(tx, owner, automationId, revision.revision, definition, value, reviewed?.contact_revision_ids);
    if (reviewed && !isDeepStrictEqual(snapshot.map(member => member.revisionId), reviewed.contact_revision_ids))
      throw new DataRequestError(409, "bootstrap_review_stale", "Contact eligibility changed; request a new review");
    const groupSize = value.mode === "per_contact" ? 1 : AUTOMATION_LIMITS.bootstrap_group_size;
    const [request] = await tx.insert(requests).values({ id: ulid(), automationId, revision: revision.revision,
      idempotencyKey: value.idempotency_key, request: requestIdentity, publicationBoundary: boundary.publicationSequence,
      memberCount: snapshot.length, groupSize, status: snapshot.length ? "pending" : "completed",
      latestStartAt: sql`clock_timestamp() + ${definition.latest_start_seconds} * interval '1 second'`, createdByUserId: owner }).returning();
    if (snapshot.length) await tx.insert(members).values(snapshot.map((member, ordinal) => ({ bootstrapId: request.id,
      ordinal, contactRevisionId: member.revisionId, groupIndex: Math.floor(ordinal / groupSize), createdByUserId: owner })));
    if (snapshot.length) await tx.insert(groups).values(Array.from({ length: Math.ceil(snapshot.length / groupSize) },
      (_, groupIndex) => ({ bootstrapId: request.id, groupIndex, createdByUserId: owner })));
    return receipt(request);
  }
}
