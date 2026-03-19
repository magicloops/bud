# Design: Terminal Session Lifecycle And Thread Uniqueness

Status: Draft

Audience: Service, Bud, and web platform team

Last updated: 2026-03-18

## 1. Summary

We reviewed the current implementation to understand the long-standing `terminal_session.thread_id` uniqueness bug and whether the current `mobile-auth` branch introduced it.

Short answer:

- The current auth/mobile branch did **not** introduce the underlying uniqueness behavior.
- Bud already supports durable tmux sessions keyed by `session_id` and can reattach to them after reconnect.
- The actual mismatch is older:
  - the service auto-closes idle sessions after 24 hours
  - the database enforces a global unique `terminal_session.thread_id`
  - the manager only considers non-closed rows when reopening a thread

That means ordinary revisit/reopen flows can fail once a thread has a closed session row.

The simplest robust direction is:

1. keep the current “new logical session after explicit close” model
2. change the uniqueness rule so only **active** sessions are unique per thread
3. stop auto-closing idle sessions by default if the desired product behavior is “persist until manually removed”

## 2. What We Reviewed

### Current service behavior

`TerminalSessionManager.createSessionForThread()`:

- returns an existing row only when `thread_id = ?` and `closed_at IS NULL`
- otherwise inserts a fresh row

`TerminalSessionManager.getSessionForThread()`:

- also only returns rows where `closed_at IS NULL`

`closeSession()`:

- sends `terminal_close` to the Bud
- marks the DB row `state = "closed"` and sets `closed_at`

Current close callers:

- manual close from `DELETE /api/buds/:budId/sessions/:sessionId`
- thread deletion
- idle cleanup

### Current Bud behavior

Bud already has the durable tmux behavior we want:

- `terminal_ensure` derives tmux session name from `session_id`
- if the tmux session already exists, Bud reattaches to it
- if it does not exist, Bud creates it
- Bud disconnects do **not** close tmux sessions; the service only suspends them back to `pending`

So persistence across reconnects is already supported.

### Branch comparison

Compared to `origin/main`, there are no terminal-lifecycle changes in:

- `service/src/runtime/terminal-session-manager.ts`
- `service/src/routes/threads.ts`
- `service/src/ws/gateway.ts`

The current branch changed auth and OAuth-related code, not the terminal manager or terminal schema behavior.

## 3. Findings

### 3.1 The uniqueness bug predates the current auth branch

The schema still has a global unique constraint on `terminal_session.thread_id`.

The manager logic assumes:

- closed rows do not count as the current session
- reopening after close creates a new row

Those two assumptions are incompatible with a global unique `thread_id`.

### 3.2 Current idle cleanup conflicts with the desired product behavior

The service currently:

- marks sessions `idle` after 30 minutes
- closes idle sessions after 24 hours

That is a product decision, not a technical necessity.

If the intended behavior is:

- tmux stays alive until the user explicitly removes it

then the current 24-hour auto-close policy is wrong even before we discuss uniqueness.

### 3.3 Bud already supports durable session identity

The Bud side is already compatible with persistence:

- same `session_id` -> same tmux session name
- same `session_id` can be reattached after reconnect

So the missing piece is not daemon durability. The issue is service-side lifecycle policy plus DB constraints.

### 3.4 Existing docs already drifted on this point

Some planning docs describe `thread_id UNIQUE` as if it enforces “one active session per thread.”

That is not what the database currently enforces.

It enforces:

- one row per thread across all time

which is stricter than the runtime model and is the root of the reopen bug.

## 4. Desired Behavior

The product behavior we actually want appears to be:

- a thread owns at most one **active** terminal session at a time
- that terminal session persists across service and Bud reconnects
- idle sessions are not auto-closed by default
- manual close/delete should still be able to free Bud/tmux resources
- after an explicit close, revisiting the thread should work cleanly

Two valid interpretations remain:

1. revisit after manual close should create a **new logical session**
2. revisit after manual close should **reuse the same logical session row**

Both are possible. They have different tradeoffs.

## 5. Design Options

### Option A: Reuse One Durable Session Row Per Thread

#### Shape

- keep `thread_id` globally unique
- never create a second row for a thread
- reopening after close reuses the same row and same `session_id`
- manual close kills tmux, but the row remains the thread’s durable terminal slot

#### Required changes

- `getSessionForThread()` must return the thread row regardless of `closed_at`
- `createSessionForThread()` becomes “get or initialize slot,” not “insert fresh row”
- `ensureSession()` must allow a previously closed/stopped row to be started again
- session-close semantics need to stop treating `closed` as terminally unusable
- likely remove or repurpose `closed_at`

#### Pros

- no uniqueness migration required
- matches the Bud model naturally: same `session_id`, same tmux identity
- strong mental model: one durable terminal identity per thread

#### Cons

- manual close semantics become muddy
- metrics and timestamps on one row now span multiple tmux lifetimes
- output history, log path, and readiness state all continue under one `session_id`
- Bud session-management UI currently assumes close -> new session later
- more code-path changes than it first appears

#### Assessment

Viable, but more invasive than it looks. It also changes the semantics of what a “session” row means.

### Option B: Versioned Session Rows With Partial Uniqueness On Active Rows

#### Shape

- keep the current runtime model:
  - closed sessions stay closed
  - reopening creates a new session row with a new `session_id`
