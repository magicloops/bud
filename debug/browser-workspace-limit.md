# Debug: browser workspace limit

## Environment and reproduction

Local macOS development daemon with a shared persistent Chrome profile. Two
thread browser workspaces were allocated; another thread's attempt to open a
page returned `browser_session_limit`, despite only three visible Chrome tabs.

## Findings

Admission counts non-closed logical workspace slots, not Chrome tabs. The Bud
presentation tab is excluded from workspace inventory. Native tab closure does
not close the logical workspace. Both admission and capability advertised a
hardcoded limit of two. The agent's suggestion to close a tab is not a reliable
way to free a workspace slot.

## Interim fix and follow-up

Raise active workspaces per Bud to ten using one constant for admission and
`max_sessions`. Keep one workspace per thread and the 128-identity tombstone cap.
Update the existing live admission/isolation regression for ten accepted slots,
an eleventh rejection, and successful admission after closing a workspace.

Track lifecycle/admission cleanup and accurate limit messaging in
[REPL Phase 8](../plan/bud-owned-browser/repl-phase-8-workspace-lifecycle.md),
the final pre-merge gate. This
is an interim capacity change, not automatic eviction of tabs or REPL memory.
Update the browser runtime spec. Rebuild/restart the daemon to apply; no service,
client or database migration is required. No wire fields or error codes change.

## Validation

Passed `cargo test live_session_isolation_reconnect_and_duplicate_admission
-- --test-threads=1` with the prepared Node runtime, checkout helper and disposable
Chrome for Testing. The live test accepts ten workspaces, rejects the eleventh,
retains isolation/reconnect checks and admits a new workspace after close.
`cargo fmt --check` and `git diff --check` also passed. No running daemon was
restarted.
