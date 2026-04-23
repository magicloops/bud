# Phase 4: Client Read State And Badge Adoption

## Goal

Adopt the new backend primitives in first-party clients so the unread-thread model is actually exercised in product flows.

## Scope

This phase focuses on:

- iOS endpoint registration and read acknowledgments
- badge refresh from server-owned summary
- optional reference-web read-state adoption

The mobile UI implementation itself lives in the separate mobile repo, but this phase defines the repo-side contract and any lightweight first-party web/type updates needed here.

## Implementation Tasks

### Task 1: Document mobile registration flow

Required client behavior:

1. authenticate
2. obtain APNs token
3. call `PUT /api/me/push/endpoints/:installation_id`
4. refresh registration when token changes
5. disable or delete endpoint on logout/account switch

### Task 2: Define read acknowledgment timing

Required client behavior:

- mark read only when the newest visible message has actually been shown
- while bottom-following a thread, continue advancing the read watermark as newer assistant output arrives
- do not mark read solely because a thread loader ran or a stream attached

This phase should produce a stable handoff rule for the mobile team and, if we choose, the web client as well.

### Task 3: Adopt server-owned badge summary

Primary badge route:

- `GET /api/me/notifications/summary`

Expected usage:

- app foreground refresh
- post-read refresh
- post-push open reconciliation

Badge semantics are fixed:

- `unseen_thread_count` is the app badge count

### Task 4: Adopt thread unread indicators

Client thread lists should consume:

- `has_unseen_attention`
- `last_attention_kind`

This allows:

- bold/unread thread rows
- optional “needs reply/input” affordances later

### Task 5: Optional reference-web adoption

Recommended but not strictly required for initial mobile push launch:

- have the web thread view also call `POST /api/threads/:thread_id/read`

Why:

- without this, a user reading the same thread on web may still receive mobile pushes until mobile itself advances read state

## Tests / Validation Inputs

Contract-level validation should confirm:

- badge count drops when the thread is marked read
- badge count increments only once per newly attention-worthy thread
- multiple unseen assistant messages on the same thread still count as one badge unit
- logging out disables further notifications from that installation

## Docs / Specs

Update:

- `design/mobile-push-notifications-for-unseen-agent-messages.md` if the contract is materially tightened
- any mobile handoff or reference docs created for the implementation
- `web/web.spec.md` or deeper web specs if the reference web client adopts read acknowledgments

## Exit Criteria

- mobile has a stable route contract for registration, read acknowledgment, and badge refresh
- badge count is demonstrably thread-based, not message-based
- unread thread indicators match the server-owned attention model