- change the DB rule so only non-closed rows are unique per thread

In SQL terms:

- drop global unique constraint on `thread_id`
- add a partial unique index on `thread_id WHERE closed_at IS NULL`

#### Required changes

- DB migration to replace the current unique constraint
- schema definition update to match partial uniqueness
- no major terminal-manager behavioral rewrite
- decide whether idle cleanup stays enabled

#### Pros

- minimal behavioral change to the current service code
- aligns with existing manager logic and Bud session modal copy
- preserves historical session rows and per-session output logs
- explicit manual close still results in a fresh tmux session next time
- cleanest fit for the current codebase

#### Cons

- multiple rows per thread over time
- thread terminal history is still scoped to the latest active session unless the UI explicitly aggregates old sessions
- requires a migration with partial-index support

#### Assessment

This is the best fit for the current architecture.

If we want “persist until manually removed,” this option should be paired with disabling auto-close by default.

### Option C: Free The Thread Slot On Close By Nulling `thread_id`

#### Shape

- keep global unique `thread_id`
- on close, set `thread_id = NULL`
- reopening creates a fresh row

#### Pros

- no partial unique index needed
- preserves versioned rows
- smaller migration than Option B

#### Cons

- destroys the historical link between a closed session and its thread
- weakens debugging, auditability, and future thread-level transcript recovery
- makes old rows effectively orphaned

#### Assessment

Technically workable, but structurally poor. Not recommended.

### Option D: Hard Delete Closed Sessions

#### Shape

- delete the session row and its output/input rows on close
- reopening inserts a fresh row

#### Pros

- simple runtime model
- no uniqueness conflict

#### Cons

- loses output history and audit trail
- contradicts current modal copy and current DB retention model

#### Assessment

Not acceptable for Bud’s current terminal/history goals.

## 6. Recommendation

Recommend **Option B**:

- keep versioned session rows
- make uniqueness apply only to active rows
- disable automatic idle close by default

Why this is the right balance:

- it fixes the actual DB/runtime mismatch directly
- it preserves current “close means new session later” semantics
- it avoids redefining a session row into a long-lived reusable slot
- it keeps Bud’s existing durable tmux behavior for non-closed sessions
- it requires the least invasive service/Bud logic changes

## 7. Recommended Behavioral Contract

### 7.1 Session persistence

Default behavior:

- sessions persist across service restarts, Bud reconnects, and browser reconnects
- sessions may become `idle`, but are not auto-closed by default

### 7.2 Explicit close behavior

Manual session close should mean:

- kill the tmux session on the Bud
- mark the DB session row closed
- keep historical output/input linked to that closed session row
- next revisit to the thread creates a fresh session row and fresh tmux session

### 7.3 Thread delete behavior

Thread deletion should remain explicit session teardown:

- if a thread is deleted, its active terminal session should be closed as part of that workflow

## 8. Migration / Implementation Shape

For the recommended option, the implementation should roughly be:

### 8.1 Schema

- drop `terminal_session_thread_id_unique`
- add partial unique index:
  - unique on `thread_id`
  - only where `closed_at IS NULL`

Keep the normal non-unique lookup index on `thread_id`.

### 8.2 Runtime logic

No fundamental rewrite required.

Current logic already fits the recommended model:

- `getSessionForThread()` returns active row only
- `createSessionForThread()` inserts a fresh row when none is active

That logic becomes valid once the DB constraint matches it.

### 8.3 Idle policy

Change the default product policy so idle sessions are not auto-closed.

Possible ways to express that:

- disable `closeStaleIdleSessions()` entirely by default
- treat `TERMINAL_IDLE_CLEANUP_HOURS=0` as disabled
- set the default to a very large value and document that close is normally manual

The cleanest product contract is explicit:

- idle affects status only
- close happens by manual remove or thread deletion

## 9. Why We Are Not Recommending Durable Row Reuse Right Now

At first glance, “one row per thread forever” seems simpler.

In practice it would force us to answer several new questions immediately:

- does `closed_at` still mean anything?
- should a reopened row keep old output byte counters?
- should a reopened row reuse the same log path?
- should the Bud sessions modal still describe the next visit as a “new session”?
- do we need a new state like `stopped` to distinguish “thread slot exists” from “tmux exists”?

Those are all solvable, but they are larger semantic changes than replacing the uniqueness rule.

## 10. Open Questions

### 10.1 Should idle auto-close be removed entirely or just disabled by default?

Recommendation:

- disable by default, keep the capability available behind config if we later need resource pressure controls

### 10.2 Should thread terminal history eventually span multiple session rows?

Under the recommended option, a thread may have multiple historical sessions over time.

Current UI/API behavior only exposes the active session’s terminal stream/history.

That is acceptable for now, but the product should explicitly decide later whether:

- thread terminal history is per-session
- or thread terminal history is an aggregate over all session versions

### 10.3 Do we want a dedicated “reset terminal” action distinct from “close session”?

If users eventually want:

- preserve the thread’s durable terminal slot
- but restart the shell cleanly

then a future explicit reset action may be better than overloading close semantics.

## 11. Decision

For the next implementation step, we should proceed with:

- Option B
- plus “idle does not auto-close by default”

That is the most simple and robust path to the behavior we want without redefining the terminal model midstream.
