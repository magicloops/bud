# Debug: Codex startup latency in tmux vs local shell

## Environment

- Local development on macOS
- Bud daemon and service running locally
- Browser terminal is the normal Bud thread-scoped tmux session streamed through Bud -> service -> SSE -> xterm.js
- Codex CLI binary resolved in tmux: `/Users/adam/.nvm/versions/node/v22.14.0/bin/codex`

## Problem statement

When `codex` is launched inside the Bud/tmux terminal, startup feels slower than in the user’s normal local shell. This causes two related problems:

1. The browser/xterm.js terminal appears to take longer to show the Codex UI.
2. `terminal.send` can falsely settle after the echoed command line before the meaningful Codex screen appears.

The goal is for Bud’s terminal environment and behavior to match the user’s normal shell as closely as possible, rather than behaving like a materially different session.

## Repro

1. Open a Bud thread terminal in the browser.
2. Run `codex`.
3. Observe that the browser terminal appears to stall after the echoed command before the Codex UI becomes visible.
4. Compare that with running `codex` in the user’s normal local terminal in the same project directory.

## What I checked

### 1. Bud/tmux shell launch path

Bud creates tmux sessions with:

- `tmux new-session -d -s <name> -x <cols> -y <rows> -c <cwd> <shell>`
- no login-shell flag
- no implemented env passthrough

Relevant code:

- `bud/src/main.rs`
  - `let _ = cfg.env; // env passthrough not yet implemented`
  - tmux `new-session` invocation
  - `pipe-pane` log setup
  - 50ms output watcher polling

### 2. tmux environment vs current shell

Inside a Bud-like tmux shell, I captured:

```text
shell_env=/bin/zsh
argv0=/bin/zsh
TERM=tmux-256color
TERM_PROGRAM=tmux
TMUX=/private/tmp/tmux-501/default,...
HOME=/Users/adam
CODEX_HOME=
codex is /Users/adam/.nvm/versions/node/v22.14.0/bin/codex
codex-cli 0.120.0
```

Key takeaways:

- tmux is using the same Unix user and same `HOME`
- tmux resolves to the same `codex` binary
- tmux is definitely a different terminal environment: `TERM=tmux-256color`, `TERM_PROGRAM=tmux`, `TMUX=...`
- Bud is launching a non-login `zsh` shell, not an explicit login shell

I also compared `zsh -ic` vs `zsh -lic` locally and saw PATH ordering differences between non-login and login startup, which supports the shell-mode divergence hypothesis.

### 3. What Codex actually renders inside tmux

I launched `codex` in a temporary tmux session and captured the pane. The pane showed this almost immediately:

```text
adam@Adams-MacBook-Pro-2 bud % codex

  Update available! 0.120.0 -> 0.121.0

  Release notes: https://github.com/openai/codex/releases/latest

  1. Update now
  2. Skip
  3. Skip until next version

  Press enter to continue
```

This is an important finding:

- inside tmux, Codex is not going straight to the main prompt
- it is taking a different startup branch and showing a blocking update chooser

### 4. Whether `pipe-pane` is withholding the bytes

I repeated the tmux experiment with `pipe-pane` logging enabled and checked the log after about 200ms.

Results:

- the tmux pane already showed the update prompt
- the `pipe-pane` log was already about 1707 bytes
- the log already contained visible strings like:
  - `Update available!`
  - `Release notes:`
  - `Press enter to continue`

This means:

- tmux itself is not waiting seconds to render the prompt
- `pipe-pane` is not withholding the prompt bytes until much later
- if the browser still feels slower, the remaining delay is more likely downstream of the tmux pane/log itself, or the human is perceiving the blocking update prompt as “slow startup”

### 5. Why `time codex` is not enough

`time codex` measures total process lifetime until exit, not time-to-first-render or time-to-first-interactive-prompt.

So similar `time codex` output does **not** rule out:

- slower first-screen rendering
- a different blocking startup branch
- a delay between pane output and browser-visible output

## Strongest current findings

1. **Codex is taking a different startup path inside tmux.**
   - The tmux pane shows a blocking update chooser instead of going straight to the main Codex prompt.
