# Interactive Sessions TODOs

## Immediate
- **Schema deploy parity (`db:migrate` vs `db:push`)**
  - Align staging/production schema rollout with the actual repo workflow: either generate and commit Drizzle SQL migrations for deploy-time `pnpm db:migrate`, or intentionally switch deploys to the audited `pnpm db:push` wrapper.
  - Capture the current `message.client_id` staging gap as the concrete example: predeploy `pnpm db:migrate` ran, but no generated migration existed, so staging never received the new column before the backfill script ran.
- **Cancel vs interrupt contract**
  - Decide and implement the product/API contract for agent cancel vs terminal interrupt so web and mobile do not need to guess whether "stop" means aborting the LLM loop, sending Ctrl+C to the terminal, or both.
- **Bud base dir + local identity mode**
  - Implement the launch-cwd-based Bud base dir model from [design/bud-base-dir-and-local-identity.md](./design/bud-base-dir-and-local-identity.md), including `--base-dir`, `--local`, local identity under `<base-dir>/.bud/`, and the same-change service-side terminal session cwd wiring.
- **Self-serve Bud install flow**
  - Implement the authenticated `+`-button install modal from [design/self-serve-bud-install-command-and-local-mode.md](./design/self-serve-bud-install-command-and-local-mode.md), including machine-wide vs local install commands, one-time install tokens, generic `install.sh`, and daemon fallback to the QR/browser claim flow.
- **Bud terminal dependency preflight**
  - Show an actionable startup error, or fail fast, when Bud is launched with terminal support enabled but `tmux` is not installed, instead of allowing the claim/connect flow to proceed into handshake or runtime failures.
- **Session observability**
  - Expose per-session metrics (bytes in/out, writer rotations, truncate counts) via logs + `/metrics` to feed future dashboards.
  - Surface `last_activity_at` + idle TTLs in `/api/sessions` so the UI can flag stale sessions.
- **Reattach & roster UX**
  - Implement `/api/sessions` list + UI to reattach, show SSE status badges outside the interactive pane, and warn when the writer seat is free.
  - Offer "Copy as text" / download for `session_log` (ANSI-stripped + raw) once soft caps trigger.
- **Docs / QA**
  - Fold the manual verification recipe into README/developer docs and reference the new SSE endpoints.
  - Extend integration coverage for `/term` (attach → resize → Take writer) to guard against regressions.

## Future / Long-Term
- **Style-aware TUI bootstrap fidelity**
  - Extend the rich terminal bootstrap contract so refresh/new-page restores can preserve TUI colors and other styling, instead of only restoring plain text rows plus cursor/geometry metadata.
  - Keep this as a follow-up to the current cursor/geometry bootstrap work; see [debug/thread-terminal-tui-colors-missing-after-bootstrap.md](./debug/thread-terminal-tui-colors-missing-after-bootstrap.md).
- **Mobile logout + account switching**
  - Implement the Bud-owned hosted logout and explicit account-switch contract from [design/mobile-auth-logout-and-account-switch.md](./design/mobile-auth-logout-and-account-switch.md) so mobile sign-out clears the hosted auth session and a follow-up sign-in can reliably choose a different account.
- **Session durability enhancements**
  - tmux is already the default terminal backend. Future work: reconnect to existing tmux sessions across Bud restarts, scrollback replay, multi-viewers.
- **Session transcripts & exports**
  - Persist transcripts (UTF-8/plain + ANSI-stripped) to blob storage and expose download/export endpoints.
- **GC & quotas**
  - Enforce idle TTL / hard TTL with cleanup jobs and soft quotas per tenant.
- **Monitoring & admin tooling**
  - Centralized metrics dashboards (sessions open, writer rotations, errors).
  - Admin API to list/force-close sessions and view logs.

We can call the interactive sessions feature "complete" once the reliability polish is finished (xterm.js, SSE, docs/tests), with multi-viewer/export tracked as follow-on enhancements.
