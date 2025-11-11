# Bud Device Agent

Rust daemon that connects to the backend via WSS, executes shell commands, and streams logs/cancel events. The current binary is a scaffold per `plan/phase-0-scaffolding.md`.

## Development

```bash
cargo fmt
cargo clippy --all-targets
cargo run -- --help
```

Flags/env vars (see `src/main.rs`):

- `--server` / `BUD_SERVER_URL`: backend WSS endpoint (`wss://localhost:8443/ws` default).
- `--token` / `BUD_ENROLLMENT_TOKEN`: enrollment token for first run.
- `--name` / `BUD_DEVICE_NAME`: friendly name shown in the UI.
- `--default-cwd` / `BUD_DEFAULT_CWD`: default working directory for shell runs.
- `--identity-file` / `BUD_IDENTITY_FILE`: path to `{ bud_id, device_secret }`.

## Next milestones

1. Implement WSS handshake (`hello`/`hello_ack`) with reconnect + heartbeats.
2. Add run queue + shell executor (TERM→5s→KILL cancel semantics).
3. Stream stdout/stderr chunks (≤16 KB) with seq numbers.
4. Persist identity to `~/.bud/identity.json` (0600).
