import { DataRequestError } from "./contracts.js";
import { automationModelResolver, type AutomationModelResolution } from "./automation-model.js";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db, type Database } from "../db/client.js";
import { InvocationRepository } from "../agent/invocation-repository.js";
import { automationBootstrapGroupTable as groups, automationBootstrapTable as requests,
  automationBootstrapMemberTable as members, automationTable as rules, automationRevisionTable as revisions,
  dataOwnerStateTable as owners, agentDataGrantTable as grants, contactRevisionTable as evidence,
  contactTable as contacts, contactSourceTable as sources, dataCollectionEpochTable as epochs,
  dataInstallationTable as installations, threadTable as threads, budTable as buds } from "../db/schema.js";
import { automationDefinitionSchema, AUTOMATION_LIMITS, parseAutomationInput } from "./automation-contracts.js";
import { automationUsage } from "./automation-admission.js";

/** One frozen group becomes one invocation in the same owner-locked transaction. */
export class BootstrapAdmission {
  constructor(private readonly database: Database = db) {}

  async admitNext(ownerFilter?: string): Promise<boolean> {
    const [candidate] = await this.database.select({ owner: groups.createdByUserId }).from(groups)
      .where(and(eq(groups.status, "pending"), sql`${groups.nextAttemptAt} <= clock_timestamp()`,
        ownerFilter ? eq(groups.createdByUserId, ownerFilter) : undefined))
      .orderBy(asc(groups.nextAttemptAt), asc(groups.bootstrapId), asc(groups.groupIndex)).limit(1);
    if (!candidate) return false;
    return this.database.transaction(async tx => {
      const owner = candidate.owner;
      const [locked] = await tx.select().from(owners).where(eq(owners.createdByUserId, owner)).for("update", { skipLocked: true });
      if (!locked) return false;
      const [group] = await tx.select().from(groups).where(and(eq(groups.createdByUserId, owner),
        eq(groups.status, "pending"), sql`${groups.nextAttemptAt} <= clock_timestamp()`))
        .orderBy(asc(groups.nextAttemptAt), asc(groups.bootstrapId), asc(groups.groupIndex)).limit(1).for("update");
      if (!group) return false;
      const key = and(eq(groups.createdByUserId, owner), eq(groups.bootstrapId, group.bootstrapId), eq(groups.groupIndex, group.groupIndex));
      const finish = async (status: "failed" | "expired" | "canceled", outcomeCode: string) => {
        await tx.update(groups).set({ status, outcomeCode, updatedAt: sql`clock_timestamp()` }).where(key);
        return true;
      };
      const wait = async (outcomeCode: string) => {
        await tx.update(groups).set({ outcomeCode, nextAttemptAt: sql`clock_timestamp() + interval '15 seconds'`,
          updatedAt: sql`clock_timestamp()` }).where(key);
        return true;
      };
      const [policy] = await tx.select({ request: requests, rule: rules, revision: revisions,
        expired: sql<boolean>`${requests.latestStartAt} <= clock_timestamp()` }).from(requests)
        .innerJoin(rules, and(eq(rules.id, requests.automationId), eq(rules.createdByUserId, owner)))
        .innerJoin(revisions, and(eq(revisions.automationId, rules.id), eq(revisions.revision, requests.revision), eq(revisions.createdByUserId, owner)))
        .where(and(eq(requests.id, group.bootstrapId), eq(requests.createdByUserId, owner))).limit(1);
      if (!policy || policy.rule.state === "deleted") return finish("failed", "automation_unavailable");
      if (policy.request.status === "canceled") return finish("canceled", "user_canceled");
      if (policy.request.status !== "pending") return finish("failed", "bootstrap_unavailable");
      if (policy.expired) return finish("expired", "latest_start_elapsed");
      const definition = parseAutomationInput(automationDefinitionSchema, policy.revision.definition);
      const [grant] = await tx.select().from(grants).where(eq(grants.createdByUserId, owner));
      if (!grant || grant.version !== policy.revision.grantVersion || definition.data_access.history_days > grant.historyDays ||
        !definition.data_access.scopes.every(scope => grant.scopes.includes(scope))) return finish("failed", "data_permission_changed");
      const [bud] = await tx.select({ id: buds.budId }).from(buds).where(and(eq(buds.budId, definition.bud_id), eq(buds.createdByUserId, owner))).limit(1);
      if (!bud) return finish("failed", "automation_target_unavailable");
      if (definition.target.mode === "existing_thread") {
        const [thread] = await tx.select({ id: threads.threadId }).from(threads).where(and(eq(threads.threadId, definition.target.thread_id),
          eq(threads.budId, definition.bud_id), eq(threads.createdByUserId, owner), isNull(threads.deletedAt))).limit(1);
        if (!thread) return finish("failed", "automation_target_unavailable");
      }
      const selected = await tx.select({ contactId: evidence.contactId, revisionId: evidence.id, observedAt: evidence.observedAt }).from(members)
        .innerJoin(evidence, and(eq(evidence.id, members.contactRevisionId), eq(evidence.createdByUserId, owner)))
        .innerJoin(contacts, and(eq(contacts.id, evidence.contactId), eq(contacts.createdByUserId, owner), eq(contacts.visible, true)))
        .innerJoin(sources, and(eq(sources.id, contacts.sourceId), eq(sources.createdByUserId, owner)))
        .innerJoin(epochs, and(eq(epochs.id, sources.epochId), eq(epochs.createdByUserId, owner), isNull(epochs.revokedAt)))
        .innerJoin(installations, and(eq(installations.id, epochs.installationId), eq(installations.createdByUserId, owner), isNull(installations.revokedAt)))
        .where(and(eq(members.bootstrapId, group.bootstrapId), eq(members.groupIndex, group.groupIndex), eq(members.createdByUserId, owner),
          sql`${evidence.observedAt} >= clock_timestamp() - ${definition.data_access.history_days} * interval '1 day'`))
        .orderBy(asc(members.ordinal)).limit(AUTOMATION_LIMITS.bootstrap_group_size);
      const expected = Math.min(policy.request.groupSize, policy.request.memberCount - group.groupIndex * policy.request.groupSize);
      if (expected <= 0 || selected.length !== expected) return finish("failed", "contact_evidence_unavailable");
      if (policy.rule.state !== "enabled") return wait("automation_paused");
      const usage = await automationUsage(tx, owner, policy.rule.id);
      if (usage.ownerCount >= AUTOMATION_LIMITS.invocations_per_owner_day || usage.ruleCount >= definition.max_invocations_per_day)
        return wait("daily_work_limit");
      let modelResolution: AutomationModelResolution;
      try { modelResolution = (await automationModelResolver(tx, owner, [definition]))(definition); }
      catch (error) {
        if (error instanceof DataRequestError) return finish("failed", error.code);
        throw error;
      }
      let threadId: string;
      if (definition.target.mode === "existing_thread") threadId = definition.target.thread_id;
      else {
        const [thread] = await tx.insert(threads).values({ budId: definition.bud_id, title: definition.name,
          modelId: modelResolution.model, reasoningEffort: modelResolution.reasoning_effort, createdByUserId: owner }).returning();
        threadId = thread.threadId;
      }
      const admitted = await new InvocationRepository(this.database).admitInTransaction(tx, { owner, threadId, origin: "automation",
        idempotencyKey: `automation-bootstrap:${group.bootstrapId}:${group.groupIndex}`, model: modelResolution.model,
        reasoningEffort: modelResolution.reasoning_effort, latestStartAt: policy.request.latestStartAt,
        text: `Automation: ${definition.name}\n\n${definition.instruction}\n\nExplicit processing of existing contacts; these are not new-contact notifications.\n` +
          selected.map(contact => `Contact ID: ${contact.contactId}; frozen revision ID: ${contact.revisionId}; observed at: ${contact.observedAt.toISOString()}`).join("\n") +
          "\nQuery available evidence, label uncertainty, and do not repeat completed actions during later enrichment.",
        metadata: { model_resolution: modelResolution, automation_id: policy.rule.id, automation_revision: policy.request.revision,
          bootstrap_id: group.bootstrapId, bootstrap_group_index: group.groupIndex,
          contact_revision_ids: selected.map(contact => contact.revisionId), grant_version: grant.version },
      });
      await tx.update(groups).set({ status: "admitted", invocationId: admitted.invocation.id,
        outcomeCode: null, updatedAt: sql`clock_timestamp()` }).where(key);
      return true;
    });
  }
}
