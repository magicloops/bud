# Validation checklist

Status: partial implementation validation; see the [current progress matrix](progress-checklist.md) and [remaining-work audit](remaining-work-audit.md). The consolidated service suite passes 119 tests without skips; the latest complete TimelineCore package suite passes 28 tests, with four subsequent capability HTTP tests also passing. Physical Contacts upload and one live trigger have partial evidence in the progress checklist; full background, recovery and cross-client demonstrations remain open. No phase gate is complete.

Q1/Q2 supplemental evidence: deterministic executor regressions withhold data
when ownership is lost during a held read and when cancellation arrives during
final ownership validation. Both failed before the fix and pass afterward; see
[query ownership race](../../debug/personal-data-query-owner-race.md). This does
not replace the real two-user/client acceptance cases below.

Use deterministic service/database tests for transaction and authorization behavior, mobile storage/transport tests for recovery, and real devices for background/permission behavior. A source review or mocked URLSession test cannot establish real-device delivery timing. For each case, record command/test name, repository revision, environment/device/OS, result and evidence link. Keep raw personal data and secrets out of logs and fixtures.

## Contract and ingestion

| ID | Scenario | Required result |
|---|---|---|
| I1 | Old location/health v1 fixtures, plain and gzip, actual public origin | Main service accepts and explicitly ACKs; health product features remain disabled |
| I2 | Lost ACK, retry, concurrent duplicate batch | One immutable event and one processing job per identity; matching ACK membership |
| I3 | Same owner/event ID with changed payload | Original preserved; visible conflict; no silent replacement or altered-payload success |
| I4 | Mixed valid/invalid/duplicate lines | Exact accepted/duplicate IDs; stable redacted rejections; rejected data not treated as accepted |
| I5 | Truncated gzip, disconnect, oversize compressed/decoded/line/count | Bounded resource use, no misleading success ACK; committed subset safe to retry |
| I6 | DB failure between event/job operations and before ACK | Atomic durable boundary; no ACK for missing data or job |
| I7 | Expired/revoked/invalid bearer, forged actor or another owner's installation | Rejected with no cross-owner writes and no development-user fallback |
| I8 | HTML route fallback / missing ACK / unrelated Fastify JSON route | Mobile retains events; normal service parsers remain unaffected |
| I9 | Unknown supported envelope with unknown event type/version | Durable raw record, visible unsupported projection, no live trigger |

## Mobile recovery and identity

| ID | Scenario | Required result |
|---|---|---|
| M1 | Kill before/after scan checkpoint, SQLite append, batch prepare, enqueue receipt | Durable snapshot/queue consistency; retry has stable IDs; no stranded in-flight rows |
| M2 | Empty-invalid/missing ACK IDs, wrong batch, foreign ID, partial ACK | No unrelated deletion; only valid explicit matching ACK retires rows |
| M3 | 401 refresh, 429 retry hint, 413 batch split, permanent rejection | Same-owner refreshed request; persisted retry; visible isolated quarantine |
| M4 | Relaunch with orphan files/tasks and cold background callback before profile bootstrap | Reconcile tasks/files/SQLite; completion handler exactly once after durable handling |
| M5 | BGTask expiration, device locked/first unlock, storage full | Truthful task completion, recoverable state, no dropped event/checkpoint |
| M6 | A→B switch with A queued/in-flight/callback work; environment switch | Data/credentials/callbacks stay in original immutable partition |
| M7 | Sign-out/revocation then original-account sign-in | Collection stops; retained dev queue resumes only for original authorized context |
| M8 | Legacy unscoped queue and downgrade | Verified migration or quarantine, never assignment to current login by default |
| M9 | Multi-batch backlog and app termination during draining | Bounded progress/retry across relaunch without requiring a fresh source event |

## Contacts source semantics

