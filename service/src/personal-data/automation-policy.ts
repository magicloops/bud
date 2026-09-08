import { and, eq, isNull, sql } from "drizzle-orm";
import { db, type Database } from "../db/client.js";
import { automationTable as rules, automationRevisionTable as revisions, automationDeliveryTable as deliveries,
  automationBootstrapTable as requests, automationBootstrapGroupTable as groups, automationBootstrapMemberTable as members,
  agentDataGrantTable as grants, dataDomainEventTable as events, contactRevisionTable as evidence,
  contactTable as contacts, contactSourceTable as sources, dataCollectionEpochTable as epochs,
  dataInstallationTable as installations, agentInvocationTable as invocations } from "../db/schema.js";
import { InvocationError, type Invocation } from "../agent/invocation-repository.js";
import { automationDefinitionSchema, parseAutomationInput } from "./automation-contracts.js";
import type { AgentDataCeiling } from "./agent-queries.js";
import { DataRequestError } from "./contracts.js";

export async function loadAutomationDataCeiling(threadId: string, owner: string, turnId?: string,
  database: Pick<Database, "select"> = db): Promise<AgentDataCeiling | undefined> {
  if (!turnId) return undefined;
  const [current] = await database.select({ invocation: invocations,
    leased: sql<boolean>`${invocations.leaseExpiresAt} > clock_timestamp()` }).from(invocations)
    .where(and(eq(invocations.threadId, threadId), eq(invocations.turnId, turnId), eq(invocations.createdByUserId, owner))).limit(1);
  if (!current || current.invocation.origin === "human") return undefined;
  if (current.invocation.status !== "running" || !current.leased || current.invocation.cancelRequestedAt)
    throw new DataRequestError(403, "automation_not_running", "Automation execution is no longer authorized");
  try { await checkAutomationPolicy(current.invocation, false, database); }
  catch { throw new DataRequestError(403, "automation_authority_lost", "Automation data permission is no longer available"); }
  let [revision] = await database.select({ definition: revisions.definition, grantVersion: revisions.grantVersion,
    automationId: revisions.automationId, revision: revisions.revision }).from(deliveries)
    .innerJoin(revisions, and(eq(revisions.automationId, deliveries.automationId), eq(revisions.revision, deliveries.revision), eq(revisions.createdByUserId, owner)))
    .where(and(eq(deliveries.invocationId, current.invocation.id), eq(deliveries.createdByUserId, owner))).limit(1);
  if (!revision) {
    [revision] = await database.select({ definition: revisions.definition, grantVersion: revisions.grantVersion,
      automationId: revisions.automationId, revision: revisions.revision }).from(groups)
      .innerJoin(requests, and(eq(requests.id, groups.bootstrapId), eq(requests.createdByUserId, owner)))
      .innerJoin(revisions, and(eq(revisions.automationId, requests.automationId), eq(revisions.revision, requests.revision), eq(revisions.createdByUserId, owner)))
      .where(and(eq(groups.invocationId, current.invocation.id), eq(groups.createdByUserId, owner))).limit(1);
  }
  if (!revision) throw new DataRequestError(403, "automation_authority_lost", "Automation data permission is no longer available");
  const definition = parseAutomationInput(automationDefinitionSchema, revision.definition);
  return { scopes: definition.data_access.scopes, historyDays: definition.data_access.history_days,
    grantVersion: revision.grantVersion, binding: `${current.invocation.id}:${current.invocation.fence}:${revision.automationId}:${revision.revision}` };
}

