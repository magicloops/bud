# Design: Self-Serve Bud Install Commands, One-Time Install Tokens, and Local Mode

> Design document for turning the Bud rail `+` action into a real self-serve install flow that works for both machine-wide and per-directory Bud installs.

**Related Docs**:
- [authentication-and-user-ownership.md](./authentication-and-user-ownership.md)
- [bud-base-dir-and-local-identity.md](./bud-base-dir-and-local-identity.md)

---

## 1. Executive Summary

We want the Bud rail `+` button to open a dialog that gives users a copy/paste install command.

The desired UX is:

1. user clicks `+` in the web app
2. user picks either:
   - a machine-wide Bud
   - a local per-directory Bud
3. user copies a one-line shell command
4. user pastes it on the target machine
5. Bud installs, starts, and ends up owned by the current web user

The current browser claim flow remains important, but it is not the best primary path for the `+` button. The user already has an authenticated browser session open, so the web app should be able to mint a short-lived, single-use install credential that avoids a second QR/login approval step.

### Recommendation

Adopt a two-path model:

1. **Generic install path**
   - command: `curl -fsSL https://get.bud.dev/install.sh | sh -`
   - result: installs Bud, then falls back to the existing browser claim / QR flow
   - purpose: docs, CLI, unauthenticated installs, recovery, and support

2. **Authenticated self-serve install path**
   - produced by the web app from the `+` dialog
   - command carries a short-lived, single-use install token
   - result: installs Bud and auto-binds the new Bud to the current web user without a second browser approval step
   - purpose: fastest path for authenticated users adding a new Bud from the web product

This design also assumes the direction in [bud-base-dir-and-local-identity.md](./bud-base-dir-and-local-identity.md):

- default/global Bud identity remains machine-wide
- `--local` makes a Bud unique to the current directory via a local `.bud/`
- global and local installs must be intentional and user-visible choices in the dialog

---

## 2. Problem Statement

The current `+` button is a placeholder. There is no self-serve install flow in the product UI.

That leaves several problems:

- the user cannot add a Bud directly from the product
- the current claim flow is great for headless recovery, but it is not the fastest path when the user is already logged in on the web
- there is no product-level explanation of "global Bud" versus "local Bud"
- a user installing a second Bud on a machine that already has a global Bud can easily get confused about whether they are reusing the existing Bud or creating a new one
- the current daemon setup still exposes low-level flags rather than a user-facing install model

From first principles, the install experience needs to answer four questions:

1. How does Bud get onto the machine?
2. How does the new Bud become owned by the right user?
3. How does the system distinguish "reuse the machine-wide Bud" from "create a separate local Bud here"?
4. How does the flow stay safe without exposing long-lived credentials?

---

## 3. Design Principles

### 3.1 Installation and ownership are separate concerns

Installing a binary is not the same thing as creating or claiming a Bud identity.

The install flow should clearly separate:

- **binary/runtime installation**
- **Bud identity bootstrap**
- **long-lived daemon operation**

### 3.2 The `+` button should optimize for the user who is already logged in

The user clicked `+` from inside an authenticated web session. Requiring them to copy a command and then scan a QR code on top of that is avoidable friction.

The product should exploit the authenticated browser session to mint a short-lived install credential.

### 3.3 Visible install credentials may be acceptable if they are short-lived and one-time

The current design correctly rejects visible long-lived device secrets.

However, a short-lived single-use install token is different:

- it is not the long-lived Bud credential
- it expires quickly
- it is consumed once
- after use, the daemon receives a proper long-lived `device_secret`

This is a reasonable tradeoff for self-serve copy/paste install UX.

### 3.4 Global and local installs must be explicit

The UI must not imply that every new install is a brand-new Bud.

Users need an explicit choice:

- **Global / machine-wide Bud**
  - reuse or create the default machine Bud identity
- **Local / directory Bud**
  - create or reuse a distinct Bud identity scoped to the current directory

This is especially important on machines that already have a global Bud.

### 3.5 The generic QR claim flow should remain the fallback path

The existing device-claim model should remain available because it still solves:

- unauthenticated installs
- headless recovery
- docs examples
- support/debugging
- cases where the one-time install token expires or cannot be redeemed

The self-serve install flow should build on top of that model, not replace it conceptually.

### 3.6 The install script should be user-level and non-destructive by default

The initial install command should not require `sudo`.

The safest default is:

- install to a user-writable location
- do not overwrite unrelated system binaries
- do not destroy existing identity state
- detect and reuse compatible existing Bud state where appropriate

---

## 4. Goals

