# Interactive Sessions TODOs

## Immediate
- **Reliability polish (Plan Phase 4.7)**
  - Stream session status via SSE so the web UI doesn’t rely solely on the WS.
  - Add metrics/logs for session lifecycle (attach/detach counts, bytes in/out).
  - Clamp PTY output with backpressure/permessage-deflate to keep Bud stable.
  - Upgrade the web pane to xterm.js so ANSI, scrolling, and copy behave like a real terminal.
- **Docs / Proto**
  - Document the current `session_*` frames in `docs/proto.md`.
  - Update service/web READMEs with the new APIs, “Take writer” flow, and env vars.
- **Testing**
  - Add unit coverage around `SessionManager` (attach tokens, log truncation).
  - Manual verification script for attach/resize/close across browsers.

## Future / Long-Term
- **tmux durability (Phases 4.8–5.1)**
  - Detect/install tmux, adopt durable sessions across Bud restarts, add scrollback replay, multi-viewers.
- **Session SSE & transcripts**
  - Persist session transcripts (UTF-8/plain + ANSI-stripped) and expose download/export.
- **GC & quotas**
  - Enforce idle TTL / hard TTL with cleanup jobs and soft quotas per tenant.
- **Monitoring & admin tooling**
  - Centralized metrics dashboards (sessions open, writer rotations, errors).
  - Admin API to list/force-close sessions and view logs.

We can call the interactive sessions feature “complete” once the reliability polish is finished (xterm.js, SSE, docs/tests) and at least tmux stubs (Phase 4.8) are in place, with multi-viewer/export tracked as follow-on enhancements.
