# Validation Checklist: Fix `tmux send-keys` Literal Parse Failures

## Automated

- [x] Add a daemon unit test that verifies literal `send-keys` args include `--` before the text argument.
- [x] Cover normal text: `hello`.
- [x] Cover markdown bullet text: `- ` followed by inline code.
- [x] Cover double-dash text: `--flag-like`.
- [x] Cover tmux-option-shaped text: `-t`.
- [x] Confirm existing `bud/src/terminal/tmux.rs` tests still pass.
- [x] Run:

```bash
cargo test --manifest-path bud/Cargo.toml tmux::tests
```

Result on 2026-06-10: passed, 5 tests.

## Manual Tmux Smoke

- [ ] In a scratch tmux session, confirm the old command still reproduces the failure:

```bash
tmux send-keys -t <scratch-session> -l '- `npm run dev` starts the local development server.'
```

- [ ] Confirm the fixed command succeeds:

```bash
tmux send-keys -t <scratch-session> -l -- '- `npm run dev` starts the local development server.'
```

- [ ] Capture the pane and verify the literal markdown line appears unchanged.
- [ ] Clean up the scratch tmux session.

## Bud End-to-End

- [ ] Start a local Bud daemon build with the patch.
- [ ] Send a multiline `terminal.send` command or raw text that writes markdown containing:

```md
## Scripts

- `npm run dev` starts the local development server.
- `npm run build` creates a production build.
```

- [ ] Verify the daemon does not emit `send_keys_failed`.
- [ ] Verify the service receives a successful `terminal_send_result`.
- [ ] Verify the resulting file contains both bullet lines exactly.

## No-Change Checks

- [x] No `docs/proto.md` change is required.
- [x] No service request-dispatch change is required.
- [x] No model-facing `terminal.send` schema change is required.
- [x] No database migration is required.
- [x] No browser-facing route, SSE, loader, or ownership behavior changes are required.

---

*Last Updated: 2026-06-10*