- Make the `+` button actually useful as the primary Bud-add entry point.
- Give authenticated users a simple copy/paste install command.
- Support both machine-wide and per-directory Bud installs.
- Avoid exposing the long-lived `device_secret`.
- Preserve the current `installation_id` continuity rules.
- Make the global-vs-local behavior legible before the user runs the command.
- Keep the generic claim / QR flow working as a fallback.
- Keep the design compatible with the future `--base-dir` / `--local` model.

## 5. Non-Goals

- Full implementation of service-manager installs across all OSes in the same tranche.
- Windows-native installer design.
- Multi-user shared Bud management.
- Org/team install flows.
- Unlinking or transferring Bud ownership.
- Solving every future packaging problem in this document.

---

## 6. User Scenarios

### 6.1 First Bud on a machine

User is logged into Bud on the web app and wants to add a new machine.

Expected behavior:

- click `+`
- copy machine-wide install command
- paste it into the target machine
- Bud installs and starts
- Bud appears in the user’s Bud list owned by that user

### 6.2 Add another Bud to a machine that already has a machine-wide Bud

User already has a global Bud on the machine, but now wants a separate project-specific Bud in one repository.

Expected behavior:

- click `+`
- choose Local mode
- run the command from the project directory
- Bud creates or reuses local `.bud/` state there
- it becomes a distinct Bud from the machine-wide one

### 6.3 Reinstall or upgrade the machine-wide Bud

User runs the machine-wide install command on a machine that already has the global Bud.

Expected behavior:

- script detects existing global Bud state
- script does not create a second machine-wide Bud
- script upgrades/reuses the existing install
- service-side identity continuity is preserved

### 6.4 Install without the web app

User sees docs or support instructions and runs:

```bash
curl -fsSL https://get.bud.dev/install.sh | sh -
```

Expected behavior:

- install succeeds
- Bud starts
- because there is no one-time install token, Bud falls back to the existing browser claim / QR flow

---

## 7. Proposed Product Model

## 7.1 Two install surfaces

### Surface A: Generic installer

Canonical public docs command:

```bash
curl -fsSL https://get.bud.dev/install.sh | sh -
```

Properties:

- no authenticated user context
- no pre-issued token
- safe for public docs
- ends in the current QR/link claim flow

### Surface B: Authenticated install command from the web app

Commands shown in the `+` dialog:

Machine-wide:

```bash
curl -fsSL https://get.bud.dev/install.sh | env BUD_INSTALL_TOKEN='bit_...' sh -
```

Local:

```bash
curl -fsSL https://get.bud.dev/install.sh | env BUD_INSTALL_TOKEN='bit_...' sh -s -- --local
```

Properties:

- token is minted from the current authenticated browser session
- token is short-lived and single-use
- no second QR approval is required in the happy path
- the long-lived device secret is still never shown to the user

### Why this split is the right model

The generic installer and authenticated installer solve different needs:

- generic installer is documentation-friendly and portable
- authenticated installer is optimized for the in-product `+` flow

Trying to force one command to be both public and user-bound makes the UX or security model worse.

---

## 8. Install Dialog UX

## 8.1 Modal structure

The `+` button should open a modal with:

1. a short explanation
2. two install modes
3. a copy button for the generated command
4. an advanced section for optional values

Suggested layout:

### Section 1: Install Mode

- **Machine-wide Bud**
  - recommended default
  - "Use this when the machine should have one main Bud."

- **Local Bud (`--local`)**
  - "Use this when the machine already has a global Bud, or when this Bud should be unique to the current directory."

### Section 2: What happens

Machine-wide copy:

- installs Bud if needed
- reuses existing global Bud state if present
- otherwise creates the machine-wide Bud

Local copy:

- run this from the directory that should own the Bud
- uses `--local`
- creates or reuses `.bud/` in that directory
- does not touch the machine-wide Bud identity

### Section 3: Command

- copyable single-line command
- inline label: `Machine-wide` or `Local`
- a short TTL note: "Expires in 10 minutes"

### Section 4: Advanced Options

Optional future fields:

- device name override
- environment / server override
- release channel

V1 can defer these if needed.

## 8.2 Copy text guidance

The modal should explicitly warn:

- machine-wide install reuses the default Bud for this machine if one already exists
- local install should be run from the directory that should own the Bud
- if you are not sure, use machine-wide first

## 8.3 Why the choice belongs in the UI

The remote machine cannot reliably know the user’s intent:

- "reuse existing global Bud"
- "create new local Bud here"
- "upgrade existing local Bud"

