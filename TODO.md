# Interactive Sessions TODOs

## Immediate
- **Session observability**
  - Expose per-session metrics (bytes in/out, writer rotations, truncate counts) via logs + `/metrics` to feed future dashboards.
  - Surface `last_activity_at` + idle TTLs in `/api/sessions` so the UI can flag stale sessions.
- **Reattach & roster UX**
  - Implement `/api/sessions` list + UI to reattach, show SSE status badges outside the interactive pane, and warn when the writer seat is free.
  - Offer “Copy as text” / download for `session_log` (ANSI-stripped + raw) once soft caps trigger.
- **Docs / QA**
  - Fold the manual verification recipe into README/developer docs and reference the new SSE endpoints.
  - Extend integration coverage for `/term` (attach → resize → Take writer) to guard against regressions.

## Future / Long-Term
- **tmux durability (Phases 4.8–5.1)**
  - Detect/install tmux, adopt durable sessions across Bud restarts, add scrollback replay, multi-viewers.
- **Session transcripts & exports**
  - Persist transcripts (UTF-8/plain + ANSI-stripped) to blob storage and expose download/export endpoints.
- **GC & quotas**
  - Enforce idle TTL / hard TTL with cleanup jobs and soft quotas per tenant.
- **Monitoring & admin tooling**
  - Centralized metrics dashboards (sessions open, writer rotations, errors).
  - Admin API to list/force-close sessions and view logs.

We can call the interactive sessions feature “complete” once the reliability polish is finished (xterm.js, SSE, docs/tests) and at least tmux stubs (Phase 4.8) are in place, with multi-viewer/export tracked as follow-on enhancements.
