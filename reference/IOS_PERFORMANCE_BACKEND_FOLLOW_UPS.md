# iOS Performance Backend Follow-Ups

**Status:** Proposed. For backend review.
**Audience:** Backend, web platform, iOS
**Date:** 2026-10-03
**Follows:** [`IOS_PERFORMANCE_BACKEND_REQUESTS.md`](IOS_PERFORMANCE_BACKEND_REQUESTS.md)
(R1–R10, mostly delivered in PR #139; status table at its top)

## Purpose

Mobile 0.2.0 adopted the PR #139 contract (`plan/perf/phase-10-*`). Device traces since
then (`plan/perf/baseline.md`, "Request inventory from later traces") and the
missing-final investigation leave a short list of backend asks. None blocks mobile
work; each removes a client-side fallback or a correctness gap.

## At a glance

| ID | Request | Why | Priority |
|---|---|---|---|
| F1 | Stream event when a pending request is created or resolved | Both clients poll `agent/state` every 5 s only for this | Medium |
| F2 | Context budget in `GET /threads/:id/open` | One extra `agent/state` read on every open | Low |
| F3 | Keep full timestamp precision in message cursors | Earlier-history pages can skip rows at a page boundary; mobile now pages automatically | Medium |
| F4 | Account disabled/revoked error (R7, still open) | Required before mobile caches transcripts on disk | Medium |
| F5 | Per-route latency percentiles (rest of R6) | `Server-Timing` exists per request; no distribution to rank work | Low |
| F6 | Confirm worker wake-on-admission (rest of R1) | Not described in the PR #139 handoff | Low |

## F1 — Event for pending-request changes

**Problem.** The PR #139 handoff says pending-request inventories (app-permission
requests, automation activation and bootstrap reviews, questions prompts) are not
guaranteed to emit an event when they change; web keeps a 5-second `agent/state`
fallback and mobile does the same. Device traces show an idle open thread making
11–13 `agent/state` requests a minute. Everything else the client needs (messages
from any device, invocation lifecycle, tool calls, recovery) already arrives on the
stream. A request answered on another device is seen only on the next poll.

**Ask.** On the thread's agent stream, emit an event whenever a pending request is
created or resolved, from any source (this device, another device, a timeout). A hint
is enough: kind and request ID, with the client re-reading `agent/state` once. Include
it in replay like other events.

**Mobile will.** Remove its fallback for each kind as it is confirmed. Until then,
mobile polls only while a pending request is on screen (Phase 4e). Same question as
B24 in `IOS_PERFORMANCE_BACKEND_QUESTIONS.md`.

## F2 — Context budget in `open`

**Problem.** `open` reports `included.context_budget: false`, so mobile reads
`agent/state` right after every `open` only for the budget.

**Ask.** Include the context budget in `open`'s `agent_state` (and set
`included.context_budget: true`), or confirm it is too expensive to compute there.

## F3 — Cursor timestamp precision

**Problem.** Found by the backend during the missing-final investigation
(`reference/ios-agent-work-missing-final-answer.md`, hypothesis A). Cursors encode
`created_at` with millisecond precision while rows store microseconds, so a
`before=` page can skip rows in the boundary millisecond. Mobile now loads earlier
history automatically while scrolling (Phase 12), so more page boundaries are
crossed. The backend reproduced it with literal rows; it did not cause the reported
incident.

**Ask.** Keep exact precision in the opaque cursor, or resolve the cursor row by ID
before querying, as the backend proposed. Do not switch the boundary to `<=`.

## F4 — Account disabled/revoked error (R7)

Unchanged from R7. Mobile needs an explicit, enforced error to decide when to wipe
cached owner data before it stores transcripts on disk (Phase 7b) or starts chat
before `/api/me` returns (Phase 8e).

## F5 — Latency percentiles (rest of R6)

`Server-Timing` is present on nearly every request in the device traces. Per-route
p50/p95 on the service side would let both teams rank work without device traces.

## F6 — Worker wake-on-admission (rest of R1)

R1 asked for the invocation worker to wake on admission instead of polling once a
second. The handoff describes `agent.invocation_changed` but not the wake. Please
confirm whether it shipped; if not, it still saves 0–1 s on every send.

## Still deferred (agreed 2026-09-30)

Transcript revision/deltas and tombstones, durable list resume, shared replay
infrastructure, catalog-version propagation. Current mobile impact:
- **Deltas:** a reopen decodes a full window again; since Phase 3 this runs off the
  main thread (about 24 ms for 276 KB), so lower priority than before.
- **Durable list resume:** a reconnect re-reads the first list page.
- **Catalog version:** mobile removes its duplicate launch read locally (Phase 4b).

## Not a backend request

- Push registration returns 400 against the local HTTPS service but 200 in
  production; mobile is checking its local configuration.
