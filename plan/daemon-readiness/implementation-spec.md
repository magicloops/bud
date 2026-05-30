# Implementation Spec: Bud Daemon Production Binary Readiness

**Status**: Draft
**Created**: 2026-05-30
**Review Doc**: [../../review/bud-daemon-production-binary-readiness.md](../../review/bud-daemon-production-binary-readiness.md)
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 1**: [phase-1-daemon-runtime-foundation.md](./phase-1-daemon-runtime-foundation.md)
**Phase 2**: [phase-2-service-claim-and-ownership-flow.md](./phase-2-service-claim-and-ownership-flow.md)
**Phase 3**: [phase-3-release-artifacts-and-manifest.md](./phase-3-release-artifacts-and-manifest.md)
**Phase 4**: [phase-4-installer-preflight-and-user-service.md](./phase-4-installer-preflight-and-user-service.md)
**Phase 5**: [phase-5-web-install-surface-and-docs.md](./phase-5-web-install-surface-and-docs.md)
**Phase 6**: [phase-6-validation-rollout-and-follow-ups.md](./phase-6-validation-rollout-and-follow-ups.md)

---

## Context

The Bud daemon is structurally healthy enough to productize, but the current shipping surface is still development-shaped:

- users build from source with Cargo
- defaults point at localhost and `bud-dev`
- terminal support is disabled by default
- tmux is only capability-probed after startup
- there is no hosted artifact channel, installer, update path, uninstall path, or service manager integration
- one-command onboarding still needs a service-generated claim/install flow

The production direction is now settled:

- API origin: `https://api.bud.dev`
- daemon WebSocket URL: `wss://api.bud.dev/ws`, unless the final service route changes
- installer and artifact origin: `https://get.bud.dev`
- public install command: `curl -fsSL https://get.bud.dev/install.sh | sh`
- authenticated web-generated command: service-generated, includes a 10 minute single-use claim/install identifier
- default production install: one user-scoped machine Bud per OS user account
- local/workspace Buds: developer/advanced path only after `--base-dir` and `--local` exist
- process model: user-level service by default on macOS launchd and Linux systemd user services, foreground fallback elsewhere
- tmux: required host dependency for terminal support, not bundled and not silently installed in v1
- first supported OS matrix: macOS 13+ arm64/x64 and Ubuntu 22.04/24.04 x64

## Objective

Ship Bud as a production-quality downloadable daemon binary that a signed-in or unauthenticated user can install with one copyable shell command.

The shipped path must:

- install a verified prebuilt `bud` binary without requiring Rust, Cargo, `protoc`, or the repo
- configure the daemon against production service endpoints
- preflight host dependencies and print local, OS-specific remediation for tmux and certificate/runtime issues
- claim/register the daemon to the correct authenticated user when a web-generated claim identifier is present
- preserve QR/link claim fallback for tokenless public installs
- run as a user-level background service where supported
- keep foreground mode available for development and unsupported systems
- avoid silently taking over an existing claimed Bud identity

## Non-Goals

- bundling tmux into the Bud artifact
- silently installing tmux through package managers
- privileged system-wide daemon installation
- first-class non-systemd Linux service management in v1
- making workspace-local Buds the default production path
- shipping a Homebrew formula in the first tranche
- replacing tmux with another terminal backend
- broad Linux distro support beyond the initial Ubuntu x64 validation matrix

## Product Contract

### Public command

The public command is tokenless and uses browser/QR approval:

```bash
curl -fsSL https://get.bud.dev/install.sh | sh
```

### Authenticated web command

The authenticated web app asks the service for a generated command. The service owns command construction so TTL, audit, environment variables, and future installer flags stay consistent.

Preferred v1 shape:

```bash
curl -fsSL https://get.bud.dev/install.sh | env BUD_CLAIM_ID='bic_...' sh
```

`BUD_CLAIM_ID` is an opaque, high-entropy bearer claim/install identifier. It should not be a guessable database row id.

### Claim/install identifier

