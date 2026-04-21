# Interactive Sessions TODOs

## Immediate
- **Assistant timing / non-tool timing follow-up**
  - The tool-timing rollout now provides authoritative per-tool `started_at`, `finished_at`, and `duration_ms`, but exact assistant-response timing is still missing.
  - Follow up with a separate design/implementation pass if product needs authoritative non-tool timing, for example by timestamping assistant draft events or introducing an explicit turn-summary contract, rather than overloading the new tool-timing fields.
- **Web refactor test hardening**
  - Add the deeper automated browser/runtime coverage outlined in [design/web-refactor-test-hardening.md](./design/web-refactor-test-hardening.md), with priority on transcript hook behavior, agent stream reconnect/resync, terminal reconnect/recovery, and a small route-composition smoke layer.
- **Streaming JSON renderer replacement**
  - Replace the current web JSON inspection/viewer path with a streaming JSON library so large tool payloads can render incrementally instead of relying on the current heavyweight viewer.
  - Treat this as the point where web code-block rendering/highlighting gets revisited as well, since the renderer boundary will likely change and we still want broad language support up front rather than prematurely narrowing the syntax-highlighter footprint.
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
- **TUI submit semantics beyond the 10ms tmux pause**
  - The current Bud-side `text -> 10ms pause -> Enter` dispatch fixes Codex prompt submission, but it is still a timing-based workaround rather than a principled transport contract.
  - Follow up on stronger options such as explicit pane targeting, alternate submit-key semantics for TUIs that do not use plain `Enter`, or a state-based post-text submit trigger instead of a fixed sleep.
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
- **Mobile logout + account switching**
  - Implement the Bud-owned hosted logout and explicit account-switch contract from [design/mobile-auth-logout-and-account-switch.md](./design/mobile-auth-logout-and-account-switch.md) so mobile sign-out clears the hosted auth session and a follow-up sign-in can reliably choose a different account.
- **Attached tmux / terminal-query fidelity**
  - Explore a future terminal architecture that keeps a direct stdin/stdout path attached to tmux instead of relying only on detached sessions plus `capture-pane` / `pipe-pane`.
  - The current detached model is sufficient for screen capture and output streaming, but it does not faithfully support OSC/CSI palette queries, terminal-state queries, or other emulator reply flows used by TUIs like Codex during startup.
  - This work should evaluate whether Bud needs an attached tmux client, a true PTY bridge, or another direct terminal I/O path so browser-rendered terminals can answer queries correctly without timing out on fallback logic.
- **Full PTY-backed browser terminal attach**
  - If a real workflow proves the current browser escape hatch needs full terminal-emulator fidelity, design and implement a separate PTY-backed browser attach path instead of stretching the phase-1 intent-only model further.
  - This follow-up should cover emulator-originated replies, broader modifier support, and any other terminal-protocol gaps intentionally left out of [plan/browser-terminal-input-contract/implementation-spec.md](./plan/browser-terminal-input-contract/implementation-spec.md).
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
