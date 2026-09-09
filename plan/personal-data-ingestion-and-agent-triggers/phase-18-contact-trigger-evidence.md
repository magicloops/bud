# Phase 18: Contact evidence in automation inputs

## Problem
Agents receive contact/revision IDs but can mistakenly use text search for them.
Deliver the approved event revision with the trigger, avoiding a mandatory lookup.
Related: service/src/personal-data/personal-data.spec.md and service/src/agent/agent.spec.md.

## Design
At the first durable start, under the existing owner and invocation locks, resolve
live delivery or bootstrap member references from server tables. Read the exact
revision with the current grant's field allowlist and the frozen automation's
history/scope ceiling. Never use the latest contact fields as event evidence.
Append a JSON evidence block explicitly labeled untrusted data, including IDs,
observation time and source. Preserve the original admission text for idempotency.
Publish evidence and model visibility atomically; continuations retain the same
snapshot. Existing checkpoint permission checks still block revoked automation.
Evidence becomes ordinary owner-scoped conversation history, like query results;
revocation stops new access but does not erase prior transcripts.

Bound injected evidence to 64 KiB total fields across at most 25 contacts. Oversize
records carry IDs/times and an explicit omitted-fields reason; contacts_get can
retrieve the full allowed record. Do not silently truncate or invent evidence.

Add contacts_get(contact_id, revision_id?) to the agent tools. With revision_id,
validate exact owner/contact/revision association and history. Without it return
current contact. Use existing field policy and post-query grant recheck. Clarify
that contacts_search searches text fields, not identifiers.

No schema, daemon protocol or production data repair. Existing queued inputs gain
evidence on first start; already-started runs are not replayed. Web/mobile generic
personal-data rendering remains compatible. Validate exact revision vs later edit,
field/owner/history restrictions, revoked grants, start idempotency, and tools.

## Implemented and validated
- First-start evidence supports both live deliveries and frozen bootstrap groups.
- Exact lookup is registered in tool schemas, model extraction, execution, stored
  transcript replay and argument serialization. Generic clients remain compatible.
- Database checks cover field/owner/history isolation, revoked startup permission,
  exact event revision despite a later edit, context-size omission, unchanged
  admission retry identity, retained evidence on resumption and bootstrap members.
- Service build passes; 23 tool/model tests pass; 14 database/adapter/repository
  tests/subtests pass across the focused runs. The shared processor fixture needed
  a standalone rerun after a SKIP LOCKED timing failure; see the debug note.
- Manual validation after deployment: create a uniquely named contact and confirm
  the first model response has its permitted fields without searching by ID.

No deployment, phone installation, production edits or reruns performed.
