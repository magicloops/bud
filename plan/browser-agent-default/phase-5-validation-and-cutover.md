# Phase 5: Validation, removal and coordinated cutover

Status: automated validation complete; physical acceptance and deployment pending. Requires Phases 1–4. Parent: [plan](README.md).

## Acceptance matrix

Run deterministic tests first, then web and physical iPhone over local and ngrok
connections. Record actual builds, timing and results; unchecked items are not proof.

- [ ] Take control → edit → Close → agent follow-up proceeds; reopen watches agent.
- [ ] Repeat for pane switch, thread switch, app background, screen lock, browser
  document hidden, killed app/WK process, network loss and service/daemon restart.
- [ ] Explicit end retires authority promptly; missing end expires within the
  specified lease bound even during busy input/capture. Measure execution readiness
  separately: loss of connectivity can delay execution, not preserve human control.
- [ ] No automatic acquisition after reconnect/foreground. Reading in a healthy
  visible controlling view maintains its lease without requiring gestures.
- [ ] Passive device close/disconnect does not end another viewer's override.
- [ ] End/renew/acquire races, delayed messages, duplicate end and lost ACK cannot
  revive an old override, end a newer one or resume an invocation twice.
- [ ] Unknown input is never replayed; agent mutation waits until old human work
  cannot execute. Failed reconciliation recovers automatically, without manual Return.
- [ ] Help request shows Take control but grants nothing. Alternative instructions
  redirect the waiting agent without taking control; skip/cancel work as specified.
- [ ] A help-associated override ending reports why it ended, not that the human
  finished the task. Unrelated threads are not locked by an unanswered help prompt.
- [ ] Cancellation, deletion, logout and unclaim win over late continuation. Ownership
  tests cover live web and scoped mobile visits, including expired/foreign viewers.
- [ ] Both media paths, native-window/focus cleanup, frame/focus fences and keyboard
  behavior still work. Existing browser tabs, credentials and profile data survive.

## Diagnostics and cleanup

- [x] Log bounded lifecycle reasons, override/generation correlation and durations
  for end, lease expiry and execution readiness. Never log tokens, typed text or pixels.
- [x] Confirm routine renewal does not generate inventory/image refresh storms.
- [x] Remove obsolete paused-controller restoration, recovery proofs/tickets,
  pause/acquire-to-return branches and sticky private-state readers across tiers.
- [x] Update tests, protocol, root/component specs and mobile contract to the final
  model. Mark superseded plan recommendations clearly; retain useful historic evidence.
- [x] Run builds, focused and cross-tier integration tests and applicable lint checks.
  Record any physical-device or network validation still outstanding.

## Cutover

The service auto-deploys on main merge; daemon and mobile ship separately. These
phases require a coordinated change, not independent merges into a running old stack.

1. Record migration filename, matching service/web commit, daemon build and mobile
   build. Specify the minimal capability/version rejection for unsupported pairings;
   do not silently execute old sticky-pause semantics.
2. Quiesce browser operations and old controllers/workers for the controlled cutover.
   Resolve old pending task waits honestly; do not mark unanswered tasks successful.
3. Apply the reviewed checked-in migration through the service deployment workflow.
   Install matching daemon and service/hosted web before resuming browser operations.
   Confirm runtime reconciliation retires legacy holds without resetting profiles.
4. Install rebuilt mobile before mobile acceptance testing; old clients must fail
   clearly rather than acquire incompatible control. Verify restart and recovery.
5. Resume browser work and run the close/background/help-request smoke matrix.

Local schema work includes db:push; deployment requires the generated migration,
not db:push. Final implementation must document exact deployment ordering and any
brief downtime. Execution of merges/deployments remains separately authorized.

Rollback requires a reviewed matching stack/schema strategy or forward correction;
do not start old binaries against a destructively migrated authority model. Preserve
browser data and pending task context throughout.

## Implementation record

Applied locally, generated with Drizzle (including custom migration workflow):
0044_conscious_skaar.sql, 0045_lucky_makkari.sql,
0046_browser_override_cutover.sql, 0047_yielding_sabretooth.sql.
`pnpm db:push` was run and reviewed; unrelated constraint recreation was canceled.
The exact reviewed migration SQL was applied locally transactionally instead.
Deployment must use `pnpm db:migrate`, with old browser workers/controllers stopped.

Automated evidence, 2026-09-28:
- Service browser + agent-tool suite with `BUD_DATA_DB_TEST=1`: 71 passed, 1 skipped.
- Additional control and upgraded notification-trigger fixtures: 24 passed.
- Rust browser tests: 98 passed, 11 live Chrome tests ignored. `cargo clippy --bin bud` passed without warnings; control/idle rustfmt applied.
- iOS simulator build succeeded; all 13 BrowserVisitTests passed on iPhone 17 Pro.
- Service `pnpm exec tsc --noEmit` and web `pnpm exec tsc -b` passed.
- Mounted web viewer, lifecycle, bridge and handoff tests: 26 passed.
- Final controller/repository/notification/agent-tool rerun after cleanup: 36 passed.

Tests cover old-ID release, expired renewal, exact visit disposal, page-lock expiry,
help without control, chat redirection, cancellation and honest continuation,
private input rejection, migration ownership and quiet lease renewals. This does
not claim the complete physical matrix above. Outstanding: rebuilt iPhone/web
close/background/lock/process death, local/ngrok network loss, native window cleanup
and agent follow-up against real Chrome. No merge/deployment is performed here.

Capability: new daemon advertises agent_default_control. Install matching service,
web and daemon while browser operations are quiesced, then rebuild mobile and test
fresh visits. Service merges auto-deploy, so coordinate that merge with migrations
and daemon installation. Old daemon takeover is rejected; no compatibility hold is
restored. Preserve profiles and unanswered tasks; cleanup reconciles old fences.
