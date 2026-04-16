# Interrupt Fix Validation Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).

## Status Legend

- `[ ]` not yet run
- `[x]` verified
- `[-]` deferred or not applicable

## Phase 1: Service Context And Dispatch Correctness

- [ ] `sendInterrupt()` no longer clears pending REPL/TUI context at dispatch time
- [ ] interrupting a tracked REPL/TUI without observed shell return keeps `context_after.mode` inferred as non-shell
- [ ] observed shell return after interrupt still clears pending REPL/TUI context
- [ ] failed interrupt dispatch produces `submitted: false`
- [ ] failed interrupt dispatch includes an explicit `error`
- [ ] failed interrupt summary text does not say `Sent Ctrl+C`

## Phase 2: Interrupt Result Contract And Transport

### Wire Contract

- [ ] `terminal_interrupt` supports request correlation for updated deployments
- [ ] Bud emits `terminal_interrupt_result`
- [ ] service gateway parses and routes `terminal_interrupt_result`
- [ ] service preserves full legacy `terminal_ready` payloads needed for rollout fallback

### Agent / Runtime Behavior

- [ ] agent interrupt success uses correlated interrupt-local output
- [ ] legacy fallback uses preserved `terminal_ready` output window instead of generic DB-tail reconstruction
- [ ] browser interrupt route still returns `503` on offline/session-missing dispatch failure
- [ ] `terminal.ready` SSE behavior remains intact after the transport change

## Phase 3: Real Flow Validation

### Shell

- [ ] start long-running shell command
- [ ] interrupt it
- [ ] confirm returned output is interrupt-local
- [ ] confirm shell return is reflected correctly

### REPL / TUI

- [ ] start Python or another tracked REPL
- [ ] interrupt active work
- [ ] confirm context stays non-shell unless shell was actually observed
- [ ] start Claude Code or another tracked TUI
- [ ] interrupt it
- [ ] confirm both context and output remain accurate

### Failure / Compatibility

- [ ] simulate `bud_offline`
- [ ] simulate `session_not_found`
- [ ] confirm no false success result is produced
- [ ] if rollout fallback ships, validate an older-bud path that still emits only legacy `terminal_ready`

## Docs / Spec Alignment

- [ ] `docs/proto.md` updated
- [ ] `service/src/agent/agent.spec.md` updated
- [ ] `service/src/runtime/runtime.spec.md` updated
- [ ] `service/src/terminal/terminal.spec.md` updated
- [ ] `service/src/ws/ws.spec.md` updated
- [ ] `bud/src/src.spec.md` updated
- [ ] `bud.spec.md` updated
