# fix-send-keys-parse

Implementation planning documents for fixing daemon `tmux send-keys` literal-text parsing when terminal input lines begin with option-shaped text such as markdown bullets.

## Purpose

This folder scopes the narrow daemon fix for the 2026-06-10 `send_keys_failed` incident where a multiline markdown write reached a line beginning with `- ` and tmux parsed that literal text as a `send-keys` flag.

The plan covers:

- adding the tmux option terminator to daemon literal-text dispatch
- adding regression coverage for leading-dash literal segments
- validating the fix through focused daemon tests and a real tmux smoke path

The plan explicitly excludes the future first-class file-write or paste-buffer tool. That broader capability remains a separate issue.

## Files

### `implementation-spec.md`

Parent implementation spec for the send-keys parse fix.

Documents:

- the observed failure and local tmux reproduction
- the selected daemon-only fix
- non-goals and service/protocol boundaries
- required tests, specs, rollout, and definition of done

### `validation-checklist.md`

Companion checklist for automated and manual validation.

Covers:

- leading-dash markdown bullet regression cases
- option-shaped literal text such as `--flag` and `-t`
- normal literal text and Enter behavior
- service/wire no-change checks

## Dependencies

- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog
- [../../bud/bud.spec.md](../../bud/bud.spec.md) - daemon subsystem overview
- [../../bud/src/src.spec.md](../../bud/src/src.spec.md) - daemon source-module spec
- [../../bud/src/terminal/terminal.spec.md](../../bud/src/terminal/terminal.spec.md) - terminal backend ownership
- [../../docs/proto.md](../../docs/proto.md) - current Bud <-> Service wire contract; no protocol change is expected

## TODOs / Technical Debt

None.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
