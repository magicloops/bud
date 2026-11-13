import { and, eq, isNull } from "drizzle-orm";
import { db, type Database } from "../db/client.js";
import { agentInvocationActionTable as actions, agentInvocationTable as invocations, budTable, threadTable } from "../db/schema.js";
import { GOOGLE_SERVICES, GoogleError, type GoogleService } from "./config.js";

export type GoogleApprovalProposal = {
  connection_id: string; service: GoogleService; tool_name: string; arguments_json: string;
  operation_id: string; account_subject: string; account_email: string; grant_id: string;
};
export type GoogleApproval = GoogleApprovalProposal & {
  approval_id: string; thread_id: string; invocation_id: string;
  status: "pending" | "approved" | "rejected" | "expired" | "consumed";
  created_at: string; expires_at: string; decided_at?: string; consumed_at?: string;
};

/** Only this projection may reach a browser or model. Grant identities are internal. */
export function serializeGoogleApproval(value: GoogleApproval) {
  return { approval_id: value.approval_id, thread_id: value.thread_id, service: value.service,
    tool_name: value.tool_name, arguments_json: value.arguments_json, account_email: value.account_email,
    status: value.status, expires_at: value.expires_at, created_at: value.created_at, decided_at: value.decided_at };
}

export function canonicalGoogleArguments(value: unknown): string {
  const sorted = (input: unknown): unknown => Array.isArray(input) ? input.map(sorted)
    : input && typeof input === "object" ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sorted(item)])) : input;
  return JSON.stringify(sorted(value));
}

export function parseGoogleApproval(value: unknown): GoogleApproval {
  if (!value || typeof value !== "object") throw new GoogleError("google_not_found");
  const approval = value as GoogleApproval;
  if (!["approval_id", "thread_id", "invocation_id", "connection_id", "service", "tool_name", "arguments_json",
    "operation_id", "account_subject", "account_email", "grant_id", "created_at", "expires_at"].every(key =>
      typeof Reflect.get(approval, key) === "string") || !GOOGLE_SERVICES.includes(approval.service)
    || !Number.isFinite(Date.parse(approval.created_at)) || !Number.isFinite(Date.parse(approval.expires_at))
    || !["pending", "approved", "rejected", "expired", "consumed"].includes(approval.status)) {
    throw new GoogleError("google_not_found");
  }
  return approval;
}

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type ApprovalIdentity = Pick<GoogleApprovalProposal, "account_subject" | "grant_id">;
export class GoogleApprovals {
  constructor(private readonly database: Database = db) {}

  private async owned(tx: Transaction, owner: string, id: string) {
    // Match the invocation repository's lock order so cancellation and consumption serialize.
    const [invocation] = await tx.select({ invocation: invocations }).from(actions)
      .innerJoin(invocations, and(eq(invocations.id, actions.invocationId), eq(invocations.createdByUserId, owner)))
      .innerJoin(threadTable, and(eq(threadTable.threadId, invocations.threadId), eq(threadTable.createdByUserId, owner)))
      .innerJoin(budTable, and(eq(budTable.budId, threadTable.budId), eq(budTable.createdByUserId, owner)))
      .where(and(eq(actions.id, id), eq(actions.createdByUserId, owner), eq(actions.kind, "google_call"), isNull(threadTable.deletedAt)))
      .for("update", { of: invocations }).limit(1);
    if (!invocation) throw new GoogleError("google_not_found");
    const [action] = await tx.select().from(actions).where(and(eq(actions.id, id), eq(actions.invocationId, invocation.invocation.id),
      eq(actions.createdByUserId, owner), eq(actions.kind, "google_call"))).for("update").limit(1);
    if (!action) throw new GoogleError("google_not_found");
    const approval = parseGoogleApproval(action.evidence?.google_approval);
    if (approval.approval_id !== id || approval.thread_id !== invocation.invocation.threadId || approval.invocation_id !== invocation.invocation.id) {
      throw new GoogleError("google_not_found");
    }
    return { action, invocation: invocation.invocation, approval };
  }