So the web UI must make the intent explicit before the command is copied.

---

## 9. Token Model

## 9.1 New token type: install token

Introduce a new short-lived token type for authenticated self-serve install, for example:

- `device_install_token`

Suggested properties:

- opaque random token, not a JWT the client needs to inspect
- single use
- short TTL, e.g. 10-15 minutes
- bound to issuing user id
- optionally bound to environment / deployment
- optionally carries UI hints such as preferred device name

The token is not:

- a browser session
- a long-lived Bud secret
- a reusable enrollment token

It only authorizes the initial install bootstrap.

## 9.2 Why a new token type is justified

We already have:

- Better Auth browser sessions
- Bud `device_secret`
- legacy enrollment tokens
- device-auth claim flow

None of those is the right fit for the `+` dialog:

- browser sessions should not be pasted into shells
- `device_secret` must remain hidden
- legacy enrollment tokens are too close to reusable device credentials
- claim flow is optimized for browser approval, not authenticated copy/paste install

So a dedicated short-lived install token is the cleanest abstraction.

## 9.3 Recommended security properties

- one token can install exactly one Bud bootstrap
- token is consumed on successful redemption
- token redemption returns or triggers issuance of a proper long-lived `device_secret`
- token cannot be used after redemption
- token cannot be refreshed from the shell

## 9.4 Acceptable exposure model

The token will be visible in the copied shell command and therefore may end up in:

- shell history
- terminal logs
- clipboard managers

That is acceptable only because:

- the token is short-lived
- the token is single-use
- the token is not the long-lived Bud credential

This tradeoff should be documented explicitly.

## 9.5 Recommended command shape

Prefer:

```bash
curl -fsSL https://get.bud.dev/install.sh | env BUD_INSTALL_TOKEN='bit_...' sh -s -- --local
```

over:

```bash
curl -fsSL 'https://get.bud.dev/install.sh?token=bit_...' | sh -
```

Reason:

- query parameters are more likely to appear in installer host/CDN logs
- keeping the script URL generic is operationally cleaner

Passing the token through env or shell args is still visible locally, but avoids making the installer URL itself personalized.

---

## 10. How The Install Token Flow Should Work

## 10.1 Web -> service

Authenticated browser requests a new install token:

- `POST /api/device-installs`

Response could include:

- token metadata
- expiry
- pre-rendered machine-wide command
- pre-rendered local command

The web app should not have to construct the command format on its own if we want consistent rollout text across clients.

## 10.2 Shell -> installer

User pastes command on the target machine.

Installer responsibilities:

1. detect OS/arch
2. download Bud binary or release artifact
3. place it in a user-writable managed location
4. launch Bud with the right flags/env
5. pass `BUD_INSTALL_TOKEN` through to the launched Bud

## 10.3 Installer -> daemon

The installer should not itself redeem the token with the service.

Recommendation:

- the installer remains mostly transport/packaging logic
- the daemon redeems the token

Why:

- the daemon already owns identity creation, `installation_id`, and device bootstrap
- token redemption should live next to existing device-auth logic
- keeping service bootstrap inside the daemon avoids splitting identity logic between shell script and Rust code

## 10.4 Daemon -> service

Bud starts with:

- `installation_id`
- optional `device_install_token`
- local/global identity mode already resolved

Then the daemon does:

1. if valid long-lived identity exists, connect normally
2. else if install token exists, redeem it
3. else fall back to the normal device-auth claim flow

Recommended new daemon bootstrap path:

- `POST /api/device-installs/redeem`

Input:

- install token
- `installation_id`
- device metadata
- Bud version / capabilities

## 10.5 Service-side redemption behavior

Recommended behavior:

1. validate token
2. ensure token belongs to the issuing user
3. consume token
4. run the same Bud creation/reuse logic as the browser claim path
5. issue fresh `device_secret`
6. return bootstrap response directly to the daemon

Crucially:

- do not build a second, incompatible ownership model
- reuse the same `installation_id` continuity rules as the existing claim flow

## 10.6 Relationship to existing `device_auth_flow`

Two viable designs exist:

### Option A: Direct install-token redemption

- install token directly returns the new device bootstrap payload

Pros:

- simplest mental model
- fewer round trips

Cons:

- more parallel bootstrap logic

### Option B: Install token creates an internal approved device-auth flow

- service internally creates/approves a `device_auth_flow`
- daemon consumes the result through the same issuance/finalization code path

Pros:

- reuses current claim machinery
- fewer divergent code paths

Cons:

- more internal state transitions

### Recommendation

