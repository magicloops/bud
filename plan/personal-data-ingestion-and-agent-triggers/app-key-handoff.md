# Approved app-key handoff

Status: backend setup and agent/client integration are implemented and fixture-tested; live opposite-client setup and full channel acceptance remain pending. See the [helper usage](backend-app-setup.md).
Parent: [phase 7](phase-7-approved-app-api-keys.md).

## Decision

Use an app-backend-generated RSA public key to encrypt the approved query
credential. The backend retrieves the encrypted envelope from the main API,
stores the decrypted credential locally, then acknowledges installation with a
signature. The service stores the verification hash and encrypted envelope, never
recoverable plaintext escrow. This needs no daemon protocol change.

The existing terminal channel persists authoritative command input/output and
cannot carry the credential. Existing proxy helpers provide owner-private HTTP
streaming, but their current browser-facing reply path is not a secret installer.
The app's outbound HTTPS connection to the main API supplies a direct delivery
channel, independent of proxy transport. The existing private proxied site still
protects access to the example app itself.

## Setup and ownership

1. A supplied backend helper generates a separate RSA-3072 installation key pair
   in an application-private directory outside the Git worktree and web root.
   Directory mode is 0700; private files are 0600. It exposes only the public SPKI
   key and its SHA-256 fingerprint as setup metadata. Do not print private material.
2. `data.request_api_key` includes that public key and an owned private
   `proxied_site` destination, alongside immutable requested scopes, fields,
   precision, history, label and purpose. The service resolves owner, Bud,
   thread, invocation and tool identity; it checks site ownership and the same
   Bud. The public key alone grants no authority. Approval displays the site and
   key fingerprint; changing either requires a new request.
3. Approval in either first-party client atomically creates one key verification
   record and one encrypted envelope, bound to request ID, key ID, recipient
   fingerprint and setup expiry. The API key has 256 random secret bits and a
   public ULID. A unique request/key relationship prevents reminting on retry.
4. The helper retrieves the envelope using a signature from the installation
   private key. The retrieval signature is bound to request ID, recipient and
   expiry, and authorizes only retrieval of that request's ciphertext. It cannot
   query data, approve, revoke, or acknowledge installation. It is never exposed
   to the model. The helper learns the non-secret request ID from normal setup
   metadata; it can safely survive terminal/transcript storage.
5. The helper decrypts with RSA-OAEP/SHA-256 and the exact context as OAEP label,
   atomically writes and fsyncs the credential, then signs a distinct `installed`
   receipt bound to request/key/ciphertext digest/expiry. The service verifies the
   receipt before marking installed. App queries become available only after this
   acknowledgement. Ordinary agent results contain only IDs and status.

Use strict bounded public SPKI input, RSA modulus 3072 or 4096, exponent 65537,
OAEP SHA-256 and PSS SHA-256 signatures with 32-byte salt. Reject private-key
input, unsupported algorithms, malformed encodings and mismatched context with
fixed errors that do not echo input. Encryption and signing have distinct labels.

## Recovery and revocation

The default setup deadline is 24 hours after approval. Retrying retrieval before
that deadline returns the original ciphertext/key, including after a service
restart. An app crash before local persistence retries decryption. A crash after
persistence but before acknowledgement retries the signed receipt; an accepted
receipt is idempotent. Delete ciphertext at installation, revocation or expiry.
Persist the ciphertext digest so a lost acknowledgement response can be retried
after deletion. Do not infer installation from successful HTTP delivery alone.

Lost installation private material or expired setup fails visibly and revokes the
unusable query key. A new human-approved request is required; do not silently
rotate. Revocation wins against retrieval and installation in an owner-locked
transaction and is checked again before returning query results. Do not return
the decrypted key, signature or installation private key through normal API-key
inventory, tool results, SSE, logs or frontend assets.

## Mixed versions and acceptance

No daemon upgrade is required: new service/old daemon and old service/new daemon
retain existing terminal/proxy behavior. An old service returns unsupported for
the new setup API; the helper reports that status without a terminal-secret
fallback. The existing private-site proxy capability is required only to view
the example app. The app backend must reach the configured main API origin.

Required tests include wrong-recipient/context rejection, retrieval-versus-receipt
domain separation, approval races, interrupted install, expired/revoked setup,
cross-owner access, private-file durability/permissions, and absence of secrets
in all ordinary serializers. Crypto unit tests alone do not satisfy phase 7.


## September 6 ordinary-channel review

Reviewed full current files without reading real credentials:

| Boundary | Finding | Evidence scope |
|---|---|---|
| `app-keys.ts` ordinary inventory/decision/revoke | Explicit request/key serializers omit verification hash, ciphertext and proof; minting seals the credential before persistence | Source review; repository/HTTP tests in the 119-test consolidated pass |
| `app-key-routes.ts` | Human, app-query and signed-setup authentication are separate; no-store and fixed route errors; setup ciphertext is returned only after possession proof | Source review; actual issuer/proxy/global logging behavior remains separate |
| `app-key-backend.mjs` | Private credential persistence precedes receipt; initialize/install return public metadata/status; query supplies credential only in outbound authorization to the pinned origin | Source review and helper tests; a generated app must still keep state outside served assets |
| `agent/app-permission-tool.ts` | Tool accepts public installation key and scoped request, describes human approval and backend-only setup | Catalog review; actual selected-model behavior remains to observe |
| `agent/invocation-view.ts` | Explicit invocation fields contain lifecycle/provenance, no action evidence or credential fields | Source review |
| `agent/invocation-app-data.test.ts` | Real local HTTP approval/install/query/revoke plus replay fixture checks raw credential absence from approved metadata, restored results, provider replay, install result and query result; stored ciphertext is cleared after installation | Passed in `/tmp/bud-personal-data-regression-latest.log`; synthetic identity/issuer/provider, not a live UI demonstration |

No defect was identified in these reviewed boundaries. This is **not** closure of
K5: it does not inspect a live agent-built app's terminal input/output, emitted
SSE, infrastructure logs, deployed frontend assets or Git history. The private
example HTTP fixture is reached directly on loopback and does not establish the
owner-authenticated preview/foreign-viewer gate K8. Those distinctions must remain
in the final evidence record; no raw real key should be printed to test absence.


Private-preview supplemental evidence: `routes/proxied-sites.test.ts` now supplies
an otherwise valid viewer-session fixture belonging to another user and verifies
both HTTP and WebSocket gateway rejection before daemon operation allocation.
The route regression suite passes (`/tmp/bud-private-viewer-regression.log`), as
does the service build (`/tmp/bud-private-viewer-build.log`). Database/session
lookups are mocked in this suite; it verifies the handler's owner comparison and
allocation ordering, not real cookie issuance, SQL filtering or browser transport.
K8's live owner/foreign preview demonstration remains open.
