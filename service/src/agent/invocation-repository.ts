import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db, type Database } from "../db/client.js";
import { generateMessageClientId } from "../db/message-client-id.js";
import { agentInvocationTable as inv, agentInvocationActionTable as action, agentQuestionRequestTable as question, llmCallTable, llmCallItemTable, threadTable, budTable, messageTable } from "../db/schema.js";
import { canonicalBlockFromLedgerItem } from "../llm/provider-ledger.js";
import { parseStoredAskUserQuestionsRequest, validateAskUserQuestionsResponse, buildAskUserQuestionsToolResult } from "./user-question-contracts.js";
import { buildExecutedUserQuestionTool } from "./user-question-repository.js";
import { deferredToolResult } from "./continuation-results.js";
import { modelContextMessageCreatedAt, modelContextMessageVisible } from "./model-context-order.js";
import { checkAutomationPolicy } from "../personal-data/automation-policy.js";
import { dataOwnerStateTable, automationDeliveryTable, automationBootstrapGroupTable,
  dataAccessRequestTable as dataRequest, dataAppKeyTable as appKey, automationProposalTable as automationProposal, automationBootstrapProposalTable as bootstrapProposal } from "../db/schema.js";
import { AppKeys, APP_KEY_REQUEST_TOOL, serializeAppDataRequest, serializeAppKey } from "../personal-data/app-keys.js";

import { AutomationProposals, AUTOMATION_PROPOSAL_TOOL, serializeAutomationProposal } from "../personal-data/automation-proposals.js";

import { AutomationBootstrapProposals, BOOTSTRAP_PROPOSAL_TOOL, serializeBootstrapProposal } from "../personal-data/automation-bootstrap-proposals.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type InvocationAdmission = {
  owner: string; threadId: string; origin: "human" | "automation";
  idempotencyKey: string; clientId?: string; text: string;
  model: string; reasoningEffort: string; latestStartAt?: Date;
  metadata?: Record<string, unknown>; persistModelSelection?: boolean;
};
export type Invocation = typeof inv.$inferSelect;
export type InvocationLease = Pick<Invocation, "id" | "fence" | "workerId" | "createdByUserId">;
export class InvocationError extends Error {
  constructor(readonly code: string) { super(code); }
}

// No worker is enabled here. The legacy runner must be drained before callers
// switch to this repository and its dispatch fence at every execution boundary.
export class InvocationRepository {
  constructor(private readonly database: Database = db, private readonly automationConcurrencyPerBud = 1) {
    if (!Number.isInteger(automationConcurrencyPerBud) || automationConcurrencyPerBud < 1 || automationConcurrencyPerBud > 32) {
      throw new InvocationError("invalid_automation_concurrency");
    }
  }

  async findByTurn(owner: string, threadId: string, turnId: string) {
    const [row] = await this.database.select().from(inv).where(and(eq(inv.createdByUserId, owner),
      eq(inv.threadId, threadId), eq(inv.turnId, turnId))).limit(1);
    return row ?? null;
  }

  async findByInput(owner: string, threadId: string, messageId: string) {
    const [row] = await this.database.select().from(inv).where(and(eq(inv.createdByUserId, owner),
      eq(inv.threadId, threadId), eq(inv.inputMessageId, messageId))).limit(1);
    return row ?? null;
  }

  async listForThread(owner: string, threadId: string) {
    return this.database.select().from(inv).where(and(eq(inv.createdByUserId, owner), eq(inv.threadId, threadId)))
      .orderBy(desc(inv.reservesThread), desc(inv.createdAt), desc(inv.id)).limit(50);
  }

  async pendingQuestionsForThread(owner: string, threadId: string) {
    return this.database.select({ request_id: question.questionRequestId, turn_id: question.turnId,
      client_id: question.clientId, call_id: question.callId, request: question.request, created_at: question.createdAt })
      .from(question).innerJoin(inv, and(eq(inv.turnId, question.turnId), eq(inv.threadId, question.threadId),
        eq(inv.createdByUserId, question.createdByUserId)))
      .where(and(eq(question.createdByUserId, owner), eq(question.threadId, threadId), eq(question.status, "pending"),
        eq(inv.reservesThread, true))).orderBy(asc(question.createdAt)).limit(20);
  }

  async pendingDataRequestsForThread(owner: string, threadId: string) {
    const rows = await this.database.select({ request: dataRequest, turnId: inv.turnId, evidence: action.evidence })
      .from(dataRequest).innerJoin(inv, and(eq(inv.id, dataRequest.invocationId),
        eq(inv.threadId, dataRequest.threadId), eq(inv.createdByUserId, dataRequest.createdByUserId)))
      .innerJoin(action, and(eq(action.invocationId, inv.id), eq(action.callId, dataRequest.callId),
        eq(action.createdByUserId, dataRequest.createdByUserId), eq(action.kind, APP_KEY_REQUEST_TOOL),
        eq(action.status, "waiting_for_user"), sql`${action.evidence}->>'data_access_request_id' = ${dataRequest.id}`))
      .where(and(eq(dataRequest.createdByUserId, owner), eq(dataRequest.threadId, threadId),
        eq(dataRequest.status, "pending"), eq(inv.reservesThread, true), isNull(inv.cancelRequestedAt)))
      .orderBy(asc(dataRequest.createdAt), asc(dataRequest.id)).limit(20);
    return rows.map(row => ({ request_id: row.request.id, turn_id: row.turnId,
      client_id: typeof row.evidence?.tool_client_id === "string" ? row.evidence.tool_client_id : null,
      call_id: row.request.callId, request: serializeAppDataRequest(row.request), created_at: row.request.createdAt }));
  }