Prefer **Option B internally**, even if the external daemon API looks like a direct redeem call.

That is:

- externally: daemon calls `redeem install token`
- internally: service uses the same Bud-creation / device-secret issuance logic already used by the claim flow

This keeps ownership and identity continuity rules centralized.

---

## 11. Global vs Local Install Semantics

This section depends on the direction in [bud-base-dir-and-local-identity.md](./bud-base-dir-and-local-identity.md).

## 11.1 Machine-wide install

Machine-wide install means:

- no `--local`
- default/global identity path is used
- default/global `installation_id` is used

If a machine-wide Bud already exists on the machine:

- the install should reuse that state
- it should not create a second machine-wide Bud

If no machine-wide Bud exists:

- it creates the first one

## 11.2 Local install

Local install means:

- Bud is launched with `--local`
- local `.bud/` identity and `installation-id` are used under the current directory or explicit base dir

If local `.bud/` already exists in that directory:

- the install should reuse/upgrade that local Bud

If local `.bud/` does not exist:

- it creates a distinct Bud for that directory

## 11.3 Interaction with an existing global Bud

If a machine already has a global Bud and the user runs the local command:

- the global Bud is left alone
- the local Bud becomes a separate Bud because it has a separate identity and `installation_id`

This is the exact behavior we want.

## 11.4 Non-interactive script behavior

The install script should not stop for an interactive prompt like:

- "A global Bud already exists. Reuse it?"

That is too brittle for a curl-pipe shell flow.

Instead, behavior should be deterministic:

- machine-wide command -> reuse/create the global Bud
- local command -> reuse/create the local Bud for the current directory

The dialog copy should make this explicit before the user runs the command.

---

## 12. Installer Responsibilities

## 12.1 Managed binary location

The installer needs one canonical user-writable location for Bud.

Likely candidates:

- `~/.local/bin/bud`
- `~/.bud/bin/bud`

### Recommendation

Prefer a product-managed path such as:

- `~/.bud/bin/bud`

Why:

- avoids requiring PATH assumptions on day one
- gives Bud a controlled install root
- keeps product-managed files together

The installer can still print a follow-up note about adding that location to PATH later.

## 12.2 What the script should do in v1

Recommended v1 behavior:

1. install or update the Bud binary
2. launch Bud immediately in the current shell
3. let Bud handle bootstrap and connection

This is the minimum complete loop for the `+` button use case.

## 12.3 Background-service setup

Persistent background service installation is valuable, especially for machine-wide Buds, but it adds complexity:

- launchd
- systemd user services
- shell startup differences
- restart/update semantics

### Recommendation

Treat background-service installation as a follow-on tranche unless we decide persistence is required for the first shipping installer.

The design should not block it, but it should not be the core dependency for the first version of the `+` flow.

---

## 13. Failure And Recovery Behavior

## 13.1 Token expired before use

Expected behavior:

- daemon attempts install-token redemption
- service rejects with `expired` or equivalent
- daemon prints a clear message
- daemon falls back to the existing QR/browser claim flow

This avoids making the user restart from scratch.

## 13.2 Token replay or already consumed

Expected behavior:

- service rejects redemption
- daemon prints a clear "install token already used" message
- daemon falls back to browser claim

## 13.3 Existing global Bud state present

Machine-wide install:

- print notice that existing global Bud state was found and reused

Local install:

- ignore global state
- print notice that local mode is using directory-local `.bud/`

## 13.4 Installer download failure

Expected behavior:

- fail before touching existing identity state
- print precise remediation text

## 13.5 Daemon bootstrap failure after install

Expected behavior:

- preserve installed binary
- preserve any created local/global identity state that is still valid
- allow rerun without destructive cleanup

---

## 14. Security Considerations

## 14.1 The install token is a convenience credential

The install token is intentionally less sensitive than `device_secret`, but it still grants meaningful power:

- it can create or bind a Bud owned by the issuing user

So:

- TTL must be short
- it must be single-use
- it should not be reused as a general API token

## 14.2 The long-lived device secret remains hidden

The design preserves the most important invariant:

- `device_secret` is not shown in the browser UI
- `device_secret` is not printed by the installer
- `device_secret` is delivered only to the daemon

## 14.3 The install command is not a substitute for browser auth

The install token exists only because the browser was already authenticated when the command was minted.

It should never become a stand-alone long-term admin primitive.

## 14.4 Auditability

We should record:

- issuing user id
- issued at / expires at
- redeemed at
- redeemed installation id
- resulting bud id
- whether redemption reused an existing Bud or created a new one

This is useful for support and debugging.

---