2. **This is not a different user or different binary in the local test.**
   - Same `HOME`
   - Same resolved `codex` binary
3. **Bud’s tmux shell is not equivalent to a normal user login shell.**
   - non-login `zsh`
   - tmux-specific terminal env
   - no env passthrough from service/user context
4. **The prompt bytes are already present very quickly in the tmux pane and in the pipe-pane log.**
   - so the largest current process-side divergence is the startup branch itself, not raw process slowness

## Ranked hypotheses

### 1. Codex changes startup behavior when it detects tmux

**Likelihood:** high

Evidence:

- In tmux, `TERM=tmux-256color`, `TERM_PROGRAM=tmux`, and `TMUX` is set.
- The tmux pane shows a blocking update chooser.
- The user’s local shell reportedly goes straight to the normal Codex prompt and only shows a non-blocking update notification.

What would confirm it:

- Reproducing the blocking update chooser in tmux consistently while the local terminal app consistently skips it.
- Finding that changing the terminal/session environment changes the startup branch.

### 2. Bud launches a non-login shell, while the user’s normal local shell is login-mode

**Likelihood:** high

Evidence:

- Bud launches `<shell>` directly via `tmux new-session`, not `zsh -l` or `bash -l`.
- `zsh -ic` and `zsh -lic` differ locally in PATH ordering.
- Login-shell startup files often carry environment setup, update-policy vars, PATH shaping, and wrappers that non-login shells do not.

What would confirm it:

- Launching the Bud tmux shell as `zsh -l` makes Codex behave like the user’s normal shell.

### 3. Bud inherits the daemon’s environment, not the viewer’s normal terminal-app environment

**Likelihood:** high

Evidence:

- Bud currently ignores requested terminal env: `let _ = cfg.env`.
- Bud sessions inherit whatever environment the daemon itself started with.
- Even locally, the Codex app shell environment is visibly unusual compared with a normal terminal app.

What would confirm it:

- Comparing `env | sort` from the user’s normal Terminal/iTerm shell against the Bud tmux shell reveals meaningful differences in terminal/session/update-related vars.

### 4. The “slow startup” feeling is mostly the blocking update chooser, not Codex process startup itself

**Likelihood:** medium-high

Evidence:

- The update chooser is visible in the tmux pane within about 200ms in the isolated tmux test.
- That means Codex is already alive and rendering a UI quickly.
- If the user is expecting the main Codex prompt, the update chooser will feel like a startup delay even though it is actually an alternate blocking first screen.

What would confirm it:

- Resolving or suppressing the update chooser makes tmux startup subjectively “fast” again.

### 5. There is still a downstream delay between Bud output and browser-visible output

**Likelihood:** medium

Evidence:

- The tmux pane and `pipe-pane` log both update quickly.
- The browser can still feel slower than that.
- The service currently does DB insert/update work before emitting `terminal.output`, and then the browser receives it via SSE before writing to xterm.

Why this is plausible but not yet primary:

- `ls` and ordinary typing are reportedly fast.
- The prompt bytes are already present near-immediately upstream.
- So this is more likely to be a secondary amplifier than the root tmux/local divergence.

What would confirm it:

- Timestamp instrumentation shows a large gap between:
  - Bud watcher read
  - service receive
  - SSE emit
  - browser `handleOutput`
  - xterm `write`

### 6. Terminal capability differences are pushing Codex onto a different UI/render path

**Likelihood:** medium

Evidence:

- tmux shell uses `TERM=tmux-256color`
- local terminal app likely uses something else
- Codex emits lots of full-screen / terminal capability probing sequences early in the log

What would confirm it:

- Running Codex under a non-tmux PTY with terminal vars closer to the local app eliminates the update chooser or changes first-screen behavior.

### 7. Bud’s settled detector is exposing an existing first-screen gap, not creating it

**Likelihood:** medium

Evidence:

- `terminal.send` currently waits on output quiescence from the `pipe-pane` watcher.
- If Codex echoes the command line, then pauses briefly before its first meaningful screen, Bud can settle too early.
- This would explain the false-positive settled result even if the main root cause is the Codex startup branch.