- lifetime: 10 minutes
- redemption: single-use
- issuer: authenticated browser user
- owner stamping: redeemed Bud rows inherit the issuing user
- audit: issuance, redemption, expiration, user agent/IP where available, and resulting `bud_id`
- fallback: absent or expired identifiers fall back to normal QR/link claim only when that does not risk silently claiming to the wrong user

### Default install scope

V1 production installs create one user-scoped machine Bud:

- install root: `~/.bud`
- binary: `~/.bud/bin/bud`
- identity/config/state under the effective Bud base directory
- process runs as the OS user, not root
- service is a per-user launchd/systemd unit

Workspace-local Buds remain useful for development and multi-account testing, but production docs should not lead with them.

## Phase Overview

| Phase | Document | Primary Outcome |
|-------|----------|-----------------|
| 1 | [phase-1-daemon-runtime-foundation.md](./phase-1-daemon-runtime-foundation.md) | Daemon config, identity roots, production defaults, `bud doctor`, and codec hardening are ready for installer use |
| 2 | [phase-2-service-claim-and-ownership-flow.md](./phase-2-service-claim-and-ownership-flow.md) | Authenticated web users can mint 10 minute single-use claim identifiers and daemons can redeem them safely |
| 3 | [phase-3-release-artifacts-and-manifest.md](./phase-3-release-artifacts-and-manifest.md) | CI publishes versioned, checksummed daemon artifacts and a release manifest to `get.bud.dev` |
| 4 | [phase-4-installer-preflight-and-user-service.md](./phase-4-installer-preflight-and-user-service.md) | `install.sh` installs verified artifacts, runs preflight, and configures launchd/systemd user services |
| 5 | [phase-5-web-install-surface-and-docs.md](./phase-5-web-install-surface-and-docs.md) | Web and docs expose the public and authenticated install commands with capability disclosure and recovery paths |
| 6 | [phase-6-validation-rollout-and-follow-ups.md](./phase-6-validation-rollout-and-follow-ups.md) | Clean-machine validation, rollout gates, observability, and follow-up packaging work are complete |

## Impacted Areas

### Bud daemon

- `bud/src/config.rs`
- `bud/src/app.rs`
- `bud/src/identity.rs`
- `bud/src/claim.rs`
- `bud/src/proto_wire.rs`
- `bud/src/terminal/registry.rs`
- `bud/build.rs`
- `bud/Cargo.toml`
- new service-management/preflight modules if needed

### Service

- device claim/bootstrap routes under `service/src/routes/`
- device claim persistence under `service/src/db/schema.ts`
- Bud ownership helpers and route authorization
- generated install command API for authenticated browser users
- deploy env for production API and installer origins

### Web

- add-device/install surface
- claim approval route copy and expired/redeemed states
- capability disclosure for terminal, file read, and localhost proxy
- QR fallback route behavior

### Release/infra

- CI artifact build jobs
- release manifest generation
- artifact hosting under `https://get.bud.dev`
- optional code-signing/notarization/provenance setup

### Documentation/specs

- `bud/bud.spec.md`
- `bud/src/src.spec.md`
- `service/service.spec.md`
- `service/src/db/db.spec.md`
- `service/src/routes/routes.spec.md`
- `service/drizzle/migrations/migrations.spec.md` if schema changes are generated
- `web/web.spec.md`
- `web/src/routes/routes.spec.md`
- `docs/proto.md` only if daemon-service payload shapes change
- `bud.spec.md`

## Ownership And Authorization Contract

This plan adds browser-facing install/claim APIs, so ownership must be explicit:

- Install/claim issuance is owned by the authenticated browser user.
- List/read endpoints for claim records must filter in SQL by `created_by_user_id`.
- Redemption must not trust a raw `bud_id`, `claim_id`, or `session_id` from a client without resolving ownership server-side.
- A redeemed Bud row must be stamped with `created_by_user_id` from the issuing claim owner.
- If an authenticated user tries to inspect another user's install claim, return `404`.
- If an unauthenticated browser request hits the issuance/read surface, return `401`.
- The daemon redemption endpoint is bearer-token based and must be limited by high entropy, hash-at-rest storage, TTL, single-use state, and audit logging.
- Validation items for install/claim ownership must be added to `plan/init-auth/validation-checklist.md` when implementation begins.

