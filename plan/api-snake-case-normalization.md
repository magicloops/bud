# Plan: API Snake Case Normalization

## Context
- Link to issue(s): follow-on implementation work from [design/mobile-chat-thread-first-backend-contract.md](../design/mobile-chat-thread-first-backend-contract.md) and the mobile handoff in [reference/IOS_CHAT_BACKEND_HANDOFF.md](../reference/IOS_CHAT_BACKEND_HANDOFF.md).
- Related spec files:
  - [service/service.spec.md](../service/service.spec.md)
  - [service/src/src.spec.md](../service/src/src.spec.md)
  - [service/src/routes/routes.spec.md](../service/src/routes/routes.spec.md)
  - [service/src/runtime/runtime.spec.md](../service/src/runtime/runtime.spec.md)
  - [service/src/ws/ws.spec.md](../service/src/ws/ws.spec.md)
  - [web/web.spec.md](../web/web.spec.md)
  - [web/src/src.spec.md](../web/src/src.spec.md)
  - [web/src/lib/lib.spec.md](../web/src/lib/lib.spec.md)
  - [web/src/routes/routes.spec.md](../web/src/routes/routes.spec.md)
  - [web/src/components/workbench/workbench.spec.md](../web/src/components/workbench/workbench.spec.md)
  - [bud/bud.spec.md](../bud/bud.spec.md)
  - [bud/src/src.spec.md](../bud/src/src.spec.md)
  - [docs/proto.md](../docs/proto.md)

## Objective
- Normalize Bud-owned wire contracts to `snake_case` across the in-use chat/mobile surface.
- Remove the remaining mixed-case JSON leaks in the current backend and update the web app to consume the normalized contract.
- Capture any small SSE or Bud-protocol stragglers in the same pass if they are truly external payload fields.

Acceptance criteria:
- The audited REST responses and request/response examples used by web and mobile no longer mix `camelCase` and `snake_case`.
- The web app runs against the normalized contract without compatibility shims.
- Any in-scope SSE or Bud↔Service payload fields exposed to clients are also `snake_case`.
- Specs and protocol docs reflect the final contract.

## Design / Approach
- Treat this as a wire-format cleanup, not a repo-wide symbol rename.
- Change service responses directly and update the web client in the same tranche.
- Do not ship dual fields or backward-compatibility aliases. The web app is still under active development, and the user explicitly does not want compatibility work here.
- Keep internal TypeScript and Rust identifiers in their native style where that improves implementation clarity. Translate at the API boundary instead of forcing internal code to mirror the wire shape everywhere.

### In-Scope REST payload normalization

Current confirmed JSON leaks:
- `POST /api/threads` returns `{ threadId }` and should return `{ thread_id }`.
- `POST /api/threads/:threadId/messages` returns `{ messageId }` and should return `{ message_id }`.
- `POST /api/runs` returns `{ runId, threadId }` and should return `{ run_id, thread_id }`.
- `GET /api/models` returns:
  - top-level `defaultModel` → `default_model`
  - per-model `displayName` → `display_name`
  - per-model `isAlias` → `is_alias`
  - per-model `aliasTarget` → `alias_target`

Implementation notes:
- Requests already largely use `snake_case` on the service side (`bud_id`, `thread_id`, `reasoning_effort`), so the main work is response cleanup rather than request redesign.
- Keep route paths stable. This plan is about JSON/event contracts, not renaming every internal router param from `threadId` to `thread_id`.

### In-Scope stream payload normalization

Current confirmed stream leak:
- Terminal session status events emitted as `bud.online` / `bud.offline` currently carry `data: { budId }`; these should emit `data: { bud_id }`.

Audit requirement:
- Re-check agent, terminal, and run SSE payloads during implementation and normalize any remaining external `camelCase` keys found in active routes.
- Do not widen scope to legacy unused stream surfaces unless they are still documented as active.

### Bud daemon / WebSocket protocol scope

Current assessment:
- The active Bud↔Service terminal/run payload fields already appear to be predominantly `snake_case`.
- The current mismatch is more about documentation drift and internal variable naming than obvious live `camelCase` wire payloads.

Plan:
- Audit the active daemon-facing payload examples while implementing the service changes.
- If a real Bud-facing `camelCase` frame field is found, normalize it in the same tranche and update both service and daemon.
- If no such leak exists, keep the daemon code unchanged and limit the protocol work to doc cleanup in [docs/proto.md](../docs/proto.md).

### Web app changes

Update the web client to consume the normalized API contract in one pass:
- route loaders and submit handlers under `web/src/routes/$budId/*`
- shared model DTO typing used by the composer
- any stream payload parsing that currently expects `budId`

Guiding rule:
- normalize at the fetch boundary
- keep internal UI prop names and route params unchanged unless a local rename is clearly worth the churn

### Fixtures and documentation

Refresh the example payloads and route notes used by the mobile team:
- thread creation response
- send-message response
- models payload
- stream event examples where casing changed

This includes the design/spec docs and any root-level or plan-level handoff docs that currently show the old mixed casing.

## Spec Files to Update
- [ ] `service/src/routes/routes.spec.md`
- [ ] `service/src/src.spec.md`
- [ ] `service/src/runtime/runtime.spec.md`
- [ ] `service/src/ws/ws.spec.md` if stream payload casing changes are confirmed
- [ ] `web/src/lib/lib.spec.md`
- [ ] `web/src/routes/routes.spec.md`
- [ ] `web/src/components/workbench/workbench.spec.md`
- [ ] `web/src/src.spec.md`
- [ ] `bud/bud.spec.md` if a daemon payload change is required
- [ ] `bud/src/src.spec.md` if a daemon payload change is required
- [ ] `docs/proto.md`
- [ ] `bud.spec.md`

## Impacted Contracts
- [ ] WSS protocol
- [x] SSE events
- [ ] DB schema (drizzle-kit push)
- [ ] Agent tools
- [x] Web UI

## Test Plan
- Add or update focused backend tests for the renamed REST responses.
- Add or update stream-level validation for any renamed SSE payload keys.
- Run the relevant web typecheck/build flow to catch boundary typing regressions.
- Manually verify the current web flow:
  - fetch models
  - create thread
  - send first message
  - send message in existing thread
  - reconnect to thread/terminal stream if SSE payloads changed
- If a Bud protocol change is required, run the daemon against the updated service and verify the affected frame flow end to end.

## Rollout
- Land this as one coordinated backend + web contract cleanup.
- Do not preserve the old field names in parallel.
- Update handoff/design/protocol docs in the same change so mobile and web have one canonical contract.
- If the daemon surface ends up unchanged, call that out explicitly in the final implementation summary so the scope stays clear.