  async pendingAutomationProposalsForThread(owner: string, threadId: string) {
    const rows = await this.database.select({ proposal: automationProposal, turnId: inv.turnId, evidence: action.evidence })
      .from(automationProposal).innerJoin(inv, and(eq(inv.id, automationProposal.invocationId),
        eq(inv.threadId, automationProposal.threadId), eq(inv.createdByUserId, automationProposal.createdByUserId)))
      .innerJoin(action, and(eq(action.invocationId, inv.id), eq(action.callId, automationProposal.callId),
        eq(action.createdByUserId, owner), eq(action.kind, AUTOMATION_PROPOSAL_TOOL), eq(action.status, "waiting_for_user"),
        sql`${action.evidence}->>'automation_proposal_id' = ${automationProposal.id}`))
      .where(and(eq(automationProposal.createdByUserId, owner), eq(automationProposal.threadId, threadId),
        eq(automationProposal.status, "pending"), eq(inv.reservesThread, true), isNull(inv.cancelRequestedAt)))
      .orderBy(asc(automationProposal.createdAt), asc(automationProposal.id)).limit(20);
    return rows.map(row => ({ proposal_id: row.proposal.id, turn_id: row.turnId,
      client_id: typeof row.evidence?.tool_client_id === "string" ? row.evidence.tool_client_id : null,
      call_id: row.proposal.callId, proposal: serializeAutomationProposal(row.proposal), created_at: row.proposal.createdAt }));
  }

  async pendingBootstrapProposalsForThread(owner: string, threadId: string) {
    const rows = await this.database.select({ proposal: bootstrapProposal, turnId: inv.turnId, evidence: action.evidence })
      .from(bootstrapProposal).innerJoin(inv, and(eq(inv.id, bootstrapProposal.invocationId),
        eq(inv.threadId, bootstrapProposal.threadId), eq(inv.createdByUserId, bootstrapProposal.createdByUserId)))
      .innerJoin(action, and(eq(action.invocationId, inv.id), eq(action.callId, bootstrapProposal.callId),
        eq(action.createdByUserId, owner), eq(action.kind, BOOTSTRAP_PROPOSAL_TOOL), eq(action.status, "waiting_for_user"),
        sql`${action.evidence}->>'bootstrap_proposal_id' = ${bootstrapProposal.id}`))
      .where(and(eq(bootstrapProposal.createdByUserId, owner), eq(bootstrapProposal.threadId, threadId),
        eq(bootstrapProposal.status, "pending"), eq(inv.reservesThread, true), isNull(inv.cancelRequestedAt)))
      .orderBy(asc(bootstrapProposal.createdAt), asc(bootstrapProposal.id)).limit(20);
    return rows.map(row => ({ proposal_id: row.proposal.id, turn_id: row.turnId,
      client_id: typeof row.evidence?.tool_client_id === "string" ? row.evidence.tool_client_id : null,
      call_id: row.proposal.callId, proposal: serializeBootstrapProposal(row.proposal), created_at: row.proposal.createdAt }));
  }

  async admit(input: InvocationAdmission) {
    return this.database.transaction(tx => this.admitInTransaction(tx, input));
  }

  /** Caller owns the transaction so delivery, thread and input commit together. */
  async admitInTransaction(tx: Transaction, input: InvocationAdmission) {
    if (!input.owner || !input.idempotencyKey || input.idempotencyKey.length > 256 || !input.text || input.text.length > 100_000) {
      throw new InvocationError("invalid_admission");
    }
    const [thread] = await tx.select({ threadId: threadTable.threadId, budId: threadTable.budId })
      .from(threadTable).innerJoin(budTable, eq(budTable.budId, threadTable.budId))
      .where(and(eq(threadTable.threadId, input.threadId), eq(threadTable.createdByUserId, input.owner),
        eq(budTable.createdByUserId, input.owner), isNull(threadTable.deletedAt)))
      .for("update", { of: threadTable }).limit(1);
    if (!thread) throw new InvocationError("thread_not_found");
    const [existing] = await tx.select().from(inv)
      .where(and(eq(inv.createdByUserId, input.owner), eq(inv.idempotencyKey, input.idempotencyKey))).limit(1);
    if (existing) {
      const [message] = await tx.select().from(messageTable).where(eq(messageTable.messageId, existing.inputMessageId));
      if (existing.threadId !== input.threadId || existing.origin !== input.origin || existing.model !== input.model ||
        existing.reasoningEffort !== input.reasoningEffort || message?.content !== input.text ||
        (input.clientId && message.clientId !== input.clientId)) throw new InvocationError("admission_conflict");
      return { invocation: existing, message, duplicate: true };
    }
    const id = ulid();
    const [message] = await tx.insert(messageTable).values({
      clientId: input.clientId ?? generateMessageClientId(), threadId: thread.threadId,
      role: input.origin === "human" ? "user" : "system",
      displayRole: input.origin === "human" ? "User" : "Automation",
      content: input.text, createdByUserId: input.owner,
      metadata: { ...input.metadata, invocation_id: id, origin: input.origin, model_context_at: null },
    }).returning();
    if (!message) throw new InvocationError("message_insert_failed");
    const [invocation] = await tx.insert(inv).values({
      id, turnId: ulid(), threadId: thread.threadId, budId: thread.budId, inputMessageId: message.messageId,
      origin: input.origin, idempotencyKey: input.idempotencyKey, model: input.model,
      reasoningEffort: input.reasoningEffort, latestStartAt: input.latestStartAt,
      createdByUserId: input.owner,
    }).returning();
    if (!invocation) throw new InvocationError("invocation_insert_failed");
    await tx.update(threadTable).set({ lastActivityAt: sql`clock_timestamp()`,
      ...(input.persistModelSelection ? { modelId: input.model, reasoningEffort: input.reasoningEffort } : {}),
      messageCount: sql`${threadTable.messageCount} + 1`, lastMessagePreview: input.text.slice(0, 360) })
      .where(eq(threadTable.threadId, thread.threadId));
    return { invocation, message, duplicate: false };
  }

