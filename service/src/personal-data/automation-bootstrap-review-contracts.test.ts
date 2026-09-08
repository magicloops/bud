import assert from "node:assert/strict";
import test from "node:test";
import { automationBootstrapReviewRequestSchema, automationReviewKindSchema } from "./automation-bootstrap-review-contracts.js";
import { automationProposalRequestSchema, automationProposalDecisionSchema } from "./automation-proposal-contracts.js";

const selection = {
  automation_id: "auto_example", expected_version: 4, sources: { source_ids: [] },
  search: "Ada", max_contacts: 30, mode: "batched", exclude_previously_delivered: true,
};

test("existing-contact requests preserve explicit bounded selection and repeat intent", () => {
  assert.deepEqual(automationBootstrapReviewRequestSchema.parse(selection), selection);
  const repeat = { ...selection, mode: "per_contact", exclude_previously_delivered: false };
  assert.deepEqual(automationBootstrapReviewRequestSchema.parse(repeat), repeat);
  for (const max_contacts of [0, 1001, 1.5])
    assert.equal(automationBootstrapReviewRequestSchema.safeParse({ ...selection, max_contacts }).success, false);
  assert.equal(automationBootstrapReviewRequestSchema.safeParse({ ...selection, sources: { source_ids: ["s", "s"] } }).success, false);
});

test("agent selection cannot supply authority, frozen evidence or manual acknowledgements", () => {
  for (const field of ["owner", "created_by_user_id", "expected_grant_version", "use_draft", "revision",
    "member_ids", "contact_revision_ids", "publication_boundary", "approved", "acknowledge_existing_contacts",
    "acknowledge_repeated_actions", "acknowledge_standing_work", "idempotency_key"]) {
    assert.equal(automationBootstrapReviewRequestSchema.safeParse({ ...selection, [field]: true }).success, false, field);
    assert.equal(automationBootstrapReviewRequestSchema.safeParse({ ...selection, [field]: null }).success, false, field);
  }
});

test("activation requests and human decisions cannot absorb bootstrap selection", () => {
  assert.equal(automationProposalRequestSchema.safeParse(selection).success, false);
  const decision = { decision: "approve", expected_version: 0, idempotency_key: "human-key" };
  assert.equal(automationProposalDecisionSchema.safeParse({ ...decision, selection }).success, false);
  assert.equal(automationReviewKindSchema.safeParse("existing_contacts").success, true);
  assert.equal(automationReviewKindSchema.safeParse("unknown").success, false);
});