## Key Design Decisions

- Bud does not bundle tmux for v1.
- Installer does not silently install tmux.
- `--install-deps` is a possible follow-up, not a v1 requirement.
- User-service install is the production default on launchd/systemd.
- Foreground mode remains supported for development and unsupported Linux.
- Non-systemd Linux is unsupported for managed service installation in v1.
- Homebrew formula is follow-up, not a launch blocker.
- macOS support is defined by tested macOS 13+ releases, not by the current binary's lower load-command minimum.
- Linux GNU artifacts should be built with a controlled glibc floor; if built on Ubuntu 22.04, document glibc 2.35+.

## Dependencies And Prerequisites

- Production API and installer DNS are available:
  - `api.bud.dev`
  - `get.bud.dev`
- The production service exposes the final daemon WebSocket route.
- The deployment environment can serve long-lived WebSocket connections at `wss://api.bud.dev/ws`.
- CI has access to platform runners or cross-build infrastructure for the first artifact matrix.
- Release artifact hosting supports immutable versioned URLs plus a stable channel manifest.
- Database migrations can be generated and applied for new install-claim tables.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Installer claims a device to the wrong user | Medium | High | Service-generated high-entropy claim identifiers, 10 minute TTL, single-use redemption, owner stamping from claim owner, explicit fallback behavior |
| Missing tmux creates a "connected but useless" Bud | High | High | Installer preflight plus `bud doctor` fail/warn locally before service startup is treated as healthy |
| User-service install fails silently | Medium | High | `bud service status`, log paths, validation on launchd/systemd, foreground fallback |
| Existing Bud identity is overwritten | Medium | High | Installer must detect existing identity/config and refuse destructive overwrite without an explicit future reclaim flow |
| Linux artifact accidentally requires too-new glibc | Medium | Medium | Build in a controlled Ubuntu 22.04/sysroot environment and document the floor |
| Artifact tampering or partial download | Low | High | SHA-256 manifest verification, TLS, optional signing/provenance |
| Workspace/file scope is too broad by default | Medium | High | Make user-scoped machine install explicit, disclose capabilities, avoid making workspace-local mode public until base-dir/local semantics are correct |
| Shell installer becomes untestable | Medium | Medium | Keep installer small, shellcheck it, test in clean macOS and Ubuntu environments |

## Rollout Strategy

1. Land daemon runtime foundations and codec hardening.
2. Land service/web claim ownership flow behind a non-public flag.
3. Publish internal release artifacts and manifest from CI.
4. Validate installer against internal/staging hosts.
5. Add launchd/systemd user-service setup and status commands.
6. Expose authenticated generated commands in the web app.
7. Publish public tokenless install docs.
8. Gate production rollout on the validation checklist.

## Definition Of Done

- [ ] `curl -fsSL https://get.bud.dev/install.sh | sh` installs a verified daemon binary on supported platforms.
- [ ] Authenticated web users can copy a service-generated command that redeems a 10 minute single-use claim identifier.
- [ ] The daemon uses production endpoints by default in production installs.
- [ ] Missing tmux produces clear local instructions and does not leave users thinking terminal support works.
- [ ] The daemon can run as a launchd user agent on macOS and a systemd user service on supported Linux.
- [ ] Foreground mode remains available and documented.
- [ ] Existing claimed Bud identities are not overwritten silently.
- [ ] Release artifacts are versioned, checksummed, and published from CI.
- [ ] Clean-machine validation passes on macOS 13+ arm64/x64 and Ubuntu 22.04/24.04 x64.
- [ ] Relevant specs, protocol docs, DB migration docs, and user docs are updated.
