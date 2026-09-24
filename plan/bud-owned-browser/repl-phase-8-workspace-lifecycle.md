# Phase 8: Workspace admission, cleanup and final merge acceptance

Status: scoped, not implemented. Final pre-merge phase of the
[REPL implementation plan](repl-implementation.md). 2026-09-24.

## Context

A new thread could not open a page because two logical browser workspaces were
already allocated, even though Chrome showed only three tabs. Admission counts
non-closed daemon workspace slots, not visible tabs. Closing a native tab does
not necessarily free a slot. The agent's advice to close a session or tab was
therefore unreliable. See [investigation and interim fix](../../debug/browser-workspace-limit.md).

The temporary cap is now ten workspaces, with one constant for enforcement and
advertised `max_sessions`. A live regression covers ten admissions, rejection of
the eleventh, and admission after logical close. Raising the number mitigates the
immediate problem; it does not complete this phase.

## Objective

Normal movement between threads must not exhaust invisible browser slots with no
usable recovery. Keep the shared profile, thread-owned tabs and retained REPL
state understandable. At a real resource limit, report what is exhausted and
provide a supported way to recover without destroying another thread's work.

This phase is the final merge gate for this REPL change. It includes workspace
lifecycle work and verification of outstanding earlier-phase gates; it does not
implicitly mark those gates complete or pull unrelated browser roadmap items in.

## 1. Establish the smallest lifecycle policy

- [ ] Trace allocation and release through service admission, daemon slots,
  workers, tabs, viewers and URL checkpoints. Include failed initial admission,
  native final-tab closure, explicit tab/workspace close, thread deletion,
  daemon restart and reconnect. Identify the owner of each cleanup transition.
- [ ] Distinguish durable workspace identity and recovery hints from resident
  resources: Chrome targets, helper/REPL processes, artifacts and media. Document
  exactly what the ten-workspace limit protects and when a slot is released.
- [ ] Reproduce accumulated empty/failed workspaces with neutral fixtures. Fix
  confirmed orphaned allocations first using existing lifecycle paths.
- [ ] Choose and document the smallest remaining admission policy from evidence:
  release unused allocations when safe, or expose explicit workspace release when
  useful state must be discarded. Do not infer that an empty tab inventory means
  an empty REPL heap, or that closing a viewer means abandoning a workspace.

Prefer deterministic cleanup at existing lifecycle boundaries. Keep a bounded
resident-resource cap unless measurements justify changing it. Avoid a new
scheduler, idle timer framework, automatic LRU eviction, new database lifecycle
model or compatibility mode merely to address this case. If explicit release is
needed, reuse the existing workspace-close implementation rather than inventing
another browser reset operation.

## 2. Implement admission and recovery

- [ ] Ensure failed/unstarted allocations cannot permanently consume capacity.
  Reconcile service and daemon state without reopening a deliberately closed tab
  or replaying an uncertain browser action.
- [ ] Preserve reusable empty workspaces when they contain meaningful retained
  state, or make any explicit disposal and resulting runtime reset visible.
  Do not silently discard REPL bindings, private work or saved recovery URLs.
- [ ] Permit existing workspace operations and supported close/release at capacity.
  Concurrent admissions must enforce the cap atomically; cleanup must not allow
  a second active workspace for the same thread.
- [ ] Make capacity failures identify **thread browser workspaces**, not Chrome
  tabs or viewer connections. Agent guidance must describe an actually supported
  recovery action; do not recommend tab closure if it cannot free capacity.
- [ ] If a human action is necessary, reuse existing authorized controls where
  possible. Do not direct the user to an invisible session or nonfunctional button.
  Do not add a workspace-management dashboard for this phase.

## Ownership and contracts

The authenticated owner owns the Bud; each thread owns its workspace, targets and
REPL state. Service admission resolves owner/Bud/thread/invocation, and the daemon
checks immutable bindings and current authority. Cleanup cannot cross these
boundaries. Private control remains Bud-wide, and another thread's admission
must not release it. Chrome's persistent profile and sign-ins are not disposable
workspace resources.

No new route, table or migration is presumed. If existing surfaces need changes,
identify viewer resolution, authorization before reads/writes/streams and owner
stamping before implementation. Resource inventory must be owner-scoped in SQL;
never expose another user's workspaces as cleanup candidates. Extend the
[auth checklist](../init-auth/validation-checklist.md) for any new browser-facing
read/write surface. Update wire documentation for changed capabilities, payloads
or errors; do not silently change the meaning of `max_sessions`.

## 3. Validate behavior

- [ ] Many successive threads: demonstrate the chosen retention/release policy,
  including a useful recovery path at the cap and successful subsequent admission.
- [ ] Concurrent final-slot admission: only the allowed workspace is admitted;
  rejected attempts leave no persistent capacity leak.
- [ ] Empty workspace with retained variables: native/tab closure and viewer
  dismissal follow the documented policy without silent heap loss.
- [ ] Failed launch/ensure, explicit close, thread deletion, reconnect and restart:
  no orphaned slots, duplicate actions or unintended page restoration.
- [ ] Live tabs, active cells and private takeover: no eviction of ongoing work,
  no cross-thread target adoption, and no private data delivered after cleanup.
- [ ] Scope checks: another owner cannot inspect, reclaim or close a workspace.
- [ ] Real-agent and web/iPhone checks: capacity explanation and offered recovery
  are accurate and usable; sign-ins and unrelated thread work remain intact.

Use existing admission, isolation and lifecycle regressions. Add focused cases
for the selected policy; avoid tests that merely assert prompt vocabulary.
Record actual results and skipped environment checks in a debug note.

## 4. Final merge gate

- [ ] Complete [Phase 7c scrolling and observation use](repl-phase-7c-observation-use.md)
  with a reproduced stale-scroll decision and measured guidance results.

- [ ] Complete [Phase 7b output compaction](repl-phase-7b-output-compaction.md),
  including fidelity/overflow validation and the explicit post-compaction
  decision on the 8 KiB default. Do not infer acceptance from smaller byte counts.

- [ ] Reconcile the parent plan's open Phase 3 physical lifecycle, Phase 4 catalog
  cutover and Phase 6 efficiency acceptance with recorded evidence. Any proposed
  deferral must be explicit and agreed; a larger workspace cap is not acceptance.
- [ ] Complete Phase 7 supplementary interaction validation. The
  [1575 review](../../review/browser-repl-1575-review.md) confirms pointer hints
  but contains no clicks, so it is not native-click acceptance.
- [ ] Run affected builds/tests and the final supported-catalog smoke test after
  cleanup. Existing history must still render without executable legacy aliases.
- [ ] Update daemon/helper/service/agent/viewer specs as affected, protocol and
  setup docs, this phase, and the parent plan. Record remaining work separately
  without hiding unresolved merge blockers.
- [ ] Record coordinated service/daemon/prepared-helper versions and upgrade order;
  native mobile needs a build only if its bridge changes. Include migrations only
  if the final implementation introduces schema changes.

The phase is complete when workspace lifecycle acceptance and the earlier merge
gates above are satisfied. Linux support, WebRTC, expanded keyboard/clipboard/file
APIs, context thinning and unrelated performance work remain separate plans.
Implementation does not authorize commit, push, merge, deployment or restart.
