# Bud Daemon

Rust device daemon that connects to the service over `/ws`, maintains terminal capability state, and now bootstraps auth through the browser-mediated device-claim flow.

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

## Important Env / Flags

| Env | Flag | Purpose |
|-----|------|---------|
| `BUD_SERVER_URL` | `--server` | Service WebSocket URL. For local service dev: `ws://localhost:3000/ws` |
| `BUD_DEVICE_NAME` | `--name` | Device name shown during claim and in the UI |
| `BUD_DEFAULT_CWD` | `--cwd` | Default working directory |
| `BUD_IDENTITY_FILE` | `--identity-file` | Path to persisted `{ bud_id, device_secret }` |
| `BUD_TERMINAL_ENABLED` | `--terminal-enabled` | Enable terminal features |
| `BUD_DEBUG` | `--debug` | Extra Bud logging |
| `BUD_ENROLLMENT_TOKEN` | `--token` | Legacy/manual enrollment fallback |

Bud also persists a stable non-secret installation identity at `~/.bud/installation-id` by default.

## Local Run

Start the service and web app first, then:

```bash
cd bud
set -a; source .env; set +a
cargo run -- --terminal-enabled
```

On first run without a stored identity:

1. Bud calls `/api/device-auth/start`
2. Bud prints a claim URL and terminal QR code
3. You open the link or scan the QR
4. You sign in through the web flow if needed
5. Bud polls `/api/device-auth/poll`, stores the issued `device_secret`, and reconnects over `/ws`

On later runs, Bud reuses:

- `~/.bud/identity.json`
- `~/.bud/installation-id`

If you delete only the identity file and keep `installation-id`, reclaiming should reuse the same Bud record.

## Legacy Manual Enrollment

The old token path still exists for development fallback:

```bash
cargo run -- \
  --server ws://localhost:3000/ws \
  --token DEV-ENROLL-0001 \
  --name local-bud \
  --terminal-enabled
```

## Notes

- For phone/LAN testing, replace `localhost` in `BUD_SERVER_URL` with a reachable host.
- `tmux` must be installed if terminal features are enabled.
