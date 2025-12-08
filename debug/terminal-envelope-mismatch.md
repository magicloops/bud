# Debug: Terminal Envelope Mismatch (message_id/sent_at vs id/ts)

## Problem
- Backend terminal_* frames use `{ proto, type, message_id, sent_at, extensions }`.
- Bud deserializes all frames into `Envelope { type, proto, id, ts, ext }` (expects `id`/`ts`).
- Result: Bud logs `missing field "id"` on terminal_ensure and drops the connection; gateway then has no active session and terminal_input fails (503).

## Options
1) **Update Bud to accept both envelopes (aliases)**
   - Add `#[serde(alias = "message_id")]` for `id` and `#[serde(alias = "sent_at")]` for `ts`, or introduce a TerminalEnvelope with these aliases and use it for terminal_* frames.
   - **Pros:** Backward compatible with existing run/session frames; keeps backend as-is; aligns with terminal proto v0.2 shapes; minimal surface change.
   - **Cons:** Bud code becomes slightly looser; need to ensure all terminal_* handlers use the tolerant envelope.

2) **Change backend to include id/ts on terminal_* frames (dual fields)**
   - Emit both `id`/`ts` and `message_id`/`sent_at` in terminal frames.
   - **Pros:** Keeps Bud strict; no Bud changes; unblocks quickly.
   - **Cons:** Duplication/noise in payloads; deviates from the terminal doc (proto v0.2); risks drift if we forget to include both everywhere; still need to align long term.

3) **Unify on one envelope across all frames**
   - Rename terminal frames to use the same envelope fields as run/session (`id`/`ts`), or migrate all frames to `message_id`/`sent_at`.
   - **Pros:** One consistent contract; cleaner long term.
   - **Cons:** Requires coordinated change across backend and Bud; riskier given existing run/session code; may require doc updates and more testing.

## Recommendation
- Short term: Option 1 (add aliases on Bud and/or a TerminalEnvelope) to accept both `id`/`ts` and `message_id`/`sent_at` for terminal_* frames. This unblocks without payload duplication and preserves existing run/session framing.
- Longer term: Decide on a single envelope naming convention (likely `message_id`/`sent_at` for proto v0.2 terminal) and standardize both sides, updating docs accordingly.
