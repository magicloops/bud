# Debug: Bud run fails to spawn shell

## Environment
- Bud agent: current `bud/` main on macOS (Rust target: debug build via `cargo run`).
- Backend: `service/` main with new async agent dispatch + optimistic UI.
- Command: `cargo run -- --server ws://localhost:3000/ws --token DEV-ENROLL-0001`.

## Repro steps
1. Start backend + web + Bud agent.
2. From the web UI, send `pwd` with CWD `~/bud/service`.
3. Backend dispatches run `run_01KA8B1Z28Z4PQ487HY6P1CWK6`.
4. Bud logs:
   ```
   INFO Starting shell command run_id=run_... cmd=pwd cwd=~/bud/service
   WARN run execution failed error=failed to spawn shell
   ```

## Observed
- Bud fails immediately with `failed to spawn shell` when `command.spawn()` runs in `RunExecutor::execute_run`.
- Backend shows run failing; SSE still streams but no command output.

## Expected
- Bud should expand `~` to the user home directory and run `/bin/sh -lc "pwd"` in that cwd without errors.

## Hypotheses
1. `expand_path("~")` or `expand_path("~/bud/service")` returns `None`, so `command.current_dir` is never set and `Command::current_dir` later fails when spawn runs (invalid path).
2. `expand_path` relies on `dirs::home_dir` or `$HOME`, and the Bud agent environment lacks these (depending on how we launch `cargo run`), so `~` expansion fails.
3. The Bud agent is running from a sandbox or a directory that doesn’t include `~/bud/service`, so even after expansion the directory doesn’t exist; `spawn()` then fails.
4. There’s been no restart of Bud since changing the default CWD on the server, so the server sends a path the Bud agent doesn’t have permission to access.

## Proposed fix
- Inspect `expand_path` implementation in `bud/src/main.rs`; ensure it handles `~` by looking up the current user’s home directory via `dirs::home_dir` (and maybe fallback to `$HOME`). Confirm we log the resolved path before spawning to verify expansion is correct.
- Add better error context when `command.spawn()` fails (include `cwd`, resolved path) to ease future diagnosis.
- If `expand_path` returns `None`, fallback to `args.cwd` default (from CLI) or log a clear message.

## Next actions
- [ ] Review `expand_path` implementation and confirm behavior.
- [ ] Add logging around path expansion and `command.spawn()` failures.
- [ ] Re-run Bud agent to verify CWD resolution works for `~/bud/service`.
