# Validation Checklist: Neutral Terminal Wire Contract

Manual validation pending.

## Automated Verification Completed

- [ ] Bud tests updated and passing
- [ ] Service tests updated and passing
- [ ] Any schema-related verification completed if `tmux_session_name` is removed

## Interactive Input Contract

- [ ] A normal shell command uses canonical `text` plus `submit`
- [ ] A non-text gesture uses canonical singular `key`
- [ ] Semantic interrupt input such as `ctrl+c` works end to end
- [ ] If legacy `keys:["C-c"]` compatibility is retained, it still maps correctly during rollout
- [ ] Invalid mixed send payloads are rejected clearly

## Status And Capability Contract

- [ ] `terminal_status` no longer exposes `tmux_session` in the normal payload
- [ ] Bud hello capabilities no longer expose tmux identity/version in the normal contract
- [ ] Browser Bud list / attach flows still work after capability cleanup

## Service Runtime / Persistence

- [ ] The service no longer derives tmux session names from `session_id`
- [ ] Runtime status/fetch paths no longer emit tmux session names
- [ ] If the schema column is removed, no runtime path still depends on it

## Terminal Behavior Non-Regression

- [ ] Normal terminal send/observe flows still work
- [ ] Browser interrupt still works
- [ ] Terminal attach / streaming / history behavior remains intact
- [ ] Bud reconnect / hello / claim flow still works after capability cleanup

## Docs / Specs

- [ ] `docs/proto.md` reflects the shipped neutral contract
- [ ] Relevant Bud/service/web specs are updated
- [ ] `bud.spec.md` includes the new design/plan references coherently