| ID | Scenario | Required result |
|---|---|---|
| C1 | Initial and empty baseline, split manifest, manifest before members | Queryable only after complete publication; zero live deliveries |
| C2 | Notification during scan, partial/failed fetch, app kill | Coalesced rescan; checkpoint advances only with durable full scan/deltas |
| C3 | Incremental add/update/disappearance | One eligible new-source addition; correct revisions/visibility; no update/removal subscription |
| C4 | Limited permission expansion/reduction, known reset/resync | Accessible view correct; live additions suppressed for known access/reset changes |
| C5 | Cloud arrival/link/unlink and two installations | Source identities preserved; uncertainty visible, no claim of universal IDs or verified creation |
| C6 | Reversed generations, duplicate scan, missing predecessor/digest mismatch | No stale resurrection or incomplete publish; visible retry/reconciliation state |
| C7 | Foreground/background source observation on device | Measured detection conditions reported; no promise of immediate suspended-app contact detection |

## Query and data authorization

| ID | Scenario | Required result |
|---|---|---|
| Q1 | Two-user list/detail/history/status/location on every adapter | SQL owner filtering, 404 for other owner's object; no cross-user cursor/data leak |
| Q2 | Agent tool without grant, revoked grant, excess fields/time/precision | Explicit permission requirement or constrained result; owner derived from invocation |
| Q3 | Pagination bounds/cursor reuse, stale source and empty data | Stable bounded results with documented cursor semantics and honest coverage |
| Q4 | No location, invalid coordinates, old/inaccurate/conflicting evidence | Unknown/no pin or explicit timestamped uncertainty; no invented meeting/place |
| Q5 | Later location upload or projection rebuild | Annotation can improve; no duplicate domain action or completed-action rerun |
| Q6 | Stream connect/replay, if added, under unauthorized viewer | Authorization before attach/replay; no buffered cross-owner event leak |
| Q7 | Stored-data query while mobile/Bud offline | Existing data remains queryable with freshness; no phone wake or model fallback |

## Durable agent execution

| ID | Scenario | Required result |
|---|---|---|
| A1 | Human message commit followed by process crash and client retry | One durable admission; missing start recovered, no duplicate user turn |
| A2 | Two workers claim same/same-thread work; stale fence after lease expiry | Database thread reservation; old worker cannot continue dispatch/outcome writes |
| A3 | Crash before/after provider request, terminal dispatch and outcome commit | Known-safe work recoverable; ambiguous external effects need review, never blind replay |
| A4 | Human send/interrupt during trigger and active TUI | Explicit cancellation/admission rules; no concurrent terminal writer or unsolicited trigger input |
| A5 | Question/approval wait across restart, answer in opposite client, duplicate answer | Original continuation/delivery restored and resolved once; no generic skip grants access |
| A6 | Exact Bud/model unavailable, reconnect before/after latest-start deadline | Durable wait, start only while eligible, visible expiry; no model substitution |
| A7 | Pause/revoke/delete target while queued/leased | Current authorization rechecked before dispatch; invalidated work visible |
| A8 | Automated tool catalog versus manual, manual offline path | Same normal terminal access; existing manual policy preserved |
| A9 | Transcript replay/compaction includes trigger and imported malicious instructions | Origin/evidence retained; contact content stays untrusted data, not system authority |
| A10 | Restart with unknown terminal outcome and pending next invocation | Reservation held/reviewed until safe; no overlapping side effects from automatic replacement |

## Matching, bootstrap and client parity

| ID | Scenario | Required result |
|---|---|---|
| T1 | Baseline/resync/rebuild and rule edit with old events | No live action or implicit replay |
| T2 | Incremental contact delivery and repeated worker/event attempts | One frozen revision delivery and invocation; idempotent thread allocation |
| T3 | Concurrent activation/bootstrap and late transaction commit/addition | Commit-safe cutover; no skipped or duplicate bootstrap/live membership |
| T4 | Retry same bootstrap, relink, explicit later rerun | Same request idempotent; relink does nothing; explicit rerun separately attributed |
| T5 | New-thread versus opt-in existing-thread rule | Correct owned target; existing active/waiting thread queues safely |
| T6 | Daily/concurrency limits, failure quarantine, pause/cancel and stale work | Bounded starts, visible reasons/outcomes, server enforcement |
| T7 | Mobile create → web edit/pause and reverse; simultaneous edits | Shared state and optimistic conflicts; no silent overwrite |
| T8 | Both clients closed; reconnect/history and optional missed push | Execution independent of clients/push; canonical durable status restores |

## App keys and permission continuation

