# Debug: web optional budget and compact tool contracts

## Environment and reproduction

Web/service branch `backend-mobile-performance`, after `1d9652d`.
Open an existing thread or recover its agent stream through `/open`.

## Observed / expected

The route converts omitted `context_budget` to null, clearing a known meter on
recovery. Initial open has no budget fetch; the inventory poll ignores budget.
Expected: render the transcript immediately, fetch budget independently, preserve
omitted values, honor explicit null, and reject obsolete budget responses.
Tool renderers still parse content/metadata despite the server's compact DTO;
local pending rows still duplicate JSON into content and metadata.

## Approach and validation

Keep budget loading separate from agent-state application so a late optional read
cannot rewind lifecycle, messages or cursor. Fence it on unmount and newer budget
updates. Normalize locally synthesized pending rows to `tool_payload`; keep local
pending/turn flags in metadata. Remove canonical content/metadata parsing in tool
and browser readers. Update affected web specs and stale bootstrap descriptions.
Validate mounted budget races, pending forms, canonical replacement, tool rendering
and browser history behavior, then build web.

All reads use existing authenticated transport and owner-authorized thread routes;
no new endpoint, global cache, DB write or ownership boundary is introduced.
This is a follow-up to `plan/backend-mobile-performance/implementation-spec.md`.

## Validation results

- `pnpm --dir web test`: initially 249 passed / 3 failed because projection
  fixtures still encoded tool identity in content/metadata. Updated fixture inputs
  to the compact contract; also moved browser return-control grouping to payload.
  Final run: 253 passed.
- `pnpm test:render` from `web/`: 67 passed, including budget race coverage.
- `pnpm build` from `web/`: passed; existing large-chunk warning remains.
- Initial root `pnpm test` invocation failed; reran with the owning web package.
- Focused ESLint initially flagged a cleanup ref warning in the new budget hook;
  cleanup now only aborts its pending request (generation checks govern supersession).
  Final focused ESLint and `git diff --check` pass with no warnings/errors; the two
  mounted budget tests also pass after the cleanup adjustment.

No physical browser/device latency measurement or deployment was performed.
