# Bud Daemon

Rust device daemon that connects to the service over `/ws` or the opt-in Phase 2 gRPC control stream, maintains terminal capability state, and now bootstraps auth through the browser-mediated device-claim flow.

## Setup

```bash
cd bud
cargo fmt
cargo build
```

Prepare an isolated development environment from `bud/`:

```bash
source ../dev/daemon-env.sh https   # or http for ws://localhost:3000/ws
BUD_BROWSER_TRACE=1 cargo run -- --terminal-enabled
```

This keeps the existing Cargo workflow while selecting `~/.bud-dev`, a separate
claim/identity, terminal storage and browser profiles. Production installed from
get.bud.dev stays in `~/.bud`. The setup clears legacy identity/terminal path,
enrollment, gRPC and browser-executable/helper overrides; tracing, browser mode
and local LLM settings are preserved. Source it **after** any existing `.env`
setup. It never edits that file, moves state, claims a Bud or starts a daemon.

Customize through `BUD_DEV_BASE_DIR`, `BUD_DEV_SERVER_URL`,
`BUD_DEV_DEVICE_NAME` and `BUD_DEV_DEFAULT_CWD` before sourcing. The base must not
overlap `~/.bud`, including through symlinks. A local daemon can use localhost
while mobile connects to the service through ngrok; the endpoints need not match.
The `.env.example` and `.env.https.example` shell templates also select `.bud-dev`.

Bud loads `<selected base>/bud.env` as defaults before starting Tokio. For direct
commands, CLI flags win over exported shell settings, which win over file
settings. Managed startup clears inherited `BUD_*` settings and uses its own
file plus a pinned base; configure its server in that file. The file cannot
redirect its base or place identity/terminal storage outside it. This also means
`browser prepare`'s persisted headed choice is available to the next Cargo run
unless explicitly overridden in the shell.

Inspect build metadata with:

```bash
bud --version
```

Release artifacts include the package version, build commit, target triple, and build profile in that output.

## Important Env / Flags

| Env | Flag | Purpose |
|-----|------|---------|
| `BUD_SERVER_URL` | `--server` | Service WebSocket URL. For local service dev: `ws://localhost:3000/ws` |
| `BUD_GRPC_CONTROL_URL` | `--grpc-control-url` | Optional gRPC control endpoint, for example `http://127.0.0.1:50051`; when set, Bud uses tonic control instead of WebSocket |
| `BUD_CLAIM_ID` | `--claim-id` | Optional service-generated install claim identifier for authenticated one-command setup |
| `BUD_DEVICE_NAME` | `--name` | Device name shown during claim and in the UI |
| `BUD_BASE_DIR` | `--base-dir` | Base directory for identity, installation id, terminal logs, and future daemon state |
| `BUD_LOCAL` | `--local` | Use `.bud` under the launch directory as the default base dir and use the launch directory as the default cwd |
| `BUD_DEFAULT_CWD` | `--cwd` | Default working directory |
| `BUD_IDENTITY_FILE` | `--identity-file` | Path to persisted `{ bud_id, device_secret }` |
| `BUD_TERMINAL_BASE_DIR` | `--terminal-base-dir` | Base directory for terminal logs and session artifacts |
| `BUD_TERMINAL_ENABLED` | `--terminal-enabled` | Enable terminal features |
| `BUD_LOCAL_LLM_DS4_URL` | `--local-llm-ds4-url` | Optional loopback ds4 API origin, without `/v1`, for Bud-local ds4 forwarding |
| `BUD_LOCAL_LLM_DS4_CONTEXT_TOKENS` | `--local-llm-ds4-context-tokens` | Context-window metadata advertised for local ds4 |
| `BUD_LOCAL_LLM_DS4_MAX_OUTPUT_TOKENS` | `--local-llm-ds4-max-output-tokens` | Max-output metadata advertised for local ds4 |
| `BUD_DEBUG` | `--debug` | Extra Bud logging |
| `BUD_ENROLLMENT_TOKEN` | `--token` | Legacy/manual enrollment fallback |

For the optional local HTTPS profile, copy
[bud/.env.https.example](./.env.https.example) to `.env` or set
`BUD_SERVER_URL=wss://localhost:3443/ws`. The daemon run command is
unchanged; Caddy forwards that WSS connection to the same service `/ws`
endpoint.

Bud also persists a stable non-secret installation identity beside the configured identity file. For development this is `~/.bud-dev/installation-id`; production defaults to `~/.bud/installation-id`.