What would confirm it:

- Bud debug logs show:
  - command echo written
  - no new bytes for a short quiet window
  - settled result returned
  - Codex UI bytes arriving shortly after

### 8. The user’s normal local shell may already have persistent “skip update” state that tmux is not sharing

**Likelihood:** low-medium

Evidence:

- Local shell reportedly shows a notification rather than a blocking chooser.
- tmux shows the chooser.
- Same binary and same HOME reduce the odds that this is a completely separate config store, but some tools key behavior off terminal/session context rather than only a simple file in HOME.

What would confirm it:

- Inspecting Codex’s persisted config/update-state behavior and checking whether it varies by shell/session context.

### 9. Browser/xterm rendering of Codex’s alternate-screen escape sequences may be slower than plain command output

**Likelihood:** low-medium

Evidence:

- Codex startup emits far more escape/control sequences than `ls`.
- xterm writes decoded output directly with `term.write(decoded)`.
- Plain shell output being fast does not fully prove that complex alternate-screen transitions are equally fast.

What would confirm it:

- Browser-side timestamps show the SSE event arrives promptly but the visible xterm update lags.

## What this investigation currently suggests

The best current explanation is:

1. **Codex is behaving differently inside tmux.**
   - The clearest concrete difference is the blocking update chooser.
2. **Bud’s tmux shell is not yet trying to faithfully reproduce the user’s normal shell startup context.**
   - non-login shell
   - inherited daemon env
   - no env passthrough
3. **The tmux pane and pipe-pane log update quickly.**
   - so the first thing to debug is not raw Codex process startup
   - it is the tmux/local-shell behavioral divergence, and then any remaining downstream browser lag

## Recommended next experiments

### 1. Compare against the user’s real local terminal app env

Capture from the user’s normal shell:

```bash
env | sort | rg '^(HOME|PATH|SHELL|TERM|TERM_PROGRAM|TMUX|ZDOTDIR|CODEX_HOME|LANG|COLORTERM)='
type codex
```

Then compare to the Bud tmux shell.

### 2. Launch Bud/tmux as a login shell

Try a tmux session that launches `zsh -l` instead of plain `zsh`.

If the blocking update chooser disappears, the non-login shell difference is likely the main root cause.

### 3. Add precise timestamps to the output path

Instrument:

- Bud output watcher when it reads new bytes
- service gateway when it receives `terminal_output`
- `TerminalSessionManager.handleTerminalOutput(...)` before and after DB work
- SSE emit
- browser `handleOutput`

This will separate:

- process-side delay
- service-side delay
- browser-side render delay

### 4. Capture Bud debug logs around a `codex` launch

Specifically inspect whether Bud returns settled before the first meaningful Codex UI bytes arrive.

### 5. Decide what “same as the user” means operationally

If the target is true parity with the user’s normal shell, Bud likely needs to move closer to:

- same shell type
- same login/non-login mode
- same env shaping
- optional env passthrough

Right now Bud is only guaranteeing:

- same Unix user in the local test
- same HOME
- same binary resolution

That is not the same thing as “same shell session semantics.”

## Relevant code paths

- `bud/src/main.rs`
  - shell selection and tmux session creation
  - ignored env passthrough
  - `pipe-pane` setup
  - 50ms output watcher
- `service/src/runtime/terminal-session-manager.ts`
  - stores terminal output in DB, then emits `terminal.output`
- `service/src/runtime/event-bus.ts`
  - SSE attach + emit
- `service/src/routes/threads.ts`
  - `/api/threads/:threadId/terminal/stream`
- `web/src/routes/$budId/$threadId.tsx`
  - terminal SSE subscription
  - `terminal.output` handler
  - xterm `term.write(decoded)`

## Interim conclusion

The strongest lead is **not** “Codex is inherently much slower inside tmux.”

The strongest lead is:

- **Codex chooses a different, blocking startup UI inside tmux**
- **Bud’s tmux shell is not identical to the user’s normal shell context**
- **The upstream bytes arrive quickly enough that any remaining multi-second feel is likely either the blocking update flow itself or downstream display latency that now needs timestamp instrumentation**