## 15. Alternatives Considered

## 15.1 Only generic `curl | sh` plus QR claim

Pros:

- simplest implementation
- reuses current claim flow entirely

Cons:

- wastes the authenticated browser session the user already has open
- too much friction for the in-app `+` flow

### Conclusion

Keep as fallback, not as the primary `+` flow.

## 15.2 Reuse legacy enrollment tokens for the `+` flow

Pros:

- less new machinery

Cons:

- wrong trust model
- too easy to drift back toward visible reusable credentials
- not clearly user-bound

### Conclusion

Do not use legacy enrollment tokens as the product-facing `+` flow.

## 15.3 Put the token in the installer URL

Pros:

- prettier one-liner

Cons:

- more likely to leak via access logs/CDN logs
- makes installer URL personalized

### Conclusion

Prefer a generic URL plus env/arg token.

## 15.4 Require QR claim even after running a personalized install command

Pros:

- one bootstrap path

Cons:

- defeats the main point of an authenticated `+` command
- double-auth feels unnecessary

### Conclusion

Do not require a second browser approval in the normal `+` flow.

---

## 16. Recommended Decisions

These are the decisions I recommend locking before implementation:

1. The `+` button becomes a modal that offers **Machine-wide** and **Local** install commands.
2. The public docs command remains `curl -fsSL https://get.bud.dev/install.sh | sh -`.
3. The in-app command uses a **short-lived single-use install token** minted from the current authenticated browser session.
4. The install token is passed via env/args after the pipe, not as a query parameter on the installer URL.
5. Machine-wide install reuses or creates the default global Bud identity.
6. Local install always launches Bud with `--local` and reuses or creates directory-local `.bud/` identity.
7. If install-token redemption fails, the daemon falls back to the normal browser claim / QR flow.
8. The daemon, not the shell script, should redeem the install token with the service.
9. The service should internally reuse the same Bud-creation and device-secret issuance logic as the existing claim flow.
10. V1 should prioritize "install binary and launch Bud now"; background-service installation can follow if needed.

---

## 17. Open Questions

These should be resolved before implementation begins:

### 17.1 Binary install location

Should Bud install to:

- `~/.bud/bin/bud`
- `~/.local/bin/bud`
- another managed location?

### 17.2 Foreground vs persistent service in v1

Should the first shipping installer:

- just launch Bud in the current terminal
- or also install a user-level background service for machine-wide installs?

### 17.3 Device naming in the dialog

Should the modal let the user prefill:

- device name
- tags
- environment label

or should v1 keep the install command minimal and let the daemon infer a default name?

### 17.4 Token TTL

What should the install-token lifetime be?

Candidate range:

- 10 minutes
- 15 minutes
- 30 minutes

### 17.5 Fallback behavior wording

If a token is expired or already used, should the daemon:

- silently continue into QR/browser claim
- or explicitly ask the user to confirm before continuing?

### 17.6 Platform scope for v1

Is v1 explicitly:

- macOS + Linux only
- shell environments with `curl` only
- no Windows support yet

If so, the UI and docs should say that clearly.

### 17.7 Dependency ordering with `--local` / `--base-dir`

Does implementation of this install flow wait for the base-dir/local-identity work to land first, or do we temporarily build on the current `--identity-file` / `--terminal-base-dir` flags and migrate later?

### Recommendation

Prefer making the installer design depend on the new base-dir/local model rather than building the `+` flow on top of flags we already plan to replace.

---

## 18. Suggested Implementation Order

1. Finalize the daemon `--base-dir` / `--local` model.
2. Add install-token issuance and redemption APIs.
3. Build the generic `install.sh` transport.
4. Teach the daemon to redeem install tokens before falling back to QR claim.
5. Add the `+` modal in the web app with machine-wide and local commands.
6. Add analytics/audit logs and clear failure messaging.
7. Decide whether service-manager installation belongs in the same tranche or the next one.

---

## 19. Summary

The key design choice is to treat the `+` button as an **authenticated self-serve installer**, not just a shortcut to the existing claim flow.

That means:

- public `curl | sh` remains the generic fallback
- the in-product `+` flow mints a short-lived install token
- the daemon redeems that token and becomes owned by the current user
- local mode is a first-class choice, not a hidden advanced flag
- the long-lived device secret remains hidden and daemon-only

This gives Bud a clean product story:

- one command for docs
- one better command for logged-in users
- one explicit choice between machine-wide and per-directory Buds
- one consistent ownership and identity model underneath both

---

*Document Version: 1.0*
*Last Updated: 2026-03-16*
