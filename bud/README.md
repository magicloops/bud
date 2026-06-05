# Bud Daemon

Rust device daemon that connects to the service over `/ws` or the opt-in Phase 2 gRPC control stream, maintains terminal capability state, and now bootstraps auth through the browser-mediated device-claim flow.

## Setup

```bash
cd bud
cargo fmt
cargo build
```

Use [bud/.env.example](./.env.example) as a shell-export template:

```bash
cp .env.example .env
set -a; source .env; set +a
```

Bud does not auto-load `.env` itself; you need to export the variables in your shell before running `cargo run`.

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

Bud also persists a stable non-secret installation identity beside the configured identity file. With the default settings that path is `~/.bud/installation-id`.

By default, Bud uses `~/.bud` for daemon state and `$HOME` as the working directory. For local/dev isolation, use `--local`; Bud will derive state from `.bud` under the launch directory and use that launch directory as the default cwd. Explicit `--base-dir`, `--cwd`, `--identity-file`, and `--terminal-base-dir` values override those derived defaults.

Run a local preflight with:

```bash
cargo run -- doctor
cargo run -- --terminal-enabled doctor --format json
```

When terminal support is enabled and `tmux` is missing, `bud doctor` prints OS-specific install commands. With production config it also attempts a bounded TLS trust check for `api.bud.dev`. Bud does not install tmux automatically.

## Local Run

Start the service and web app first, then:

```bash
cd bud
set -a; source .env; set +a
cargo run -- --terminal-enabled
```

With the optional HTTPS profile, start Caddy from the repo root first and use
the HTTPS env example before running the same command:

```bash
cp .env.https.example .env
set -a; source .env; set +a
cargo run -- --terminal-enabled
```

On first run without a stored identity:

1. Bud calls `/api/device-auth/start`
2. Bud prints a claim URL and terminal QR code
3. You open the link or scan the QR
4. You sign in through the web flow if needed
5. Bud polls `/api/device-auth/poll`, stores the issued `device_secret`, and reconnects over the configured control transport

On later runs, Bud reuses:

- `~/.bud/identity.json`
- `~/.bud/installation-id`

If you delete only the identity file and keep `installation-id`, reclaiming should reuse the same Bud record.

## Local Multi-Account Testing

For local multi-account work, the practical pattern is:

1. Build Bud once.
2. Copy the binary into one directory per local test account.
3. Run each copy through a small wrapper script that pins Bud's state into that directory.

Copying the binary is optional. The useful part is that the wrapper script can derive the instance root from `$(dirname "$0")` and keep `identity.json`, `installation-id`, and terminal logs together.

### Build Once

```bash
cd bud
cargo build
```

This produces `target/debug/bud`.

### Example Instance Layout

```text
$HOME/.bud-dev/
  account-a/
    bud
    run.sh
  account-b/
    bud
    run.sh
```

### Copy the Binary Into Per-Account Directories

```bash
cd bud
mkdir -p "$HOME/.bud-dev/account-a" "$HOME/.bud-dev/account-b"
cp target/debug/bud "$HOME/.bud-dev/account-a/bud"
cp target/debug/bud "$HOME/.bud-dev/account-b/bud"
chmod +x "$HOME/.bud-dev/account-a/bud" "$HOME/.bud-dev/account-b/bud"
```

### Example `run.sh`

Place this next to the copied binary in each account directory:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

exec "$SCRIPT_DIR/bud" \
  --server "${BUD_SERVER_URL:-ws://localhost:3000/ws}" \
  --name "${BUD_DEVICE_NAME:-$(basename "$SCRIPT_DIR")}" \
  --base-dir "$SCRIPT_DIR/.bud" \
  --cwd "$SCRIPT_DIR" \
  --terminal-enabled
```

With that layout:

- device credentials are stored at `$SCRIPT_DIR/.bud/identity.json`
- the stable installation identity is stored at `$SCRIPT_DIR/.bud/installation-id`
- terminal logs are stored under `$SCRIPT_DIR/.bud/sessions/`

### Example `make-bud-instance.sh`

If you want a repeatable team helper, this script creates one prepared instance directory:

```bash
#!/usr/bin/env bash
set -euo pipefail

INSTANCE_NAME="${1:?usage: $0 <instance-name> [dest-root]}"
DEST_ROOT="${2:-$HOME/.bud-dev}"
INSTANCE_DIR="$DEST_ROOT/$INSTANCE_NAME"

cd bud
cargo build

mkdir -p "$INSTANCE_DIR"
cp target/debug/bud "$INSTANCE_DIR/bud"
chmod +x "$INSTANCE_DIR/bud"

cat > "$INSTANCE_DIR/run.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

exec "$SCRIPT_DIR/bud" \
  --server "${BUD_SERVER_URL:-ws://localhost:3000/ws}" \
  --name "${BUD_DEVICE_NAME:-$(basename "$SCRIPT_DIR")}" \
  --base-dir "$SCRIPT_DIR/.bud" \
  --cwd "$SCRIPT_DIR" \
  --terminal-enabled
EOF

chmod +x "$INSTANCE_DIR/run.sh"
echo "Created $INSTANCE_DIR"
```

Example usage:

```bash
./make-bud-instance.sh account-a
./make-bud-instance.sh account-b
```

Then run:

```bash
$HOME/.bud-dev/account-a/run.sh
$HOME/.bud-dev/account-b/run.sh
```

Approve each Bud from the browser session that should own it. If you are testing two different user accounts on one machine, use separate browser profiles or separate authenticated sessions during the approval flow.

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
- `tmux` must be installed if terminal features are enabled.
