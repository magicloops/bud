# Validation Checklist: Terminal Freshness Hints

Manual validation pending. Automated checks below reflect the initial service implementation.

## Automated Verification

- [x] Focused freshness helper tests pass
- [x] Message route code no longer depends on context sync or terminal-session preflight lookup
- [x] Freshness helper tests prove dirty/unknown freshness returns the transient hint
- [x] Freshness is suppressed by the agent environment gate before helper resolution when Bud tools are unavailable
- [x] Transcript writer tests prove terminal visibility metadata is persisted without changing tool replay content
- [ ] Authorization tests prove freshness lookup is scoped to the owned thread/session

## Online Clean Path

- [ ] Existing online thread with no terminal session sends without a freshness hint
- [ ] Existing online thread with a clean terminal session sends without a preflight observe
- [ ] Existing online thread with a clean terminal session sends without a freshness hint
- [ ] The primary agent LLM call starts without waiting on a Bud `terminal_observe`

## Online Dirty Path

- [ ] Terminal output after the latest model-visible terminal result produces a freshness hint
- [ ] Human browser-terminal input after the latest model-visible terminal result produces a freshness hint
- [ ] Cached cwd change after the latest model-visible terminal result produces a freshness hint
- [ ] Readiness/context/status change after the latest model-visible terminal result produces a freshness hint
- [ ] Dirty state produces one unified hint rather than multiple prompt fragments
- [ ] The hint is transient and not persisted as a `system` transcript row

## Tool Result Watermarks

- [ ] `terminal.observe` result advances the model-visible terminal watermark
- [ ] `terminal.send` result with visible output advances the model-visible terminal watermark
- [ ] `terminal.send` result with no visible output advances the watermark when readiness/context/cwd/dispatch facts are shown
- [ ] A terminal tool result clears the prior dirty hint for the next provider step when no new activity arrives
- [ ] New output after that terminal tool result marks the terminal dirty again

## Model Behavior Smoke

- [ ] User asks a general question after terminal state changes; agent can answer without observing if the terminal is irrelevant
- [ ] User asks "what happened?" after terminal state changes; agent calls `terminal.observe` before answering
- [ ] User asks to continue terminal work after manual TUI exit; agent observes before sending shell/TUI input
- [ ] User asks for non-device help while Bud is online but dirty; agent is not forced into terminal work

## Offline Bud Non-Regression

- [ ] Offline Bud send still succeeds when the LLM turn can start
- [ ] Offline Bud provider context includes offline guidance, not a terminal freshness observe hint
- [ ] Bud-specific tools remain filtered while offline
- [ ] Reconnect before a provider step can restore normal environment behavior

## API / UI Non-Regression

- [ ] `POST /messages` response shape is unchanged
- [ ] `/agent/state` response shape is unchanged
- [ ] Agent SSE event shapes are unchanged
- [ ] Web composer behavior is unchanged except for faster sends
- [ ] Mobile requires no contract update

## Docs / Specs

- [x] `design/terminal-context-sync.md` marks preflight context sync as superseded for normal sends
- [x] `design/terminal-freshness-hints.md` matches the implemented metadata and hint behavior
- [x] Service route/agent/terminal/runtime specs are updated
- [x] `bud.spec.md` indexes the plan and still reads coherently
