# Debug: terminal session starts in home instead of Bud base dir

## Environment
- Local macOS development setup.
- Bud binary copied into `/Users/adam/code/bud2-test`.
- Bud launched with state relocated into that directory, for example:
  - `--identity-file /Users/adam/code/bud2-test/identity.json`
  - `--terminal-base-dir /Users/adam/code/bud2-test`
  - `--terminal-enabled`
- Service/web running against local development endpoints.

## Repro Steps
1. Start Bud from `/Users/adam/code/bud2-test` with `--identity-file` and `--terminal-base-dir` both pointing at that directory.
2. In the web app, create or open a thread on that Bud.
3. Create a terminal session and call the thread terminal ensure flow.
4. Observe the first tmux shell prompt or run `pwd`.

## Observed
- The first tmux session starts in the user's home directory (`~`) rather than `/Users/adam/code/bud2-test`.
- The daemon CLI has both `--cwd` and `--terminal-base-dir`, but the terminal session path does not connect them:
  - `BudArgs.cwd` defaults to `~` (`bud/src/main.rs:63-64`).
  - `BudArgs.terminal_base_dir` defaults to `~/.bud` (`bud/src/main.rs:79-80`).
  - `BudApp::new()` uses `args.cwd` to seed the one-shot `RunExecutor`, and separately uses `args.terminal_base_dir` only for terminal log storage (`bud/src/main.rs:2299-2313`).
  - `TerminalConfig` contains `base_log_dir`, `cols`, `rows`, and `shell`, but no default cwd field (`bud/src/main.rs:232-240`).
- The Bud terminal protocol supports an explicit cwd:
  - `TerminalEnsureConfig` includes `cwd: Option<String>` (`bud/src/main.rs:276-283`).
  - But `ensure_tmux_session()` falls back to `~` whenever `cfg.cwd` is absent (`bud/src/main.rs:1529-1555`).
- The service currently never provides that cwd:
  - `terminal_session` schema has `shell` and `cwd` columns (`service/src/db/schema.ts:347-352`).
  - `createSessionForThread()` does not populate either column when it inserts the session row (`service/src/runtime/terminal-session-manager.ts:176-188`).
  - `ensureSession()` sends `terminal_ensure` with only `cols` and `rows` in `config` (`service/src/runtime/terminal-session-manager.ts:243-255`).
  - `POST /api/threads/:threadId/terminal/ensure` ignores any request body and just calls `ensureSession(sessionId)` (`service/src/routes/threads.ts:538-550`).
  - There is a `TerminalEnsureBodySchema` with optional `shell`, `cwd`, `cols`, and `rows`, but it is defined and not used by the route (`service/src/routes/threads.ts:53-60`, `service/src/routes/threads.ts:538-550`).
- There is also no persistence of the Bud-reported cwd back into the session row:
  - The daemon reports `cwd` in the immediate `terminal_status` info (`bud/src/main.rs:1605-1642`).
  - `handleTerminalStatus()` updates state, tmux session name, cols, rows, timestamps, and output bytes, but does not persist `payload.info?.cwd` or `payload.info?.shell` into the `terminal_session` row (`service/src/runtime/terminal-session-manager.ts:483-497`).
- `preferred_cwd` from user chat messages does not solve this:
  - It is appended to the agent prompt context (`service/src/agent/agent-service.ts:510-518`).
  - It is not used by session creation or `terminal_ensure`.

## Expected
- For the relocated-instance workflow, a Bud launched with `--terminal-base-dir /Users/adam/code/bud2-test` should be able to start its first tmux session in `/Users/adam/code/bud2-test` when no more specific terminal cwd is supplied.
- At minimum, the system should have one clear canonical source for "default terminal cwd" instead of implicitly falling back to `~`.

## Hypotheses
1. **Primary root cause**: the service-to-daemon `terminal_ensure` flow drops cwd entirely, so the daemon's local fallback path always executes.
2. **Daemon fallback is hard-coded to home**: `ensure_tmux_session()` uses `cfg.cwd.unwrap_or_else(|| "~".to_string())`, so any missing service-side cwd becomes `~`.
3. **`BUD_DEFAULT_CWD` is not the terminal default today**: it only seeds run execution state and is stored in identity metadata, but terminal sessions do not read it (`bud/src/main.rs:381-430`, `bud/src/main.rs:2426-2432`, `bud/src/main.rs:2836-2842`).
4. **Unused service schema suggests incomplete implementation**: `terminal_session.cwd`, `terminal_session.shell`, and `TerminalEnsureBodySchema` look like the service intended to carry session launch settings but never finished wiring them through.
5. **Product-level choice is still open**:
   - If the desired behavior is "terminal sessions should respect `BUD_DEFAULT_CWD`", then the fix should use that setting as the daemon/service default.
   - If the desired behavior is "relocated Bud instances should open in their relocated state directory", then `BUD_TERMINAL_BASE_DIR` is the desired fallback for this workflow.
   - These are not the same for normal installs, because defaulting every session to `~/.bud` for standard users may be surprising.

## Proposed Fix
- Decide the canonical default terminal cwd:
  - Option A: `BUD_DEFAULT_CWD`
  - Option B: `BUD_TERMINAL_BASE_DIR`
  - Option C: explicit session cwd from service, with daemon fallback only as a last resort
- If the team wants per-session control:
  - wire `POST /api/threads/:threadId/terminal/ensure` to parse `TerminalEnsureBodySchema`
  - persist `cwd`/`shell` into `terminal_session`
  - include them in `terminal_ensure.config`
  - persist Bud-reported `cwd`/`shell` in `handleTerminalStatus()`
- If the team wants the quickest daemon-side behavior fix for relocated local instances:
  - add a daemon default terminal cwd to `TerminalConfig`
  - make `ensure_tmux_session()` fall back to that configured value instead of hard-coded `~`
  - decide whether that configured value should come from `args.cwd`, `args.terminal_base_dir`, or conditional logic when the base dir is overridden

## Spec Files Affected
- `bud/bud.spec.md`
- `bud/src/src.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/routes/routes.spec.md`