By default, Bud uses `~/.bud` for daemon state and `$HOME` as the working directory. For local/dev isolation, use `--local`; Bud will derive state from `.bud` under the launch directory and use that launch directory as the default cwd. Explicit `--base-dir`, `--cwd`, `--identity-file`, and `--terminal-base-dir` values override those derived defaults.

Run a local preflight with:

```bash
cargo run -- doctor
cargo run -- --terminal-enabled doctor --format json
```

With terminal support enabled, `bud doctor` also verifies the terminal session registry (`<terminal base dir>/term`, mode 700), runs a holder smoke check (spawns a real detached `bud term-hold` holder, probes its socket, kills it, and verifies cleanup), and — when Bud is installed as a launchd/systemd user service — warns if the service definition is missing the supervision directives terminal sessions need to survive daemon restarts (`AbandonProcessGroup=true` on macOS, `KillMode=process` on Linux; see `spikes/holder-survival/findings.md`). With production config it also attempts a bounded TLS trust check for `api.bud.dev`.

Machines upgraded from the old tmux-backed builds can clean up orphaned legacy `s_*` tmux sessions with a one-shot `bud doctor --cleanup-tmux`; it is a silent no-op everywhere else.

## Local Run Alongside Production

Start the service/web development stack first, then from `bud/`:

```bash
source ../dev/daemon-env.sh https
# Prepare the independent development browser once, if needed:
cargo run -- browser prepare --helper-dir ./browser-helper --node "$(command -v node)" --no-restart
BUD_BROWSER_TRACE=1 cargo run -- --terminal-enabled
```

Use `http` with the no-Caddy stack. On first launch, approve the new development
Bud's claim in the local app. Later runs reuse `.bud-dev/identity.json` and its
sibling `installation-id`. Browser sign-ins are independent of production;
sharing the Chrome executable does not share Chrome profiles.

If older development runs used `~/.bud`, preserve that state. Do not install over
it or copy its identity into production without first establishing which backend
owns it. A stored identity from another service origin is rejected and retained.
A second daemon using the same base, identity directory or terminal directory is
refused; aliases through symlinks do not create another instance. Detached
terminal holders survive daemon exit and do not retain the daemon lock.

Use an explicit selector for installed production commands from a dev shell:

```bash
"$HOME/.bud/bin/bud" --base-dir "$HOME/.bud" status
"$HOME/.bud/bin/bud" --base-dir "$HOME/.bud" restart
```

Foreground Cargo instances should be restarted with Ctrl+C and the same Cargo
command. Browser prepare/remove prints that instruction instead of replacing
foreground development with a background process. Managed nondefault instances
use separate hashed launchd/systemd service names. Existing default service names
remain unchanged. Managed startup needs `BUD_SERVER_URL` in its own `bud.env`;
`bud start` does not silently turn a shell-only dev configuration into a service.

The installer defaults to the production backend even from a development shell.
To install against a different backend deliberately, use `BUD_INSTALL_SERVER_URL`
(the installer no longer reads the daemon's `BUD_SERVER_URL` as an install knob).
No service/web/mobile upgrade or database migration is needed for this change;
upgrade the daemon before relying on isolated lifecycle commands. An older daemon
without the new instance lock must be stopped explicitly before reusing its state.

## Local Multi-Account Testing

Select a different dev base and name in each shell before sourcing the setup:

```bash
export BUD_DEV_BASE_DIR="$HOME/.bud-dev/account-a"
export BUD_DEV_DEVICE_NAME=account-a
source ../dev/daemon-env.sh https
cargo run -- --terminal-enabled
```

Repeat with `account-b` in a separate shell and approve each independently using
the intended signed-in account. A copied binary or background-service install is
not required.

## Legacy Manual Enrollment

The old token path still exists for development fallback:

```bash
cargo run -- \
  --server ws://localhost:3000/ws \
  --token DEV-ENROLL-0001 \
  --name local-bud \
  --terminal-enabled
```

## Opt-In gRPC Control

Start the service with `GRPC_CONTROL_ENABLED=true`, then run Bud with both the HTTP origin for claim bootstrap and the gRPC control endpoint:

```bash
cd bud
cargo run -- \
  --server http://localhost:3000 \
  --grpc-control-url http://127.0.0.1:50051 \
  --terminal-enabled
```

The gRPC path currently reuses the existing `hello` / `hello_challenge` / `hello_proof` auth flow and JSON-shaped terminal/control handlers through protobuf `BudEnvelope.frame_json`.

## Notes

- For phone/LAN testing, replace `localhost` in `BUD_SERVER_URL` with a reachable host.
- Terminal sessions are self-contained: the daemon spawns detached PTY holder processes by re-executing itself as `bud term-hold` (the in-repo `stem` crate). No tmux or other external terminal multiplexer is required.
