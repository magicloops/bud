# Debug: Assistant Markdown newlines

## Environment
- OS: macOS (per repo context), Node 22 runtime via pnpm.
- Apps: `service` (Node/TS + Fastify), `web` (Vite + React), Bud agent (Rust) not directly involved.
- DB: Local Postgres via `DATABASE_URL` (from `.env.local`).

## Repro steps
1. Start backend + web (Phase 4 build).
2. Trigger any user message that yields an assistant text response (no tool call).
3. Observe chat timeline entry rendered via new `react-markdown` path.

## Observed
- Assistant messages appear as a single paragraph without respecting newline characters returned by the agent.
- Inspecting the DB (and SSE debug logs) shows newline characters (`\n`) are present in `messageTable.content`, so storage is intact.
- React Markdown renders CommonMark, which collapses single newlines into spaces unless they are separated by a blank line or explicitly formatted (two trailing spaces or `<br>`). Our agent output typically uses single newlines (e.g., numbered steps) so they vanish.

## Expected
- Assistant output should show line breaks similar to how they were authored (every newline becomes a visible break) for readability of numbered steps/log-like responses.

## Hypotheses
1. **Markdown semantics**: CommonMark treats single LF as "soft break" (space). Without `remark-breaks` or manual `<br/>`, we lose line breaks. Most agent responses are plain text lists without double-newline separation, so everything collapses.
2. **Renderer fallback**: `Suspense` fallback `<p>` (plain text) still collapses newlines for the initial paint, reinforcing the perception of missing spacing even after Markdown loads.

## Proposed fix
- Pass `remarkPlugins={[remarkBreaks]}` (from `remark-breaks`) to `react-markdown` so single newlines render as `<br/>`, matching chat expectations. Alternatively, preprocess message text to replace `\n` with `  \n` prior to rendering, but plugin is cleaner and keeps Markdown semantics explicit.
- Consider customizing components (e.g., `p`, `ol`, `ul`) to tighten spacing after enabling breaks.
- Update fallback content (while Markdown chunk loads) to wrap text in `<pre className="whitespace-pre-wrap">` so interim render honors newlines.

## Next actions
- [ ] Decide on newline handling approach (remark plugin vs preprocessing).
- [ ] Implement + verify assistant messages with single newlines render as separate lines.
- [ ] Update plan/doc references if behavior change touches Markdown strategy.
