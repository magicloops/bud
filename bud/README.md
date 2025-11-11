# Bud Device Agent

Rust daemon that connects to the backend via WSS, completes the `hello`/`hello_ack` handshake (with enrollment + challenge/response), persists identity material locally, and keeps the connection alive with periodic heartbeats. Execution and log streaming will land in the next phases of the PoC.

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

## Enrolling a Bud

1. Seed or mint an enrollment token on the backend (e.g., `pnpm db:seed` inside `service/`).
2. Start the backend (`pnpm dev` in `service/`).
3. Launch Bud:

   ```bash
   cargo run -- \
     --server ws://localhost:3000/ws \
     --token DEV-ENROLL-0001 \
     --name dev-box \
     --identity-file ~/.bud/identity.json
   ```

4. On success, `~/.bud/identity.json` is written with `0600` perms and reused for future reconnects (challenge/response with `hello_challenge`/`hello_proof`). Bud sends heartbeats every 30s and transitions to `online` in the backend registry.

## Next milestones

1. Add the run queue and shell executor (TERM→5s→KILL cancel semantics).
2. Stream stdout/stderr chunks (≤16 KB) back to the backend with seq numbers.
3. Implement `cancel` handling and process group teardown.
4. Wire LLM tool calls + workspace management once backend agent is ready.