  private active(row: Awaited<ReturnType<GoogleApprovals["owned"]>>) {
    if (row.invocation.cancelRequestedAt || !["waiting_for_user", "waiting_for_model", "waiting_for_bud", "leased", "running", "retry_wait"].includes(row.invocation.status)) {
      throw new GoogleError("google_approval_inactive");
    }
  }

  async get(owner: string, id: string) {
    return this.database.transaction(async tx => {
      const row = await this.owned(tx, owner, id);
      const approval = { ...row.approval };
      if (approval.status === "pending" || approval.status === "approved") {
        if (row.invocation.cancelRequestedAt || !["waiting_for_user", "waiting_for_model", "waiting_for_bud", "leased", "running", "retry_wait"].includes(row.invocation.status)
          || Date.parse(approval.expires_at) <= Date.now()) approval.status = "expired";
      }
      return approval;
    });
  }

  async decide(owner: string, id: string, decision: "approved" | "rejected", identity?: ApprovalIdentity) {
    return this.database.transaction(async tx => {
      const row = await this.owned(tx, owner, id); this.active(row);
      const approval = row.approval;
      if (Date.parse(approval.expires_at) <= Date.now()) throw new GoogleError("google_approval_expired");
      if (decision === "approved" && (!identity || approval.account_subject !== identity.account_subject || approval.grant_id !== identity.grant_id)) {
        throw new GoogleError("google_approval_connection_changed");
      }
      if (approval.status === decision) return approval; // Duplicate browser delivery is harmless.
      if (approval.status !== "pending") throw new GoogleError("google_approval_already_decided");
      const updated: GoogleApproval = { ...approval, status: decision, decided_at: new Date().toISOString() };
      await tx.update(actions).set({ evidence: { ...row.action.evidence, google_approval: updated } }).where(eq(actions.id, id));
      return updated;
    });
  }

  /** Lookup for preparing the original deterministic request; this does not authorize dispatch. */
  async approved(owner: string, id: string, threadId: string, invocationId: string, expected: Pick<GoogleApprovalProposal, "connection_id" | "service" | "tool_name" | "arguments_json">) {
    return this.database.transaction(async tx => {
      const row = await this.owned(tx, owner, id); this.active(row);
      this.match(row.approval, threadId, invocationId, expected);
      return row.approval;
    });
  }

  private match(approval: GoogleApproval, threadId: string, invocationId: string,
    expected: Pick<GoogleApprovalProposal, "connection_id" | "service" | "tool_name" | "arguments_json">) {
    if (approval.thread_id !== threadId || approval.invocation_id !== invocationId) throw new GoogleError("google_not_found");
    if (approval.status !== "approved") throw new GoogleError("google_approval_required");
    if (Date.parse(approval.expires_at) <= Date.now()) throw new GoogleError("google_approval_expired");
    if (approval.connection_id !== expected.connection_id || approval.service !== expected.service
      || approval.tool_name !== expected.tool_name || approval.arguments_json !== expected.arguments_json) {
      throw new GoogleError("google_approval_action_changed");
    }
  }

  /** Commit the one-use fence before the network call; a lost outcome must never replay it. */
  async consume(owner: string, approval: GoogleApproval, identity: ApprovalIdentity) {
    return this.database.transaction(async tx => {
      const row = await this.owned(tx, owner, approval.approval_id); this.active(row);
      this.match(row.approval, approval.thread_id, approval.invocation_id, approval);
      if (row.approval.operation_id !== approval.operation_id) throw new GoogleError("google_approval_action_changed");
      if (row.approval.account_subject !== identity.account_subject || row.approval.grant_id !== identity.grant_id) {
        throw new GoogleError("google_approval_connection_changed");
      }
      await tx.update(actions).set({ evidence: { ...row.action.evidence,
        google_approval: { ...row.approval, status: "consumed", consumed_at: new Date().toISOString() } } })
        .where(eq(actions.id, approval.approval_id));
    });
  }
}
export const googleApprovals = new GoogleApprovals();
