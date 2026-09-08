# Phase 8: Development integration and rollout

Status: development happy paths have user validation; remaining conditions of the six demonstrations, deployment/mixed-version verification and device measurements remain open. See [current evidence](progress-checklist.md) and [actionable follow-ups](../../TODO.md). Dependencies: phases 1–7. Parent: [implementation spec](implementation-spec.md).

## End-to-end demonstrations

Record commands, versions, fixture/device conditions and observed results in the [validation checklist](validation-checklist.md). Source review alone cannot satisfy device/background gates.

1. Link Contacts on mobile, complete baseline through the public origin and query it in web and an authorized agent. Confirm zero live deliveries.
2. Activate a contact rule in web, inspect it in mobile, add a contact, close both clients, and observe one durable execution with evidence-labeled location context. Repeat with new-thread and existing-thread targets.
3. Process a bounded existing-contact snapshot while new additions publish. Verify membership/cutover, limits, cancellation and no duplicate action on retry/relink.
4. Disconnect the selected Bud/model; verify visible waiting/expiry without substitution. Restart the service around a tool dispatch and verify safe recovery or needs-review, not blind replay.
5. Agent requests an app key; approve in the other client, complete protected setup, query the private app and revoke. Repeat denial and interrupted handoff.
6. Run account-switch and two-user read/write/stream/key tests across all surfaces. Measure oldest queue age, capture-to-receipt and receipt-to-action separately; capture projection lag, retries/quarantine and invocation outcomes without sensitive payload logs.

## Deployment order

- Inventory standalone DBs, deployments and local mobile queues before retirement. If data exists, verify owner mapping and preserve event IDs/receipt times. Never assign all historical development rows to a real user. Document a reviewed migration or quarantine decision.
- Apply additive main-service migrations and routes/auth/front-door support first, with matching/activation disabled. Review SQL, run local `pnpm db:push` and generate checked-in migrations from `service/`; verify staging uses migrations, not push. Investigate and fix build/run failures with recorded command/error evidence under the current repository instructions.
- Roll out mobile queue recovery and Contacts producer with feature discovery. Verify old health/location envelopes remain ingestible. New clients retain data on unsupported endpoints; old clients' permissive ACK behavior makes maintaining valid explicit ACKs especially important.
- Backfill supported projections with live actions suppressed; then enable scoped reads and durable admission after draining old in-process turns. Enable automation authoring/activation only after both clients and recovery gates pass.
- Enable app key issuance only after approval parity and protected handoff pass. A required new daemon capability must be shipped with a tested old-daemon fallback; otherwise no daemon upgrade is required for contacts/query/automation execution.

Deployment, commits and PRs require their own express user request. This plan does not authorize them.

## Compatibility and rollback

| Pairing / rollback | Required behavior |
|---|---|
| Old mobile / new API | Preserve v1 ACK/envelope compatibility; mark missing source coverage, no invented contacts semantics |
| New mobile / unavailable or older API | Keep queue, surface unsupported/retry state, never delete on fallback HTML |
| New service / old daemon | Existing terminal execution; new secret operation only if capability advertised, otherwise documented fallback |
| Old service / new daemon | Existing protocol remains accepted; new capabilities do not break connections |
| Projection/matcher rollback | Keep ingestion/ACK running; pause matching, retain work and avoid replay on rebuild |
| Invocation rollback | Quiesce/resolve durable active reservations before restoring old start path; ambiguous actions remain reviewable |
| Mobile schema rollback | Retain/migrate partition state deliberately; incompatible old app cannot relabel or silently delete queues |

Use additive migration rollback/forward repair; do not drop raw events/queues to recover a feature rollout. Keep acknowledged events recoverable through processor fixes. Feature flags are server-enforced and report disabled state to clients.

## Follow-up ledger (outside development acceptance)

| Follow-up | Boundary retained now |
|---|---|
| Shipped sign-out disposal, probably discard | Dev queues retained only in original account/environment partition |
| Revocable upload-only credentials | Current OAuth refresh/retry, no invalid-token bypass or extended broad-token lifetime workaround |
| Health source durability, IDs/deletions/permissions, lookback/backlog, summaries and metrics | Keep producers and raw upload compatibility; no new reliable-health-monitoring claim |
| Retention, deletion/backup policy and encryption architecture | Owner isolation, bounded reads and key revocation already enforced |
| Geographic regions/named places, richer correlation | Best-effort observation evidence only; no repeated completed actions |
| Viewer-authenticated app broker | Private owner-key apps only; no builder-key substitution for other viewers |
| Richer offline recovery / explicit cloud fallback | Wait for exact Bud/model and visibly expire |
| Contact change-history optimization, richer subscription categories | Snapshot diff and live additions only |

Final handoff lists landed phase evidence, unresolved defects, migration filenames, feature-flag states and which capabilities each client/daemon version supports. No production retention/power/latency guarantee is inferred from the development milestone.

## Extended product acceptance (phases 9–14)

Keep the original six demonstrations and recovery matrices open until their full
conditions pass. The September 6–7 foreground-assisted trigger, agent setup/query, private app
and revocation checks are partial evidence, not complete recovery/cross-client
acceptance.
After the new phases, also demonstrate:

1. Manual sync progresses through capture/upload/publication, including no-change, offline and error cases.
2. Both clients find Automations independently of Contacts and render compact per-run attribution with one active Stop control.
3. Agent drafts a rule, opposite client approves once, restart preserves the proposal, and deny/stale approval cannot activate it.
4. Addresses/websites enrich existing contacts without rerunning actions or widening existing grants; mixed-version clients remain usable.

See UX, AM and CF cases in the validation checklist. New DTOs/tables require the
same additive compatibility, migrations and ownership review as earlier phases.
Photos/thumbnail access, chat-only activation authority and additional trigger
types remain future decisions. Production shared-browser sign-in with explicit
account switching remains the mobile TODO; current ephemeral auth is not yet
restricted to development builds.