  async claim(workerId: string, ownerFilter?: string): Promise<Invocation | null> {
    if (!workerId) throw new InvocationError("worker_required");
    return this.database.transaction(async tx => {
      // Lock the thread, not just its queued item: two pending items in the
      // same thread must not be independently leased by different workers.
      const [candidate] = await tx.select({ id: inv.id }).from(inv)
        .innerJoin(threadTable, eq(threadTable.threadId, inv.threadId))
        .innerJoin(budTable, eq(budTable.budId, inv.budId))
        .where(and(
          sql`(${inv.status} in ('pending','retry_wait','waiting_for_bud','waiting_for_model') or
            (${inv.status} = 'waiting_for_user' and (exists (
              select 1 from agent_invocation_action a join agent_question_request q
                on q.question_request_id = a.evidence->>'question_request_id'
              where a.invocation_id = agent_invocation.id and a.status = 'waiting_for_user'
                and q.status = 'answered' and q.turn_id = ${inv.turnId}
                and q.thread_id = ${inv.threadId} and q.created_by_user_id = ${inv.createdByUserId}
            ) or exists (
              select 1 from agent_invocation_action a join data_access_request r
                on r.id = a.evidence->>'data_access_request_id'
              where a.invocation_id = agent_invocation.id and a.status = 'waiting_for_user'
                and a.kind = ${APP_KEY_REQUEST_TOOL} and r.status <> 'pending'
                and r.invocation_id = ${inv.id} and r.call_id = a.call_id
                and r.thread_id = ${inv.threadId} and r.created_by_user_id = ${inv.createdByUserId}
            ) or exists (
              select 1 from agent_invocation_action a join automation_proposal p
                on p.id = a.evidence->>'automation_proposal_id'
              where a.invocation_id = agent_invocation.id and a.status = 'waiting_for_user'
                and a.kind = ${AUTOMATION_PROPOSAL_TOOL} and p.status <> 'pending'
                and p.invocation_id = ${inv.id} and p.call_id = a.call_id
                and p.thread_id = ${inv.threadId} and p.created_by_user_id = ${inv.createdByUserId}
            ) or exists (
              select 1 from agent_invocation_action a join automation_bootstrap_proposal p
                on p.id = a.evidence->>'bootstrap_proposal_id'
              where a.invocation_id = agent_invocation.id and a.status = 'waiting_for_user'
                and a.kind = ${BOOTSTRAP_PROPOSAL_TOOL} and p.status <> 'pending'
                and p.invocation_id = ${inv.id} and p.call_id = a.call_id
                and p.thread_id = ${inv.threadId} and p.created_by_user_id = ${inv.createdByUserId}
            ))))`,
          sql`${inv.nextAttemptAt} <= clock_timestamp()`,
          isNull(inv.cancelRequestedAt), isNull(threadTable.deletedAt),
          eq(threadTable.createdByUserId, inv.createdByUserId), eq(budTable.createdByUserId, inv.createdByUserId),
          ownerFilter ? eq(inv.createdByUserId, ownerFilter) : undefined,
          sql`(${inv.origin} = 'human' or ${inv.reservesThread} or
            (select count(*) from agent_invocation capacity where capacity.bud_id = ${inv.budId}
              and capacity.origin = 'automation' and capacity.reserves_thread) < ${this.automationConcurrencyPerBud})`,
          sql`not exists (select 1 from agent_invocation active where active.thread_id = ${inv.threadId}
            and active.id <> ${inv.id}
            and active.reserves_thread)`,
        )).orderBy(sql`case when ${inv.origin} = 'human' then 0 else 1 end`, asc(inv.createdAt), asc(inv.id))
        .for("update", { of: threadTable, skipLocked: true }).limit(1);
      if (!candidate) return null;
      // A statement after the thread lock sees reservations committed since the
      // candidate snapshot. This avoids relying on catching unique violations.
      const [selected] = await tx.select({ invocation: inv,
        expired: sql<boolean>`${inv.latestStartAt} is not null and ${inv.latestStartAt} <= clock_timestamp()
          and not exists (select 1 from agent_invocation_action a where a.invocation_id = agent_invocation.id and a.status = 'waiting_for_user')` })
        .from(inv).where(eq(inv.id, candidate.id));
      const current = selected?.invocation;
      if (!current || current.cancelRequestedAt || !["pending", "retry_wait", "waiting_for_bud", "waiting_for_model", "waiting_for_user"].includes(current.status)) return null;
      const [active] = await tx.select({ id: inv.id }).from(inv).where(and(eq(inv.threadId, current.threadId),
        sql`${inv.id} <> ${current.id}`,
        eq(inv.reservesThread, true))).limit(1);
      if (active) return null;
      if (selected.expired && current.status !== "waiting_for_user") {
        await tx.update(inv).set({ status: "expired", reservesThread: false, outcomeCode: "latest_start_elapsed", updatedAt: sql`clock_timestamp()` }).where(eq(inv.id, current.id));
        return null;
      }
      if (current.origin === "automation" && !current.reservesThread) {
        // Serialize capacity acquisition across threads/processes. A try-lock
        // keeps this transaction short; the next poll retries contention.
        const lock = await tx.execute<{ acquired: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${'bud-automation-cap:' + current.budId}, 0)) as acquired`);
        if (!lock.rows[0]?.acquired) return null;
        // This statement gets a fresh READ COMMITTED snapshot after the lock.
        const [capacity] = await tx.select({ used: sql<number>`count(*)::integer` }).from(inv)
          .where(and(eq(inv.budId, current.budId), eq(inv.origin, "automation"), eq(inv.reservesThread, true)));
        if (!capacity || capacity.used >= this.automationConcurrencyPerBud) return null;
      }
      const [leased] = await tx.update(inv).set({ status: "leased", reservesThread: true, workerId,
        fence: sql`${inv.fence} + 1`, attempt: sql`${inv.attempt} + 1`,
        leaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`, updatedAt: sql`clock_timestamp()` })
        .where(eq(inv.id, current.id)).returning();
      if (leased) {
        await tx.update(action).set({ fence: leased.fence }).where(and(eq(action.invocationId, current.id), eq(action.status, "waiting_for_user")));
      }
      return leased ?? null;
    });
  }

  private async lockedLease(tx: Transaction, lease: InvocationLease, statuses = ["leased", "running"], allowCancellation = false) {
    const [row] = await tx.select().from(inv).where(and(eq(inv.id, lease.id), eq(inv.createdByUserId, lease.createdByUserId),
      eq(inv.fence, lease.fence), lease.workerId ? eq(inv.workerId, lease.workerId) : sql`false`,
      sql`${inv.leaseExpiresAt} > clock_timestamp()`)).for("update").limit(1);
    if (!row || !statuses.includes(row.status)) throw new InvocationError("lease_lost");
    if (row.cancelRequestedAt && !allowCancellation) throw new InvocationError("invocation_canceled");
    const [owned] = await tx.select({ id: threadTable.threadId }).from(threadTable)
      .innerJoin(budTable, eq(budTable.budId, threadTable.budId))
      .where(and(eq(threadTable.threadId, row.threadId), eq(threadTable.createdByUserId, row.createdByUserId),
        eq(budTable.createdByUserId, row.createdByUserId), isNull(threadTable.deletedAt))).limit(1);
    if (!owned) throw new InvocationError("invocation_authority_lost");
    return row;
  }

  async heartbeat(lease: InvocationLease) {
    return this.database.transaction(async tx => {
      await this.lockedLease(tx, lease);
      await tx.update(inv).set({ leaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`, updatedAt: sql`clock_timestamp()` }).where(eq(inv.id, lease.id));
    });
  }

  async start(lease: InvocationLease) {
    return this.database.transaction(async tx => {
      // Match rule/grant mutation lock order before locking the invocation.
      // A pause committed first must prevent the final start transition.
      await tx.select({ owner: dataOwnerStateTable.createdByUserId }).from(dataOwnerStateTable)
        .where(eq(dataOwnerStateTable.createdByUserId, lease.createdByUserId)).for("update");
      const row = await this.lockedLease(tx, lease, ["leased"]);
      if (row.origin === "automation") {
        const [delivery] = await tx.select({ id: automationDeliveryTable.id }).from(automationDeliveryTable)
          .where(and(eq(automationDeliveryTable.invocationId, row.id), eq(automationDeliveryTable.createdByUserId, row.createdByUserId))).limit(1);
        const [group] = delivery ? [] : await tx.select({ id: automationBootstrapGroupTable.bootstrapId }).from(automationBootstrapGroupTable)
          .where(and(eq(automationBootstrapGroupTable.invocationId, row.id), eq(automationBootstrapGroupTable.createdByUserId, row.createdByUserId))).limit(1);
        // Generic repository callers may use other automation origins. The
        // production executor separately requires a supported delivery policy.
        if ((delivery || group) && await checkAutomationPolicy(row, true, tx) !== "ready") throw new InvocationError("automation_paused");
      }
      const [clock] = await tx.select({ expired: sql<boolean>`${inv.latestStartAt} is not null and ${inv.latestStartAt} <= clock_timestamp()
        and not exists (select 1 from agent_invocation_action a where a.invocation_id = agent_invocation.id and a.status = 'waiting_for_user')` })
        .from(inv).where(eq(inv.id, row.id));
      if (clock?.expired) throw new InvocationError("latest_start_elapsed");
      const [contextClock] = await tx.select({ at: sql<Date>`greatest(date_trunc('milliseconds', clock_timestamp()),
        date_trunc('milliseconds', max(${modelContextMessageCreatedAt})) + interval '1 millisecond')`.mapWith(messageTable.createdAt) })
        .from(messageTable).where(and(eq(messageTable.threadId, row.threadId), modelContextMessageVisible));
      // Strictly advance at the timestamp precision used by replay/checkpoints,
      // including when human priority reverses two inputs admitted in one tick.
      await tx.update(messageTable).set({ metadata: sql`coalesce(${messageTable.metadata}, '{}'::jsonb) ||
        jsonb_build_object('model_context_at', coalesce(${messageTable.metadata}->>'model_context_at',
          ${contextClock.at.toISOString()}::text))` })
        .where(and(eq(messageTable.messageId, row.inputMessageId), eq(messageTable.createdByUserId, row.createdByUserId)));
      await tx.update(inv).set({ status: "running", updatedAt: sql`clock_timestamp()` }).where(eq(inv.id, lease.id));
    });
  }

  async defer(lease: InvocationLease, status: "waiting_for_bud" | "waiting_for_model" | "retry_wait", delaySeconds = 15) {
    if (!Number.isInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 300) throw new InvocationError("invalid_retry_delay");
    return this.database.transaction(async tx => {
      await this.lockedLease(tx, lease, ["leased"]);
      const [continuation] = await tx.select({ id: action.id }).from(action)
        .where(and(eq(action.invocationId, lease.id), eq(action.status, "waiting_for_user"))).limit(1);
      await tx.update(inv).set({ status, reservesThread: Boolean(continuation), workerId: null, leaseExpiresAt: null,
        nextAttemptAt: sql`clock_timestamp() + ${delaySeconds} * interval '1 second'`,
        updatedAt: sql`clock_timestamp()` }).where(eq(inv.id, lease.id));
    });
  }

  async recordAction(lease: InvocationLease, callId: string, kind: string) {
    return this.database.transaction(async tx => {
      const row = await this.lockedLease(tx, lease, ["running"]);
      const [intent] = await tx.insert(action).values({ id: ulid(), invocationId: row.id,
        callId, kind, fence: row.fence, createdByUserId: row.createdByUserId }).onConflictDoNothing().returning();
      // Retrying an existing intent never authorizes a second dispatch.
      if (!intent) throw new InvocationError("action_already_recorded");
      return intent;
    });
  }

  async completeAction(lease: InvocationLease, callId: string, evidence: Record<string, unknown>) {
    return this.database.transaction(async tx => {
      await this.lockedLease(tx, lease, ["running"]);
      const [result] = await tx.update(action).set({ status: "completed", evidence, completedAt: sql`clock_timestamp()` })
        .where(and(eq(action.invocationId, lease.id), eq(action.fence, lease.fence), eq(action.callId, callId), sql`${action.status} in ('intent','waiting_for_user')`)).returning();
      if (!result) throw new InvocationError("action_not_pending");
    });
  }

  async finish(lease: InvocationLease, status: "succeeded" | "failed" | "needs_review", outcomeCode: string) {
    return this.database.transaction(async tx => {
      const current = await this.lockedLease(tx, lease, ["leased", "running"], true);
      const [pending] = await tx.select({ id: action.id }).from(action)
        .where(and(eq(action.invocationId, lease.id), sql`${action.status} in ('intent','waiting_for_user')`)).limit(1);
      await tx.update(inv).set({ status: current.cancelRequestedAt ? "canceled" : pending ? "needs_review" : status,
        reservesThread: !current.cancelRequestedAt && (Boolean(pending) || status === "needs_review"),
        outcomeCode: current.cancelRequestedAt ? "user_canceled" : pending ? "unresolved_action_intent" : outcomeCode,
        workerId: null, leaseExpiresAt: null, updatedAt: sql`clock_timestamp()` }).where(eq(inv.id, lease.id));
    });
  }

  async requestCancel(owner: string, invocationId: string) {
    return this.database.transaction(tx => this.requestCancelInTransaction(tx, owner, invocationId));
  }

  async requestCancelInTransaction(tx: Transaction, owner: string, invocationId: string) {
      const [row] = await tx.select().from(inv).where(and(eq(inv.id, invocationId), eq(inv.createdByUserId, owner)))
        .for("update").limit(1);
      if (!row) throw new InvocationError("invocation_not_found");
      if (["succeeded", "failed", "canceled", "expired"].includes(row.status)) return row;
      // A running worker must acknowledge cancellation before its reservation
      // can be released. Fenced lease recovery also honors this explicit decision;
      // neither path claims that already dispatched terminal commands stopped.
      const running = row.status === "running";
      {
        await tx.update(question).set({ status: "canceled", updatedAt: sql`clock_timestamp()` })
          .where(and(eq(question.threadId, row.threadId), eq(question.turnId, row.turnId),
            eq(question.createdByUserId, owner), eq(question.status, "pending")));
        await tx.update(dataRequest).set({ status: "canceled", version: sql`${dataRequest.version} + 1`, updatedAt: sql`clock_timestamp()` })
          .where(and(eq(dataRequest.invocationId, row.id), eq(dataRequest.createdByUserId, owner), eq(dataRequest.status, "pending")));
      }
      await tx.update(automationProposal).set({ status: "canceled", version: sql`${automationProposal.version} + 1`, updatedAt: sql`clock_timestamp()` })
        .where(and(eq(automationProposal.invocationId, row.id), eq(automationProposal.createdByUserId, owner), eq(automationProposal.status, "pending")));
      await tx.update(bootstrapProposal).set({ status: "canceled", version: sql`${bootstrapProposal.version} + 1`, updatedAt: sql`clock_timestamp()` })
        .where(and(eq(bootstrapProposal.invocationId, row.id), eq(bootstrapProposal.createdByUserId, owner), eq(bootstrapProposal.status, "pending")));
      const [updated] = await tx.update(inv).set({
        cancelRequestedAt: row.cancelRequestedAt ?? new Date(), canceledByUserId: owner,
        ...(running ? {} : { status: "canceled" as const, reservesThread: false, workerId: null, leaseExpiresAt: null,
          fence: sql`${inv.fence} + 1`, outcomeCode: "user_canceled" }),
        updatedAt: sql`clock_timestamp()`,
      }).where(eq(inv.id, row.id)).returning();
      return updated;
  }

  async parkQuestion(lease: InvocationLease, callId: string, questionRequestId: string) {
    return this.database.transaction(async tx => {
      const row = await this.lockedLease(tx, lease, ["running"]);
      const [request] = await tx.select().from(question).where(and(
        eq(question.questionRequestId, questionRequestId), eq(question.threadId, row.threadId),
        eq(question.turnId, row.turnId), eq(question.callId, callId), eq(question.createdByUserId, row.createdByUserId),
      )).for("update").limit(1);
      if (!request || !["pending", "answered"].includes(request.status)) throw new InvocationError("question_not_available");
      const [intent] = await tx.update(action).set({ status: "waiting_for_user", evidence: { question_request_id: questionRequestId } })
        .where(and(eq(action.invocationId, row.id), eq(action.callId, callId), eq(action.fence, lease.fence),
          eq(action.kind, "ask_user_questions"), eq(action.status, "intent"))).returning();
      if (!intent) throw new InvocationError("question_action_not_pending");
      await tx.update(inv).set({ status: "waiting_for_user", reservesThread: true, workerId: null, leaseExpiresAt: null,
        fence: sql`${inv.fence} + 1`, updatedAt: sql`clock_timestamp()` }).where(eq(inv.id, row.id));
    });
  }

  async parkAppDataRequest(lease: InvocationLease, callId: string, clientId: string, input: unknown) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId))
      throw new InvocationError("invalid_tool_client_id");
    return this.database.transaction(async tx => {
      // Request creation obtains owner then invocation locks, matching approval.
      // No request can commit without its durable parked action/reservation.
      const request = await new AppKeys(this.database).requestInTransaction(tx, {
        owner: lease.createdByUserId, invocationId: lease.id, workerId: lease.workerId ?? "",
        fence: lease.fence, callId,
      }, input);
      const row = await this.lockedLease(tx, lease, ["running"]);
      const [intent] = await tx.update(action).set({ status: "waiting_for_user",
        evidence: { data_access_request_id: request.request_id, tool_client_id: clientId } })
        .where(and(eq(action.invocationId, row.id), eq(action.callId, callId), eq(action.fence, lease.fence),
          eq(action.kind, APP_KEY_REQUEST_TOOL), eq(action.status, "intent"))).returning();
      if (!intent) throw new InvocationError("app_data_action_not_pending");
      await tx.update(inv).set({ status: "waiting_for_user", reservesThread: true, workerId: null, leaseExpiresAt: null,
        fence: sql`${inv.fence} + 1`, updatedAt: sql`clock_timestamp()` }).where(eq(inv.id, row.id));
      return request;
    });
  }

  async parkAutomationProposal(lease: InvocationLease, callId: string, clientId: string, input: unknown) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId))
      throw new InvocationError("invalid_tool_client_id");
    return this.database.transaction(async tx => {
      const proposal = await new AutomationProposals(this.database).requestInTransaction(tx, {
        owner: lease.createdByUserId, invocationId: lease.id, workerId: lease.workerId ?? "", fence: lease.fence, callId,
      }, input);
      const row = await this.lockedLease(tx, lease, ["running"]);
      const [intent] = await tx.update(action).set({ status: "waiting_for_user",
        evidence: { automation_proposal_id: proposal.proposal_id, tool_client_id: clientId } })
        .where(and(eq(action.invocationId, row.id), eq(action.callId, callId), eq(action.fence, lease.fence),
          eq(action.kind, AUTOMATION_PROPOSAL_TOOL), eq(action.status, "intent"))).returning();
      if (!intent) throw new InvocationError("automation_proposal_action_not_pending");
      await tx.update(inv).set({ status: "waiting_for_user", reservesThread: true, workerId: null, leaseExpiresAt: null,
        fence: sql`${inv.fence} + 1`, updatedAt: sql`clock_timestamp()` }).where(eq(inv.id, row.id));
      return proposal;
    });
  }

  async parkBootstrapProposal(lease: InvocationLease, callId: string, clientId: string, input: unknown) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId))
      throw new InvocationError("invalid_tool_client_id");
    return this.database.transaction(async tx => {
      const result = await new AutomationBootstrapProposals(this.database).requestInTransaction(tx, {
        owner: lease.createdByUserId, invocationId: lease.id, workerId: lease.workerId ?? "", fence: lease.fence, callId,
      }, input);
      if (result.kind === "no_work") return result;
      const row = await this.lockedLease(tx, lease, ["running"]);
      const [intent] = await tx.update(action).set({ status: "waiting_for_user", fence: lease.fence + 1,
        evidence: { bootstrap_proposal_id: result.proposal.proposal_id, tool_client_id: clientId } })
        .where(and(eq(action.invocationId, row.id), eq(action.callId, callId), eq(action.fence, lease.fence),
          eq(action.kind, BOOTSTRAP_PROPOSAL_TOOL), eq(action.status, "intent"))).returning();
      if (!intent) throw new InvocationError("bootstrap_proposal_action_not_pending");
      await tx.update(inv).set({ status: "waiting_for_user", reservesThread: true, workerId: null, leaseExpiresAt: null,
        fence: sql`${inv.fence} + 1`, updatedAt: sql`clock_timestamp()` }).where(eq(inv.id, row.id));
      return result;
    });
  }

  async abandonReviewed(owner: string, threadId: string, invocationId: string, expectedUpdatedAt: string) {
    return this.database.transaction(async tx => {
      // Match claim's thread-first lock order so queued work cannot acquire the
      // reservation until both the owner's decision and its audit commit.
      const [thread] = await tx.select({ id: threadTable.threadId }).from(threadTable)
        .innerJoin(budTable, eq(budTable.budId, threadTable.budId))
        .innerJoin(inv, eq(inv.threadId, threadTable.threadId))
        .where(and(eq(threadTable.threadId, threadId), eq(inv.id, invocationId),
          eq(inv.createdByUserId, owner), eq(threadTable.createdByUserId, owner),
          eq(budTable.createdByUserId, owner), isNull(threadTable.deletedAt)))
        .for("update", { of: threadTable }).limit(1);
      if (!thread) throw new InvocationError("invocation_not_found");
      const [row] = await tx.select().from(inv).where(and(eq(inv.id, invocationId), eq(inv.createdByUserId, owner)))
        .for("update").limit(1);
      if (row.status === "canceled" && row.outcomeCode === "user_abandoned_after_review") return row;
      if (row.status !== "needs_review" || row.updatedAt.toISOString() !== expectedUpdatedAt) {
        throw new InvocationError("invocation_review_conflict");
      }
      await tx.insert(action).values({ id: ulid(), invocationId: row.id, callId: "owner-review-" + ulid(),
        kind: "owner_review", status: "completed", fence: row.fence,
        evidence: { decision: "abandon", acknowledged_possible_effects: true, prior_outcome_code: row.outcomeCode },
        completedAt: sql`clock_timestamp()`, createdByUserId: owner });
      await tx.update(question).set({ status: "canceled", updatedAt: sql`clock_timestamp()` })
        .where(and(eq(question.threadId, threadId), eq(question.turnId, row.turnId),
          eq(question.createdByUserId, owner), eq(question.status, "pending")));
      await tx.update(dataRequest).set({ status: "canceled", version: sql`${dataRequest.version} + 1`, updatedAt: sql`clock_timestamp()` })
        .where(and(eq(dataRequest.invocationId, row.id), eq(dataRequest.createdByUserId, owner), eq(dataRequest.status, "pending")));
      await tx.update(automationProposal).set({ status: "canceled", version: sql`${automationProposal.version} + 1`, updatedAt: sql`clock_timestamp()` })
        .where(and(eq(automationProposal.invocationId, row.id), eq(automationProposal.createdByUserId, owner), eq(automationProposal.status, "pending")));
      await tx.update(bootstrapProposal).set({ status: "canceled", version: sql`${bootstrapProposal.version} + 1`, updatedAt: sql`clock_timestamp()` })
        .where(and(eq(bootstrapProposal.invocationId, row.id), eq(bootstrapProposal.createdByUserId, owner), eq(bootstrapProposal.status, "pending")));
      const [updated] = await tx.update(inv).set({ status: "canceled", reservesThread: false,
        canceledByUserId: owner, cancelRequestedAt: row.cancelRequestedAt ?? sql`clock_timestamp()`,
        outcomeCode: "user_abandoned_after_review", fence: sql`${inv.fence} + 1`,
        workerId: null, leaseExpiresAt: null, updatedAt: sql`clock_timestamp()` })
        .where(eq(inv.id, row.id)).returning();
      return updated;
    });
  }

  async prepareQuestionContinuation(lease: InvocationLease) {
    return this.database.transaction(async tx => {
      const current = await this.lockedLease(tx, lease, ["running"]);
      const waiting = await tx.select().from(action).where(and(eq(action.invocationId, current.id), eq(action.status, "waiting_for_user")));
      const messages: (typeof messageTable.$inferSelect)[] = [];
      for (const pending of waiting) {
        let answer: { payload: Record<string, unknown>; clientId: string; createdAt: Date; answeredAt: Date; evidence: Record<string, unknown> };
        if (pending.kind === BOOTSTRAP_PROPOSAL_TOOL) {
          const proposalId = pending.evidence?.bootstrap_proposal_id;
          const clientId = pending.evidence?.tool_client_id;
          if (typeof proposalId !== "string" || typeof clientId !== "string") throw new InvocationError("bootstrap_proposal_reference_missing");
          const [stored] = await tx.select().from(bootstrapProposal).where(and(eq(bootstrapProposal.id, proposalId),
            eq(bootstrapProposal.invocationId, current.id), eq(bootstrapProposal.threadId, current.threadId),
            eq(bootstrapProposal.callId, pending.callId), eq(bootstrapProposal.createdByUserId, current.createdByUserId),
            sql`${bootstrapProposal.status} <> 'pending'`));
          if (!stored) throw new InvocationError("bootstrap_proposal_decision_missing");
          const approved = stored.status === "approved";
          answer = { clientId, createdAt: stored.createdAt, answeredAt: stored.decidedAt ?? stored.updatedAt,
            evidence: { bootstrap_proposal_id: proposalId, continuation_restored: true },
            payload: { tool: BOOTSTRAP_PROPOSAL_TOOL, call_id: pending.callId, kind: "existing_contact_review", ok: approved,
              proposal: serializeBootstrapProposal(stored),
              summary: approved ? "The user approved processing the reviewed contacts. Capture is complete; use the bootstrap receipt to check progress. Do not process them again."
                : "Existing-contact processing was not approved. Do not silently replace the review or start that work." } };
        } else if (pending.kind === AUTOMATION_PROPOSAL_TOOL) {
          const proposalId = pending.evidence?.automation_proposal_id;
          const clientId = pending.evidence?.tool_client_id;
          if (typeof proposalId !== "string" || typeof clientId !== "string") throw new InvocationError("automation_proposal_reference_missing");
          const [stored] = await tx.select().from(automationProposal).where(and(eq(automationProposal.id, proposalId),
            eq(automationProposal.invocationId, current.id), eq(automationProposal.threadId, current.threadId),
            eq(automationProposal.callId, pending.callId), eq(automationProposal.createdByUserId, current.createdByUserId),
            sql`${automationProposal.status} <> 'pending'`));
          if (!stored) throw new InvocationError("automation_proposal_decision_missing");
          const approved = stored.status === "approved";
          answer = { clientId, createdAt: stored.createdAt, answeredAt: stored.decidedAt ?? stored.updatedAt,
            evidence: { automation_proposal_id: proposalId, continuation_restored: true },
            payload: { tool: AUTOMATION_PROPOSAL_TOOL, call_id: pending.callId, kind: "automation_proposal", ok: approved,
              proposal: serializeAutomationProposal(stored),
              summary: approved ? "The user approved this automation revision. Activation is complete; do not activate it again."
                : "The automation proposal was not approved. Do not silently replace it or activate standing work." } };
        } else if (pending.kind === APP_KEY_REQUEST_TOOL) {
          const requestId = pending.evidence?.data_access_request_id;
          const clientId = pending.evidence?.tool_client_id;
          if (typeof requestId !== "string" || typeof clientId !== "string") throw new InvocationError("app_data_reference_missing");
          const [stored] = await tx.select({ request: dataRequest, key: appKey }).from(dataRequest)
            .leftJoin(appKey, and(eq(appKey.requestId, dataRequest.id), eq(appKey.createdByUserId, current.createdByUserId)))
            .where(and(eq(dataRequest.id, requestId), eq(dataRequest.invocationId, current.id),
              eq(dataRequest.threadId, current.threadId), eq(dataRequest.callId, pending.callId),
              eq(dataRequest.createdByUserId, current.createdByUserId), sql`${dataRequest.status} <> 'pending'`));
          if (!stored) throw new InvocationError("app_data_decision_missing");
          const approved = stored.request.status === "approved" && !!stored.key && ["handoff_pending", "installed"].includes(stored.key.status);
          answer = { clientId, createdAt: stored.request.createdAt, answeredAt: stored.request.decidedAt ?? stored.request.updatedAt,
            evidence: { data_access_request_id: requestId, continuation_restored: true },
            payload: { tool: APP_KEY_REQUEST_TOOL, call_id: pending.callId, kind: "app_data_permission", ok: approved,
              request: serializeAppDataRequest(stored.request), key: stored.key ? serializeAppKey(stored.key) : null,
              summary: approved ? "App data access approved; finish backend setup using public request/key metadata. The credential is delivered only through the backend helper."
                : "App data access was not granted or is no longer usable. Do not silently create a replacement request." } };
        } else {
        const requestId = pending.evidence?.question_request_id;
        if (typeof requestId !== "string") throw new InvocationError("question_reference_missing");
        const [stored] = await tx.select().from(question).where(and(eq(question.questionRequestId, requestId),
          eq(question.threadId, current.threadId), eq(question.turnId, current.turnId),
          eq(question.createdByUserId, current.createdByUserId), eq(question.status, "answered"))).limit(1);
        if (!stored) throw new InvocationError("question_answer_missing");
        const request = parseStoredAskUserQuestionsRequest(stored.request);
        const response = validateAskUserQuestionsResponse(stored.clientResponse, request);
        const result = buildAskUserQuestionsToolResult(request, response, requestId);
        const execution = buildExecutedUserQuestionTool({ directive: { type: "tool_call", tool: "ask_user_questions", callId: pending.callId, request }, toolResult: result });
        answer = { payload: execution.payload, clientId: stored.clientId, createdAt: stored.createdAt,
          answeredAt: stored.answeredAt ?? new Date(), evidence: { question_request_id: requestId, continuation_restored: true } };
        }
        const calls = await tx.select({ callId: llmCallTable.llmCallId, sequence: llmCallItemTable.sequence })
          .from(llmCallTable).innerJoin(llmCallItemTable, eq(llmCallItemTable.llmCallId, llmCallTable.llmCallId))
          .where(and(eq(llmCallTable.threadId, current.threadId), eq(llmCallTable.turnId, current.turnId),
            eq(llmCallTable.createdByUserId, current.createdByUserId), eq(llmCallItemTable.toolCallId, pending.callId),
            eq(llmCallItemTable.createdByUserId, current.createdByUserId),
            eq(llmCallItemTable.direction, "output"))).limit(2);
        if (calls.length !== 1) throw new InvocationError("question_provider_call_ambiguous");
        const call = calls[0];
        const items = await tx.select().from(llmCallItemTable).where(and(eq(llmCallItemTable.llmCallId, call.callId),
          eq(llmCallItemTable.threadId, current.threadId), eq(llmCallItemTable.createdByUserId, current.createdByUserId))).orderBy(asc(llmCallItemTable.sequence));
        let sequence = Math.max(-1, ...items.map(item => item.sequence)) + 1;
        const output = items.filter(item => item.direction === "output" && item.kind === "tool_use" && item.sequence >= call.sequence);
        for (const item of output) {
          const block = canonicalBlockFromLedgerItem(item);
          if (block?.type !== "tool_use") throw new InvocationError("continuation_tool_invalid");
          if (items.some(value => value.direction === "input" && value.toolCallId === block.id)) continue;
          const isQuestion = block.id === pending.callId;
          if (!isQuestion) {
            const [dispatched] = await tx.select({ id: action.id }).from(action)
              .where(and(eq(action.invocationId, current.id), eq(action.callId, block.id))).limit(1);
            if (dispatched) throw new InvocationError("continuation_action_ambiguous");
          }
          const payload = isQuestion ? answer.payload : deferredToolResult(block, (pending.kind === AUTOMATION_PROPOSAL_TOOL || pending.kind === BOOTSTRAP_PROPOSAL_TOOL) ? "automation" : pending.kind === APP_KEY_REQUEST_TOOL ? "permission" : "question");
          const content = JSON.stringify(payload);
          const finishedAt = isQuestion ? answer.answeredAt : new Date();
          const startedAt = isQuestion ? answer.createdAt : finishedAt;
          const [message] = await tx.insert(messageTable).values({
            clientId: isQuestion ? answer.clientId : generateMessageClientId(), threadId: current.threadId,
            role: "tool", displayRole: "Tool", content, createdByUserId: current.createdByUserId,
            metadata: { turn_id: current.turnId, invocation_id: current.id, continuation: true,
              llm_call_id: call.callId, call_id: block.id,
              started_at: startedAt.toISOString(), finished_at: finishedAt.toISOString(),
              duration_ms: Math.max(0, finishedAt.getTime() - startedAt.getTime()), duration_source: "service_wall_clock",
              model: current.model, reasoning_effort: current.reasoningEffort },
          }).returning();
          await tx.insert(llmCallItemTable).values({ llmCallItemId: ulid(), llmCallId: call.callId,
            threadId: current.threadId, direction: "input", role: "user", kind: "tool_result", sequence: sequence++,
            toolCallId: block.id, text: content, canonicalPayload: { type: "tool_result", tool_use_id: block.id, content },
            providerPayload: payload, visibility: "tool", messageId: message.messageId, createdByUserId: current.createdByUserId });
          messages.push(message);
        }
        await tx.update(action).set({ status: "completed", completedAt: sql`clock_timestamp()`,
          evidence: answer.evidence }).where(eq(action.id, pending.id));
      }
      return messages;
    });
  }

  async expireQueued(ownerFilter?: string) {
    return this.database.transaction(async tx => {
      const rows = await tx.select({ id: inv.id }).from(inv).where(and(
        sql`${inv.status} in ('pending','retry_wait','waiting_for_bud','waiting_for_model')`,
        sql`${inv.latestStartAt} <= clock_timestamp()`,
        sql`not exists (select 1 from agent_invocation_action a where a.invocation_id = agent_invocation.id and a.status = 'waiting_for_user')`,
        ownerFilter ? eq(inv.createdByUserId, ownerFilter) : undefined,
      )).for("update", { skipLocked: true }).limit(100);
      for (const row of rows) {
        await tx.update(inv).set({ status: "expired", reservesThread: false, outcomeCode: "latest_start_elapsed", updatedAt: sql`clock_timestamp()` })
          .where(eq(inv.id, row.id));
      }
      return rows.length;
    });
  }

  async recoverExpired(ownerFilter?: string) {
    return this.database.transaction(async tx => {
      const rows = await tx.select().from(inv).where(and(sql`${inv.status} in ('leased','running')`,
        sql`${inv.leaseExpiresAt} <= clock_timestamp()`, ownerFilter ? eq(inv.createdByUserId, ownerFilter) : undefined))
        .for("update", { skipLocked: true }).limit(100);
      for (const row of rows) {
        const [continuation] = await tx.select({ id: action.id }).from(action)
          .where(and(eq(action.invocationId, row.id), eq(action.status, "waiting_for_user"))).limit(1);
        await tx.update(inv).set({ reservesThread: !row.cancelRequestedAt && (row.status === "running" || Boolean(continuation)),
          status: row.cancelRequestedAt ? "canceled" : row.status === "leased" ? "retry_wait" : "needs_review",
          outcomeCode: row.cancelRequestedAt ? "user_canceled" : row.status === "leased" ? "preflight_lease_expired" : "execution_lease_expired",
          fence: sql`${inv.fence} + 1`, workerId: null, leaseExpiresAt: null,
          nextAttemptAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` }).where(eq(inv.id, row.id));
      }
      return rows.length;
    });
  }
}
