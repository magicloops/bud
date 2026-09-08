import { and, eq, isNull, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { db, type Database } from "../db/client.js";
import { agentInvocationTable as invocations, agentInvocationActionTable as actions,
  dataOwnerStateTable as owners, agentDataGrantTable as grants, threadTable as threads, budTable as buds } from "../db/schema.js";
import { Automations } from "./automations.js";
import { parseAutomationToolInput } from "./automation-tool-contracts.js";
import { resolveAgentAutomationDraft } from "./automation-proposal-contracts.js";
import type { AutomationDefinition } from "./automation-contracts.js";
import type { AutomationProposalContext } from "./automation-proposals.js";
import { DataRequestError } from "./contracts.js";

type Mutation = "automations_create_draft" | "automations_update_draft" | "automations_pause";
type Read = "automations_list" | "automations_get" | "automations_history";

/** Service-only management authority, inherited from the active human turn. */
export class AutomationManagement {
  constructor(private readonly database: Database = db) {}

  private async assertReadAuthority(context: AutomationProposalContext, name: Read) {
    const [row] = await this.database.select({ origin: invocations.origin }).from(invocations)
      .innerJoin(threads, and(eq(threads.threadId, invocations.threadId), eq(threads.createdByUserId, context.owner), isNull(threads.deletedAt)))
      .innerJoin(buds, and(eq(buds.budId, invocations.budId), eq(buds.createdByUserId, context.owner)))
      .innerJoin(actions, and(eq(actions.invocationId, invocations.id), eq(actions.createdByUserId, context.owner),
        eq(actions.callId, context.callId), eq(actions.kind, name), eq(actions.status, "intent"), eq(actions.fence, context.fence)))
      .where(and(eq(invocations.id, context.invocationId), eq(invocations.createdByUserId, context.owner),
        eq(invocations.workerId, context.workerId), eq(invocations.fence, context.fence), eq(invocations.status, "running"),
        isNull(invocations.cancelRequestedAt), sql`${invocations.leaseExpiresAt} > clock_timestamp()`));
    if (!row) throw new DataRequestError(409, "invocation_unavailable", "Invocation no longer owns this operation");
    if (row.origin !== "human") throw new DataRequestError(403, "automation_management_origin_denied", "Automated runs cannot manage standing work");
  }

  async read(context: AutomationProposalContext, name: Read, input: unknown) {
    const args = parseAutomationToolInput(name, input);
    await this.assertReadAuthority(context, name);
    const automations = new Automations(this.database);
    let result: Record<string, unknown>;
    if (name === "automations_list") result = await automations.list(context.owner);
    else if (name === "automations_get") {
      const value = parseAutomationToolInput(name, args);
      result = await automations.get(context.owner, value.automation_id);
    } else {
      const value = parseAutomationToolInput(name, args);
      result = await automations.history(context.owner, value.automation_id, { limit: value.limit, cursor: value.cursor });
    }
    // A canceled/fenced/deleted conversation cannot receive a late read result.
    await this.assertReadAuthority(context, name);
    return result;
  }

  async mutate(context: AutomationProposalContext, name: Mutation, input: unknown) {
    const args = parseAutomationToolInput(name, input);
    return this.database.transaction(async tx => {
      await tx.insert(owners).values({ createdByUserId: context.owner }).onConflictDoNothing();
      await tx.select().from(owners).where(eq(owners.createdByUserId, context.owner)).for("update");
      const [row] = await tx.select({ invocation: invocations }).from(invocations)
        .innerJoin(threads, and(eq(threads.threadId, invocations.threadId), eq(threads.createdByUserId, context.owner), isNull(threads.deletedAt)))
        .innerJoin(buds, and(eq(buds.budId, invocations.budId), eq(buds.createdByUserId, context.owner)))
        .where(and(eq(invocations.id, context.invocationId), eq(invocations.createdByUserId, context.owner),
          eq(invocations.workerId, context.workerId), eq(invocations.fence, context.fence), eq(invocations.status, "running"),
          isNull(invocations.cancelRequestedAt), sql`${invocations.leaseExpiresAt} > clock_timestamp()`)).for("update", { of: invocations });
      if (!row) throw new DataRequestError(409, "invocation_unavailable", "Invocation no longer owns this operation");
      if (row.invocation.origin !== "human") throw new DataRequestError(403, "automation_management_origin_denied", "Automated runs cannot manage standing work");
      const [action] = await tx.select().from(actions).where(and(eq(actions.invocationId, context.invocationId), eq(actions.callId, context.callId),
        eq(actions.createdByUserId, context.owner), eq(actions.fence, context.fence), eq(actions.kind, name), eq(actions.status, "intent")));
      if (!action) throw new DataRequestError(409, "automation_management_intent_required", "A current management tool intent is required");
      if (action.evidence?.automation_management_receipt) {
        if (!isDeepStrictEqual(action.evidence.args, args)) throw new DataRequestError(409, "automation_management_conflict", "The recorded operation has different arguments");
        return action.evidence.result as Record<string, unknown>;
      }
      const automations = new Automations(this.database);
      let result: Record<string, unknown>;
      if (name === "automations_create_draft") {
        const [grant] = await tx.select().from(grants).where(eq(grants.createdByUserId, context.owner));
        // A draft does not grant access. Absent consent still allows drafting;
        // the request-activation step requires the human's data permission.
        const defaults: AutomationDefinition = { event_type: "contact.added", name: "", instruction: "",
          sources: { source_ids: [] }, bud_id: row.invocation.budId, model: row.invocation.model,
          reasoning_effort: row.invocation.reasoningEffort as AutomationDefinition["reasoning_effort"], target: { mode: "existing_thread", thread_id: row.invocation.threadId },
          data_access: { scopes: ["contacts.read"], history_days: Math.min(grant?.historyDays ?? 30, 30) },
          latest_start_seconds: 86400, max_invocations_per_day: 10 };
        const definition = resolveAgentAutomationDraft(args, defaults);
        try {
          result = await automations.createInTransaction(tx, context.owner, definition);
        } catch (error) {
          if (error instanceof DataRequestError && error.code === "invalid_automation_model") {
            throw new DataRequestError(400, error.code,
              `Unsupported automation selection: model=${definition.model}, reasoning_effort=${definition.reasoning_effort}. ` +
              `Omit model and reasoning_effort (or use null) to inherit this chat's model=${defaults.model}, reasoning_effort=${defaults.reasoning_effort}. ` +
              "Preserve explicit user choices; if an override was requested, select a supported model/reasoning combination instead of silently substituting.");
          }
          throw error;
        }
      } else if (name === "automations_update_draft") {
        const value = parseAutomationToolInput(name, args);
        result = await automations.updateInTransaction(tx, context.owner, value.automation_id,
          { expected_version: value.expected_version, definition: value.definition });
      } else {
        const value = parseAutomationToolInput(name, args);
        result = await automations.pauseInTransaction(tx, context.owner, value.automation_id,
          { expected_version: value.expected_version, cancel_pending: value.cancel_pending, cancel_active: value.cancel_active });
      }
      // Keep the intent unresolved until transcript persistence. A crash retains
      // the receipt for review; a same-lease retry returns it without mutating.
      // Normalize dates to JSON before both storage and first result delivery.
      const receipt = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
      await tx.update(actions).set({ evidence: { automation_management_receipt: true, args, result: receipt } })
        .where(eq(actions.id, action.id));
      return receipt;
    });
  }
}