| ID | Scenario | Required result |
|---|---|---|
| K1 | Tool request then approve on opposite client | No key before approval; one grant/key; original setup continuation resumes |
| K2 | Decline/cancel, stale request version, scope change, concurrent decisions | No key on deny/cancel; atomic one decision; changed scope needs new request |
| K3 | Another user/app key/model tries approval or key administration | Forbidden/404 as appropriate; no self-approval or privilege escalation |
| K4 | Service/device failure after approval, issuance or secret install | Durable handoff status and idempotent recovery; no duplicate/untracked active credential |
| K5 | Inspect provider history, transcripts, SSE, logs, terminal input/output, browser bundle and Git | No raw query key or redeemable handoff secret in ordinary paths |
| K6 | App query exceeds owner/field/precision/time bounds; revoke then retry | Scope enforced; next query denied after revocation |
| K7 | Supported generated app setup and old-daemon fallback | Protected setup demonstrated; mixed-version path honest and documented |
| K8 | Private app viewed without owner authorization | No builder data/credential exposure; shared-viewer broker remains deferred |

## Rollout and regression

- [ ] Add actual test items for all new browser-facing surfaces to [auth validation](../init-auth/validation-checklist.md).
- [ ] Review/check in migrations, verify staging migration application and additive rollback strategy.
- [ ] Test old mobile/new service, new mobile/unsupported API and both daemon/service version pairings.
- [ ] Verify existing HealthKit producer code and raw upload compatibility remain; do not claim deferred source correctness is fixed.
- [ ] Verify unrelated message/terminal/query functionality with checks appropriate to touched modules.
- [ ] Record standalone data and legacy queue inventory without exposing payloads; verify identity mapping before any migration.
- [ ] Measure capture-to-receipt and receipt-to-action separately, queue age, projection lag, retries/quarantine and per-rule consumption.
- [ ] Complete all six development demonstrations in [phase 8](phase-8-validation-and-rollout.md).

## Evidence record template

| Field | Value |
|---|---|
| Case IDs / phase | Pending |
| Repo revisions / migration files | Pending |
| Command or device steps | Pending |
| Environment / device / OS | Pending |
| Result / evidence link | Not run |
| Remaining defect and effect on gate | Pending |

## Product refinement checks (planned, not run)

| ID | Scenario | Required result |
|---|---|---|
| UX1 | Manual sync: no change, multi-batch and delayed publication | Truthful operation stages; Up to date only for completed captured scan |
| UX2 | Offline/policy/ACK/processing failure and repeated taps | Recoverable bounded work, actionable status, no false completion or duplicate trigger |
| UX3 | Account/environment change and web source view | No foreign progress; web does not imply current phone execution |
| UX4 | Navigate/edit Automations on both clients | Independent destination, shared inventory and version conflicts |
| UX5 | Multiple triggers in new/existing threads, reload and compaction | Compact attribution bound to each executed revision; full provenance retained |
| UX6 | Running/completed/waiting/review and terminal wait | One appropriate Stop control; no completed cancel action; recovery remains accessible |
| AM1 | Chat request with defaults and missing choices | Agent creates reviewed proposal without manual identifiers; no activation before human decision |
| AM2 | Opposite-client approval, double-submit and tool replay | One enabled revision and one original continuation |
| AM3 | Denial/cancel/expiry/restart | Durable decision recovery, no unintended activation |
| AM4 | Changed draft/grant/source/target during review | Stale approval rejected; no silent rebase or broader access |
| AM5 | Foreign owner, app key, unattended self-management | No management escalation or recursive standing-work creation |
| AM6 | Agent-requested existing-contact work | Separate bounded preview/approval and existing bootstrap dedupe |
| CF1 | Old/new payload/client/service pairings | Compatible capture with accurate field coverage; original envelopes unchanged |
| CF2 | International addresses, multiple URLs, empty/removal/large fields | Bounded lossless contract or explicit failure, no silent truncation |
| CF3 | Existing versus expanded field grants | No unauthorized search/history/tool/app leakage; no implicit grant expansion |
| CF4 | Enrich old contacts alongside a new addition | No replay for enrichment, no lost/duplicated eligible new contact |
| CF5 | Postal address, unsafe URL, photo/notes absence | No fabricated location evidence or automatic fetching; excluded fields stay excluded |
