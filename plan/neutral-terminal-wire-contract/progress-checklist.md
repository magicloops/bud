# Progress Checklist: Neutral Terminal Wire Contract

## Phase 1: Compatibility Foundation And Contract Shape

- [ ] Define canonical neutral contract shapes in service/Bud types
- [ ] Add tolerant parsing for legacy status/capability/input payloads where needed
- [ ] Enforce explicit validation rules for `text`, `submit`, `key`, and legacy `keys`
- [ ] Add compatibility parsing/regression tests

## Phase 2: Single-Gesture `terminal.send` Cutover

- [ ] Add canonical singular `key`
- [ ] Normalize legacy `keys` into the single-gesture model
- [ ] Update first-party agent/browser/service call sites to emit the canonical shape
- [ ] Update prompt/tool guidance to use semantic keys such as `ctrl+c`

## Phase 3: Terminal Status And Hello Capability Cleanup

- [ ] Remove `tmux_session` from normal `terminal_status` payloads
- [ ] Remove tmux identity/version fields from normal hello capabilities
- [ ] Clean service/web normalization layers for the neutral payload shape
- [ ] Update protocol/spec examples away from tmux-specific wording

## Phase 4: Service Runtime And Persistence Cleanup

- [ ] Remove tmux-session-name derivation from service runtime code
- [ ] Remove first-class runtime dependence on `tmuxSessionName`
- [ ] Complete a repo-wide consumer audit for `tmux_session_name`
- [ ] Remove the schema column if no real consumer remains

## Phase 5: Validation, Specs, And Rollout Cleanup

- [ ] Run automated verification
- [ ] Run manual validation checklist
- [ ] Update protocol/spec docs
- [ ] Record explicit compatibility-shim retention or removal
- [ ] Record any diagnostics/admin follow-up separately

