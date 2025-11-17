# Plan: Bud-Owned Working Directory

## Context
- Current behavior:
  - Backend (`service/src/runtime/run-manager.ts`) always supplies a `cwd` on every run, defaulting to `"~"` or the user-selected directory from the UI.
  - Bud agent (`bud/src/main.rs`) expands that `cwd` (using `expand_path`) and sets it on the `Command` before spawning `/bin/sh -lc <cmd>`.
  - UI lets the user type a preferred CWD per run (now removed) but the server still sends `cwd: "~"` for all runs.
- Failure case: when `~` can’t be expanded or the path doesn’t exist on the Bud machine, `command.spawn()` fails with `failed to spawn shell`. This surfaced when we sent “change directory to bud/service” which only sets the run’s `cwd` to `~/bud/service`.
- Desired behavior: Bud itself should own its current working directory. The server should only send a `cwd` override when explicitly requested (e.g., user chooses a Bud setting). Bud needs to report back its updated directory so the backend/UI can display it, but the default run should inherit the Bud’s own state.

## Objective
1. Give Bud a persistent notion of “current working directory” (seeded from its startup dir or config) that updates after `cd` commands.
2. Make `cwd` on `run` frames optional; only set it when the user explicitly specifies a different directory via Bud settings.
3. Have Bud report its resulting CWD in `run_finished` frames so the backend and UI can display it and prefill future runs if desired.
4. Update service + UI to reflect the Bud-reported CWD instead of forcing one from the server on every run.

## Research Findings

### Bud agent
- `RunExecutor::execute_run` (bud/src/main.rs:250) expands `run.cwd` with `expand_path` before `command.current_dir`.
- `RunCommand` includes `cwd` as a required field; there is no shared state for “current directory”.
- `RunExecutor`’s queue doesn’t persist environment state between runs, so every run is independent.
- There is no logic to apply command results (`cd` updates) to future runs.
- `run_finished` WS frame currently contains `exit_code` and `signal` but no `cwd`.

### Service/backend
- `RunManager.dispatchShellCommand` always receives `cwd` (set by frontend input or default `"~"`).
- Even the new agent loop path injects `toolCall.cwd ?? "~"` when dispatching a shell command.
- `run_step.argsJson` stores `{ cmd, cwd }` for history; logs assume the `cwd` is known.

### UI
- We removed the CWD input in this session, so now the UI always sends commands with implicit `"~"`.
- The UI still shows no info about Bud’s current directory; future features might want to display the Bud status panel with its current working directory.

### Protocol
- WSS protocol currently requires `cwd` in `run` frames. `run_finished` doesn’t emit `cwd`.
- To shift CWD ownership to Bud we need to:
  - Make `cwd` optional (and likely remove it when not specified).
  - Extend `run_finished` to include a `cwd` string representing Bud’s actual working directory after the command.

## Design / Approach
1. **Bud internal state**
   - Add a field to `ExecutorState` (e.g., `current_dir: PathBuf`) initialized from CLI arg `--cwd` or `std::env::current_dir()`.
   - When a run arrives:
     - If frame `cwd` is provided, expand + validate it, update `current_dir`, and run the command there.
     - If frame `cwd` is omitted, use `current_dir`.
     - After the command completes, determine the resulting directory:
       - For simple commands we can leave it unchanged.
       - For `cd <path>` we only know if we detect the command; better approach is to wrap user commands in a shell snippet that prints `$PWD` after execution (e.g., `cd ..; do work; printf '\n__BUD_CWD:%s\n' "$PWD"`). However, for the PoC we can assume the user issues `cd` and future commands rely on the new directory (i.e., we only update `current_dir` when we intentionally set `cwd` from override). Alternatively, we can run each command inside `bash -lc '...; pwd'` and parse the last line.
   - For this iteration, we can adopt a simpler model: Bud owns CWD but only changes it when it receives a new `cwd` override or is instructed via explicit configuration. Full shell semantics (shell built-ins changing CWD) would require running inside a persistent login shell or capturing the final directory. Document that limitation.
2. **Protocol updates**
   - Update `docs/proto.md` to mention optional `cwd` field and new `run_finished.cwd`.
   - Bud’s `run_finished` frame includes its `current_dir`.
3. **Service changes**
   - Default `cwd` to `undefined` unless a Bud setting or API parameter explicitly asks for a change.
   - When receiving a `run_finished`, update thread metadata (if storing) with `last_cwd` if desired for UI.
   - Agent tool calls should respect Bud ownership: if the user message included `Preferred CWD: ...`, we send an override; otherwise omit it.
4. **UI**
   - Remove client-side CWD input (done) and display Bud’s current directory (if desired) using the data from SSE or thread metadata.
   - When user wants to change directories permanently, expose a Bud setting (future work) or a one-off override in the agent instructions (“cd /foo && ...”).

## Additional Considerations
- Full shell semantics (cd changes persisting) implies running commands within a persistent shell session. That’s a larger architecture change (requires per-run shells and environment toggles). For now, we keep the simpler “server instructs Bud to change directory via `cwd` override”.
- Logging: improve errors so if `command.spawn()` fails, we log the resolved directory.
- Security: ensure `cwd` overrides are sanitized (no `..`? maybe not necessary for PoC but worth noting).

## Impacted components
- Bud agent (`bud/src/main.rs`) – executor state, run finished payload.
- Backend (`service/src/runtime/run-manager.ts`, `docs/proto.md`, SSE consumers) – optional `cwd` in run frames, track Bud-reported `cwd`.
- UI – optionally show Bud current directory, remove default override.
- Protocol docs – update `docs/proto.md`.

## Plan
1. Update protocol doc and Bud agent to support reporting `cwd`.
2. Refactor backend/agent so `cwd` defaults to undefined; only send override when explicitly requested.
3. Decide on interim approach for Bud’s own CWD management (persist at least the override, even if we don’t infer from `cd` commands yet).
4. Add UI changes (display Bud CWD) as a later enhancement if needed.
