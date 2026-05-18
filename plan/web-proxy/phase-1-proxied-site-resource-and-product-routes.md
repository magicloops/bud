# Phase 1: Proxied Site Resource And Product Routes

## Objective

Create the durable product resource that later gateway, client, and agent work
will use. After this phase, authenticated Bud owners can create, list, inspect,
update, disable/delete, and attach proxied sites to threads, but browser traffic
does not yet need to flow through `bud.show`.

## Scope

- Add database tables for durable proxied sites and thread web-view
  attachments.
- Add ownership-aware service helpers.
- Add REST routes for owner-scoped proxied-site lifecycle.
- Add thread web-view attach/detach routes.
- Add generated-friendly endpoint host allocation.
- Add long soft TTL metadata and renewal hooks.
- Add route tests covering ownership boundaries.

## Non-Goals

- No `bud.show` gateway traffic yet.
- No viewer cookies or private bootstrap yet.
- No request bodies, local app cookies, or WebSocket/HMR fidelity yet.
- No agent tools yet.
- No public/password sharing.

## Design Decisions Applied

- Resource name is `proxied_site`.
- Proxied sites belong to Buds and owners, not threads.
- A thread attachment is a pointer to a proxied site.
- First access policy is `private_owner`.
- First endpoint host shape is generated-friendly plus random suffix.
- First TTL is 90 days, renewable while the Bud is active.
- Target hosts are limited to `127.0.0.1`, `::1`, and exact `localhost`.

## Database Work

Add `proxied_site`.

Required columns:

- `id`
- `tenant_id`
- `bud_id`
- `created_by_user_id`
- `display_name`
- `slug`
- `endpoint_host`
- `target_scheme`
- `target_host`
- `target_port`
- `default_path`
- `access_policy`
- `enabled`
- `disabled_at`
- `disabled_by_user_id`
- `expires_at`
- `last_accessed_at`
- `last_renewed_at`
- `created_at`
- `updated_at`

Add `thread_web_view`.

Required columns:

- `thread_id`
- `tenant_id`
- `bud_id`
- `proxied_site_id`
- `created_by_user_id`
- `selected_path`
- `attached_by_user_id`
- `created_at`
- `updated_at`

Expected indexes and constraints:

- `proxied_site.endpoint_host` unique.
- `proxied_site(bud_id, created_by_user_id)`.
- `proxied_site(expires_at)`.
- `thread_web_view.thread_id` primary key or unique.
- foreign keys to Bud, thread, user, and proxied site tables using existing
  project conventions.

Implementation notes:

- Keep `tenant_id` nullable to match current tenancy conventions.
- Stamp `created_by_user_id` from the authorized Bud owner.
- Use ULIDs where the project already uses ULIDs.
- Generate a checked-in Drizzle migration in the implementation branch.

## Route Work

Add Bud-scoped lifecycle routes.

```http
POST /api/buds/:bud_id/proxied-sites
GET  /api/buds/:bud_id/proxied-sites
```

Add proxied-site routes.

```http
GET    /api/proxied-sites/:proxied_site_id
PATCH  /api/proxied-sites/:proxied_site_id
DELETE /api/proxied-sites/:proxied_site_id
```

Add thread attachment routes.

```http
POST   /api/threads/:thread_id/web-view/attach
DELETE /api/threads/:thread_id/web-view
```

Route rules:

- Bud-scoped routes call an ownership-aware Bud helper before reading or
  writing.
- Proxied-site routes call a new `getAuthorizedProxiedSite(...)` helper before
  returning rows.
- Thread attachment routes authorize the thread first, derive the Bud from the
  thread, then verify the proxied site belongs to the same owner and Bud.
- Signed-in non-owners receive `404`.
- Unauthenticated requests receive `401`.
- List endpoints filter by owner in SQL.

## Create Request Validation

Representative body:

```json
{
  "target_host": "127.0.0.1",
  "target_port": 5173,
  "path": "/",
  "title": "Vite app",
  "reuse_existing": true,
  "source": "manual",
  "access_policy": "private_owner"
}
```

Validation:

- `target_host` must be exact `127.0.0.1`, `::1`, or `localhost`.
- `target_port` must be an integer from 1 to 65535.
- `path` must start with `/`; default `/`.
- `access_policy` must be `private_owner`.
- `reuse_existing` defaults true.
- `title` is optional; generate a display name when omitted.
- Reject query-controlled full URLs in this phase. The service owns host/port
  and path parsing.

## Slug And Endpoint Host Allocation

First-pass slug algorithm:

1. Normalize title or target kind to a readable base, for example `vite-dev`.
2. Append a short random suffix, for example `vite-dev-a8f2`.
3. Build endpoint host with configured proxy base domain, for example
   `vite-dev-a8f2.bud.show`.
4. Retry on uniqueness conflict.

Design for future owner overrides:

- Keep `slug` separate from `endpoint_host`.
- Avoid encoding target host/port into permanent IDs.
- Leave room for an override flow that validates slug ownership and reserves
  names.

## TTL And Renewal

Initial behavior:

- `expires_at = now + 90 days` on creation.
- Renewal extends `expires_at` back to `now + 90 days`.
- Renewal happens when the Bud is active and the site is touched by an owner API
  call.
- Later phases can renew on daemon heartbeat or gateway access.

Expiry behavior:

- Expiry marks the site disabled or archived.
- Expiry does not delete the row.
- Disabled/expired sites cannot be attached to a thread or opened by the
  gateway.

## SSE And Internal Events

Define event names and payloads, even if some consumers arrive later:

- `bud.proxied_site.created`
- `bud.proxied_site.updated`
- `bud.proxied_site.deleted`
- `thread.web_view.attached`
- `thread.web_view.detached`

Events should include IDs, ownership-safe metadata, enabled state, endpoint
host, and timestamps. They should not include local app credentials or viewer
tokens.

## Tests

Add route/database tests for:

- Owner can create a proxied site for their Bud.
- Owner cannot create a proxied site for another user's Bud.
- Non-owner lookup returns `404`.
- List endpoint filters in SQL by owner/Bud.
- `reuse_existing` returns an existing matching site for the same Bud/owner.
- The same target can exist for different Buds/users without collision.
- Invalid target hosts are rejected.
- Invalid ports and paths are rejected.
- Thread attach succeeds only when thread and proxied site share Bud/owner.
- Thread detach clears only the authorized thread attachment.
- Disabled/expired sites cannot be newly attached.

## Spec Files To Update During Implementation

- `service/src/db/db.spec.md`
- `service/drizzle/migrations/migrations.spec.md`
- relevant `service/src/routes/*.spec.md`
- relevant `service/src/runtime/*.spec.md` if SSE/event wiring changes
- `docs/proto.md` only if protocol messages are added earlier than planned

## Acceptance Criteria

- Durable proxied-site and thread attachment rows exist with owner stamping.
- Owner-scoped REST routes pass multi-user authorization tests.
- Generated endpoint hosts are unique and stable.
- A thread can attach to and detach from an enabled proxied site.
- Disabled/expired sites are blocked from new attachment.
- Progress and validation checklists are updated.
