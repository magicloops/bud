# Plan: Google service recovery and bounded results

## Context and objective

Fix the reported credential-key lockout, replacement grants after upstream
revocation, lost recent Gmail thread messages, transient refresh failures,
startup failure with an HTTP network origin, and cross-user concurrency limit.
Related specs: [Google](../service/src/google/google.spec.md) and
[connected apps](../web/src/features/connected-apps/connected-apps.spec.md).
Observations: [debug note](../debug/google-service-recovery.md).

## Approach and ownership

- Keep inventory available when stored credentials cannot be decrypted. Let the
  owner clear or reconnect the unusable connection through existing authenticated
  routes. Preserve trusted-Origin checks, session-bound consent, and SQL ownership.
- Accept a replacement Google grant for the selected service without demanding
  scopes that Google already revoked. Never restore locally revoked services.
- Treat transient token/network errors as retryable failures without discarding
  credentials. Only an unusable refresh grant requires consent again. Never retry
  a dispatched write automatically.
- Keep thread results within the existing output budget with valid structured
  JSON, recent messages retained and explicit truncation/omission metadata.
- Defer OAuth callback validation until connection is requested; an unavailable
  optional integration must not prevent the rest of Bud from starting.
- Scope the existing concurrency cap to an owner so users do not block each other.

## Specs and contracts

Update Google and connected-apps specs and relevant setup documentation. Existing
routes and ownership rules remain; document any inventory recovery field. No
database migration or daemon protocol change is expected.

## Validation and rollout

Use synthetic OAuth/Google transports and isolated PostgreSQL fixtures for key
rotation recovery, replacement grants, repeated temporary failures, owner
isolation and concurrency. Test large multibyte threads through tool execution,
HTTP network-origin module loading, and mounted Settings recovery. Run service
and web builds and focused suites. Deploy matching service/web; no migration.
Leave fixes in the working tree for review; no merge is authorized.
