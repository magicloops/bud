# Phase 1: Message History Contract

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)

---

## Objective

Turn `GET /api/threads/:thread_id/messages` from a capped latest snapshot into a real transcript-history API.

By the end of this phase:

- clients can load the latest page first
- clients can request older pages explicitly
- page metadata makes end-of-history detection explicit
- message ordering is stable and documented

## Current Problem

Today:

- the route only accepts `limit`
- the response is a plain array
- rows are returned newest-first
- there is no supported “load next older page” request
- there is no `has_more` or cursor metadata

That forces clients to improvise around transcript history and makes long-thread UX fragile.

## Scope

### In Scope

- cursor-based paging for thread messages
- stable ordering guarantees
- page metadata
- latest-page and older-page request patterns
- route fixtures and tests

### Out Of Scope

- live agent SSE changes
- assistant text deltas
- UI behavior beyond what is needed to consume the new history contract

## Contract Direction

Target request shapes:

```http
GET /api/threads/:thread_id/messages?limit=50
GET /api/threads/:thread_id/messages?limit=50&before=<opaque_cursor>
GET /api/threads/:thread_id/messages?limit=50&after=<opaque_cursor>
```

Target response shape:

```json
{
  "messages": [],
  "page": {
    "limit": 50,
    "returned": 0,
    "has_more_before": false,
    "has_more_after": false,
    "before_cursor": null,
    "after_cursor": null
  }
}
```

## Implementation Tasks

### Task 1: Add opaque cursors

Use a cursor derived from:

- `created_at`
- `message_id`

Do not rely on timestamp alone.

### Task 2: Guarantee stable ordering

Choose and document one rule:

- query by newest-first internally if convenient
- but return pages oldest-to-newest within the page
- use a stable tie-break such as `(created_at, message_id)`

### Task 3: Return explicit page metadata

Add:

- `has_more_before`
- `has_more_after`
- `before_cursor`
- `after_cursor`
- `returned`
- `limit`

### Task 4: Publish exact examples

Add route fixtures for:

- latest page
- older page via `before`
- empty response at beginning of history

### Task 5: Keep compatibility strategy explicit

Because this repo is still pre-launch, do not contort the contract around backwards compatibility. Update the web client quickly rather than dual-shipping two transcript shapes for long.

## Validation Checklist

- [ ] latest page returns the newest window with explicit metadata
- [ ] `before` returns older messages only
- [ ] `after` returns newer messages only
- [ ] page boundaries are exclusive and documented
- [ ] tied timestamps still produce stable ordering
- [ ] empty/edge pages behave predictably
- [ ] route docs and fixtures match the shipped behavior

## Exit Criteria

This phase is done when both web and mobile can describe transcript history as:

1. load latest page
2. read messages oldest-to-newest within that page
3. use `before` for older history
4. stop when `has_more_before` is false
