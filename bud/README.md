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

## Running a command (Phase 3)

After the Bud is online:

```bash
curl -X POST http://localhost:3000/api/runs \
  -H "Content-Type: application/json" \
  -d '{"bud_id":"b_dev_seed","cmd":"uname -a"}'
```

Then stream logs:

```bash
curl -N http://localhost:3000/api/runs/<run_id>/stream
```

Bud executes the command locally, streams stdout/stderr chunks (base64) over WSS, and emits `run_finished` with the exit code. The backend persists logs to Postgres and relays human-readable chunks via SSE.

## Next milestones

1. Add robust cancel handling (TERM→5s→KILL of the process group) and workspace isolation per run.
2. Enforce per-run timeouts and capture tail summaries for agent responses.
3. Support additional tools (e.g., file upload/download) through the same registry.
4. Harden reconnection/resume logic so in-flight runs can continue across backend restarts.