/** Current authority for a persisted delivery; caller separately checks thread/Bud ownership. */
export async function checkAutomationPolicy(invocation: Invocation, checkPause = true, database: Pick<Database, "select"> = db): Promise<"ready" | "retry_wait"> {
  if (invocation.origin !== "automation") return "ready";
  const owner = invocation.createdByUserId;
  let [policy] = await database.select({ state: rules.state, definition: revisions.definition,
    grantVersion: revisions.grantVersion, scopes: grants.scopes, historyDays: grants.historyDays,
    currentGrantVersion: grants.version }).from(deliveries)
    .innerJoin(rules, and(eq(rules.id, deliveries.automationId), eq(rules.createdByUserId, owner)))
    .innerJoin(revisions, and(eq(revisions.automationId, rules.id), eq(revisions.revision, deliveries.revision), eq(revisions.createdByUserId, owner)))
    .innerJoin(grants, eq(grants.createdByUserId, owner))
    .innerJoin(events, and(eq(events.id, deliveries.domainEventId), eq(events.createdByUserId, owner)))
    .innerJoin(evidence, and(eq(evidence.id, events.revisionId), eq(evidence.createdByUserId, owner)))
    .innerJoin(contacts, and(eq(contacts.id, evidence.contactId), eq(contacts.createdByUserId, owner)))
    .innerJoin(sources, and(eq(sources.id, contacts.sourceId), eq(sources.createdByUserId, owner)))
    .innerJoin(epochs, and(eq(epochs.id, sources.epochId), eq(epochs.createdByUserId, owner), isNull(epochs.revokedAt)))
    .innerJoin(installations, and(eq(installations.id, epochs.installationId), eq(installations.createdByUserId, owner), isNull(installations.revokedAt)))
    .where(and(eq(deliveries.invocationId, invocation.id), eq(deliveries.createdByUserId, owner), eq(deliveries.status, "admitted"))).limit(1);
  if (!policy) policy = await bootstrapPolicy(invocation, database);
  if (!policy || policy.state === "deleted") throw new InvocationError("automation_authority_lost");
  const definition = parseAutomationInput(automationDefinitionSchema, policy.definition);
  if (definition.bud_id !== invocation.budId || definition.model !== invocation.model ||
    definition.reasoning_effort !== invocation.reasoningEffort ||
    (definition.target.mode === "existing_thread" && definition.target.thread_id !== invocation.threadId)) {
    throw new InvocationError("automation_target_changed");
  }
  if (policy.grantVersion !== policy.currentGrantVersion || definition.data_access.history_days > policy.historyDays ||
    !definition.data_access.scopes.every(scope => policy.scopes.includes(scope))) throw new InvocationError("data_permission_changed");
  // Pause gates starts/continuations. Already-running work follows explicit
  // cancel-active semantics; revocation still applies at every checkpoint.
  return checkPause && policy.state !== "enabled" ? "retry_wait" : "ready";
}

async function bootstrapPolicy(invocation: Invocation, database: Pick<Database, "select">) {
  const owner = invocation.createdByUserId;
  const [policy] = await database.select({ state: rules.state, definition: revisions.definition,
    grantVersion: revisions.grantVersion, scopes: grants.scopes, historyDays: grants.historyDays,
    currentGrantVersion: grants.version, requestStatus: requests.status,
    bootstrapId: requests.id, groupIndex: groups.groupIndex, memberCount: requests.memberCount,
    groupSize: requests.groupSize }).from(groups)
    .innerJoin(requests, and(eq(requests.id, groups.bootstrapId), eq(requests.createdByUserId, owner)))
    .innerJoin(rules, and(eq(rules.id, requests.automationId), eq(rules.createdByUserId, owner)))
    .innerJoin(revisions, and(eq(revisions.automationId, rules.id), eq(revisions.revision, requests.revision), eq(revisions.createdByUserId, owner)))
    .innerJoin(grants, eq(grants.createdByUserId, owner))
    .where(and(eq(groups.invocationId, invocation.id), eq(groups.createdByUserId, owner), eq(groups.status, "admitted"))).limit(1);
  if (!policy || policy.requestStatus !== "pending") throw new InvocationError("automation_authority_lost");
  const definition = parseAutomationInput(automationDefinitionSchema, policy.definition);
  const [available] = await database.select({ count: sql<number>`count(*)::integer` }).from(members)
    .innerJoin(evidence, and(eq(evidence.id, members.contactRevisionId), eq(evidence.createdByUserId, owner)))
    .innerJoin(contacts, and(eq(contacts.id, evidence.contactId), eq(contacts.createdByUserId, owner), eq(contacts.visible, true)))
    .innerJoin(sources, and(eq(sources.id, contacts.sourceId), eq(sources.createdByUserId, owner)))
    .innerJoin(epochs, and(eq(epochs.id, sources.epochId), eq(epochs.createdByUserId, owner), isNull(epochs.revokedAt)))
    .innerJoin(installations, and(eq(installations.id, epochs.installationId), eq(installations.createdByUserId, owner), isNull(installations.revokedAt)))
    .where(and(eq(members.bootstrapId, policy.bootstrapId), eq(members.groupIndex, policy.groupIndex), eq(members.createdByUserId, owner),
      sql`${evidence.observedAt} >= clock_timestamp() - ${definition.data_access.history_days} * interval '1 day'`));
  const expected = Math.min(policy.groupSize, policy.memberCount - policy.groupIndex * policy.groupSize);
  if (expected <= 0 || available.count !== expected) throw new InvocationError("contact_evidence_unavailable");
  return policy;
}
