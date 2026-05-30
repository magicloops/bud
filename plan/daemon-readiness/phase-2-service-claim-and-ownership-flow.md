# Phase 2: Service Claim And Ownership Flow

## Objective

Add the authenticated install-claim flow that lets the web app show one command which binds the installed daemon to the current signed-in user.

The public tokenless command still uses QR/link approval. This phase adds the service-generated command path.

## Resource Ownership

Install claims are browser-facing auth resources and must be user-scoped from the first implementation.

Owner model:

- the authenticated browser user creates an install claim
- the install claim is stamped with `created_by_user_id`
- the daemon redeems the claim using a high-entropy bearer identifier
- the resulting `bud.created_by_user_id` is inherited from the claim owner
- thread/message/session ownership continues to inherit from the Bud owner through existing paths

Authorization:

- browser create/list/read routes require authentication
- browser reads filter by owner in SQL
- another signed-in user's claim returns `404`
- unauthenticated browser requests return `401`
- daemon redemption does not use browser cookies; it relies on a high-entropy, hash-at-rest, TTL-bound, single-use bearer identifier

Validation requirement:

- add claim-flow ownership cases to `plan/init-auth/validation-checklist.md` when implementation starts

## Data Model

Add a table or equivalent durable store for install claims.

Recommended columns:

- `id` ULID primary key
- `claim_token_hash` unique, high-entropy bearer hash
- `created_by_user_id`
- `tenant_id` nullable for current single-tenant behavior
- `device_name_hint` nullable
- `install_scope` enum/string, initially `machine`
- `expires_at`
- `redeemed_at` nullable
- `redeemed_bud_id` nullable
- `redeemed_installation_id` nullable
- `redeemed_user_agent` nullable
- `redeemed_ip` nullable where infrastructure safely provides it
- `created_at`
- `updated_at`

Naming note: the shell variable can remain `BUD_CLAIM_ID`, but it should carry an opaque bearer value. Do not expose a guessable database id as the redeem credential.

Database workflow:

- edit `service/src/db/schema.ts`
- run `pnpm db:push` locally from `service/`
- run `pnpm db:generate` for deployable migrations
- update `service/src/db/db.spec.md`
- update `service/drizzle/migrations/migrations.spec.md`

## API Contract

### Browser issuance

Add an authenticated browser endpoint such as:

```http
POST /api/device-install-claims
```

Response should include:

- `claim_id` or `claim_token`, using final naming
- `expires_at`
- `install_command`
- `public_install_command`
- optional QR/link fallback metadata if the UI needs it

The service, not the web client, assembles `install_command`.

Example command:

```bash
curl -fsSL https://get.bud.dev/install.sh | env BUD_CLAIM_ID='bic_...' sh
```

### Daemon redemption

The daemon should send the claim identifier during bootstrap before QR fallback.

Implementation options:

- extend `/api/device-auth/start` to accept an optional install claim identifier
- add a narrow `/api/device-auth/install/redeem` bootstrap endpoint

Pick the option that preserves the cleanest existing claim state machine. In either case:

- expired claims fail explicitly
- already redeemed claims fail explicitly
- successful redemption issues the same long-lived `device_secret` shape used by QR approval
- long-lived `device_secret` remains daemon-only and is never embedded in the shell command

## Existing Identity Behavior

Installer/daemon must not silently overwrite an existing claimed identity.

V1 behavior:

- if a valid local identity exists, keep it
- if the web-generated claim belongs to the same user, reconnect/reuse can be allowed only after the service proves ownership
- if ownership cannot be proven locally and safely, stop with instructions instead of reclaiming
- account switching/reclaim is a follow-up product flow unless explicitly implemented in this phase

## Expected Code Areas

- `service/src/db/schema.ts`
- `service/src/routes/`
- `service/src/auth/`
- `service/src/ws/` only if handshake/claim state changes
- `bud/src/claim.rs`
- `bud/src/config.rs`
- `bud/src/app.rs`
- web install route/components in Phase 5 consume this API; avoid building full UI here unless needed for validation

## Tests

Service:

- authenticated user can create claim
- unauthenticated browser create returns `401`
- user cannot read another user's claim
- expired claim cannot redeem
- redeemed claim cannot redeem twice
- successful redemption stamps `bud.created_by_user_id`
- device secret is not returned to browser issuance route

Daemon:

- claim id is sent during bootstrap when configured
- expired/invalid claim falls back or fails according to the chosen UX contract
- QR fallback still works without claim id

DB:

- migration includes table, indexes, unique constraints, and nullable tenant/user columns as designed

## Spec Files To Update

- `service/src/db/db.spec.md`
- `service/drizzle/migrations/migrations.spec.md`
- `service/src/routes/routes.spec.md`
- `service/service.spec.md`
- `bud/src/src.spec.md`
- `bud/bud.spec.md`
- `docs/proto.md` only if wire protocol or daemon bootstrap payload documentation changes
- `plan/init-auth/validation-checklist.md`

## Exit Criteria

- [x] authenticated web users can mint a 10 minute single-use claim identifier
- [x] the service returns a complete copyable install command
- [x] daemon redemption binds the Bud to the claim owner
- [x] QR/link claim fallback still works for tokenless installs
- [x] existing claimed identities are not overwritten silently
- [x] ownership tests cover cross-user access and redemption
- [x] checked-in migrations exist for schema changes
