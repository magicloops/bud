import assert from "node:assert/strict";
import test from "node:test";
import { loadThreadAgentState } from "./state-loader.js";

test("Google approval bootstrap restores an owned durable card and removes stale runtime cards", async () => {
  const pending = { turn_id: "turn", invocation_id: "invocation", pending_tool: {
    name: "google_call", client_id: "client", call_id: "call", started_at: new Date().toISOString(),
    args: { google_approval: { approval_id: "approval", status: "pending" } },
  } };
  let approvals = [pending];
  const repository = {
    listForThread: async () => [], pendingQuestionsForThread: async () => [],
    pendingDataRequestsForThread: async () => [], pendingAutomationProposalsForThread: async () => [],
    pendingBootstrapProposalsForThread: async () => [],
    pendingGoogleApprovalsForThread: async (owner: string, thread: string) => {
      assert.equal(owner, "owner"); assert.equal(thread, "thread"); return approvals;
    },
  };
  const service = { durableInvocations: repository, getEnvironmentForBud: async () => ({ mode: "bud_offline" }) };
  const thread = { threadId: "thread", budId: "bud", createdByUserId: "owner" };
  const empty = { active: false, turn_id: null, phase: "idle", pending_tool: null, stream_cursor: "epoch:1" };
  const restored = await loadThreadAgentState("owner", thread as never, service as never, empty as never);
  assert.equal(restored.pending_tool?.call_id, "call");
  assert.equal(restored.turn_id, "turn");
  assert.equal(restored.phase, "waiting_for_user");
  assert.deepEqual(restored.pending_google_approvals, [pending]);
  approvals = [];
  const resolved = await loadThreadAgentState("owner", thread as never, service as never,
    { ...empty, active: true, turn_id: "turn", phase: "waiting_for_user", pending_tool: pending.pending_tool } as never);
  assert.equal(resolved.pending_tool, null);
  assert.deepEqual(resolved.pending_google_approvals, []);
  approvals = [pending];
  const other = { ...empty, active: true, turn_id: "other", phase: "thinking" };
  const concurrent = await loadThreadAgentState("owner", thread as never, service as never, other as never);
  assert.equal(concurrent.turn_id, "other");
  assert.equal(concurrent.pending_tool, null);
  assert.deepEqual(concurrent.pending_google_approvals, [pending]);
});
