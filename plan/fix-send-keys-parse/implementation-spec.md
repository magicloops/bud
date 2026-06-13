# Implementation Spec: Fix `tmux send-keys` Literal Parse Failures

**Status**: Implemented
**Created**: 2026-06-10
**Source Incident**: `send_keys_failed` while writing markdown with list items
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)

---

## Context

The agent attempted to write a relatively long markdown file through `terminal.send`. Most content was delivered, but the daemon failed just after:

```md
## Scripts

- `npm run dev` starts the local development server.
```

The service reported `send_keys_failed`, and the daemon logged:

```text
command send-keys: invalid flag -
terminal_send dispatch failed ... error=tmux send-keys literal text failed
```

The current daemon path is:

1. service sends a `terminal_send` frame with `text` and optional `submit`
2. daemon normalizes CRLF/CR to LF
3. daemon splits multiline text on `\n`
4. daemon sends each nonempty line through `tmux send-keys -t <session> -l <segment>`
5. daemon sends Enter between segments and optionally after the final segment

That means a markdown bullet line becomes one literal segment beginning with `- `. tmux still parses option-shaped arguments unless option parsing is terminated.

Local reproduction:

```bash
tmux send-keys -t bud_dash_repro_01 -l '- `npm run dev` starts the local development server.'
# command send-keys: invalid flag -
```

Confirmed mitigation:

```bash
tmux send-keys -t bud_dash_repro_01 -l -- '- `npm run dev` starts the local development server.'
# succeeds
```

## Objective

Make daemon literal-text dispatch robust for text segments that begin with `-`, without changing the service-to-Bud wire contract or the model-facing `terminal.send` contract.

Acceptance criteria:

- [x] literal text beginning with `- ` is sent successfully at the daemon tmux-argv boundary
- [x] literal text beginning with option-shaped values such as `--flag` and `-t` is sent successfully at the daemon tmux-argv boundary
- [x] ordinary literal text still sends unchanged
- [x] multiline terminal sends still press Enter between segments and after submitted commands
- [x] service request-dispatch behavior remains unchanged
- [x] no Bud protocol, SSE, database, or browser contract changes are introduced

## Chosen Direction

Apply a daemon-only fix in `bud/src/terminal/tmux.rs`:

```text
tmux send-keys -t <session> -l -- <text>
```

The important part is the `--` after `-l`. This terminates tmux option parsing before the literal text argument, so leading hyphen content is treated as text.

Recommended implementation shape:

- keep `send_literal_text(session_name, text)` as the public tmux-backend method
- introduce a small helper for constructing literal `send-keys` args, or otherwise make the `--` placement easy to test
- add unit coverage for the argument vector so the regression does not require a live tmux server in normal test runs
- optionally keep a manual real-tmux smoke command in the validation checklist for release confidence

## Non-Goals

- No first-class file-write tool in this tranche.
- No paste-buffer or bulk-text transport redesign in this tranche.
- No service-side escaping or markdown rewriting.
- No changes to `terminal_send` payload shape.
- No changes to the model-facing `terminal.send` schema.

## Expected Files And Areas

### Bud

- `bud/src/terminal/tmux.rs`

Likely change:

- add `--` to literal-text `tmux send-keys` invocation
- add or update tests near the existing tmux helper tests

### Specs / Docs

- `bud/src/terminal/terminal.spec.md`
- `bud/src/src.spec.md`
- `bud/bud.spec.md` if the daemon overview needs a wording update after implementation

No update should be required for:

- `docs/proto.md`
- service specs
- web specs
- database migration docs

## Test Plan

Automated tests:

- add daemon unit coverage showing literal `send-keys` args include `--` before text
- cover at least:
  - `hello`
  - `- markdown bullet`
  - `--flag-like`
  - `-t`
- preserve existing tmux helper tests
- run focused daemon tests:

```bash
cargo test --manifest-path bud/Cargo.toml tmux::tests
```

Manual validation:

- reproduce the old tmux failure in a scratch tmux session if needed
- verify the same leading-dash literal succeeds with `-l --`
- run an end-to-end Bud terminal send that writes markdown containing list items and confirms the resulting file contains the bullet lines

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| `--` placement is wrong for older tmux versions | Low | Medium | Validate against the local tmux version and keep the change isolated to literal-text dispatch |
| Test only validates argument construction, not tmux behavior | Medium | Low | Add a manual real-tmux smoke item for release validation |
| Long multiline writes still expose other terminal-input fragility | Medium | Medium | Keep this fix narrow and track the future first-class file-write tool separately |
| A service-side workaround masks the daemon bug | Low | Medium | Do not change service escaping or payload construction in this tranche |

## Rollout

This is daemon-only and backward compatible:

1. land the daemon patch and focused tests
2. ship updated Bud daemon builds
3. no service deployment ordering is required
4. older daemons may still fail on leading-dash literal text until upgraded

## Definition Of Done

- [x] daemon literal send uses `tmux send-keys -l -- <text>`
- [x] automated regression tests cover leading-dash and option-shaped literal segments
- [x] focused daemon test command passes
- [x] relevant daemon specs are updated
- [x] validation checklist is completed or explicitly annotated

## Validation Notes

- `cargo test --manifest-path bud/Cargo.toml tmux::tests` passed on 2026-06-10.
- Real tmux smoke and full Bud end-to-end validation remain manual checklist items.

---

*Last Updated: 2026-06-10*
