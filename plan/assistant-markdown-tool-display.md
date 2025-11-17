# Plan: Assistant Markdown & Tool Rendering

## Context
- Link to issue(s): internal Phase 4 polish (agent UI) follow-up.
- Related docs/sections in `/plan/proof-of-concept.md`: Phase 4 (Agent loop + UI integration), Phase 3 UI scaffolding notes.

## Objective
- Render assistant (non-tool) messages with Markdown (CommonMark + GFM basics) without blocking initial paint.
- Keep tool call entries in structured “tool” cards backed by a lazy JSON viewer toggle (already implemented) instead of raw JSON.
- Minimize bundle impact and avoid re-render churn when large assistant outputs stream in.

## Design / Approach
- **Dependency additions**: `react-markdown` (and optional remark plugins if needed later). Load via dynamic `import()` so the Markdown renderer is only fetched when an assistant message exists.
- **Chat timeline API**: extend `ChatMessage` to label assistant vs. tool vs. user; include metadata for tool payloads (already stored) and surface `content` for Markdown.
- **Rendering strategy**:
  - For assistant responses (role `assistant` with text output), lazily mount a `ReactMarkdown` component (via dynamic import or `React.lazy`) with suspense fallback (`<p>` fallback) to keep initial DOM light.
  - Tool call messages keep the “tool chip + toggleable JSON viewer” UI; no Markdown rendering for them.
- **Performance considerations**:
  - Memoize transformed message list and ReactMarkdown component to avoid re-parsing identical content.
  - Avoid loading remark plugins sprint 1; keep baseline Markdown (CommonMark) for speed. Document future option for `remark-gfm`.
  - Use `React.lazy` + `Suspense` for Markdown importer so first render stays synchronous.
  - Keep viewer collapsed by default and collapse JSON output depth `1` to limit DOM size.

## Impacted contracts
- [ ] WSS protocol
- [ ] SSE events
- [ ] DB schema (migration)
- [ ] Agent adapter/tool registry
- [ ] Web UI surfaces ✅ (`web/src/components/workbench/chat-timeline.tsx`, `App.tsx`)

## Test plan
- Manual:
  - Load a thread with existing assistant/tool messages; ensure Markdown renders headings, lists, inline code.
  - Verify user + tool messages still render as before.
  - Toggle JSON viewer; ensure no console warnings.
  - Confirm bundle loads additional chunk only after assistant message appears (inspect Network tab optional).
- Automated: rely on lint + type-check (no dedicated tests yet).

## Rollout
- Update `PROGRESS.md` after implementation.
- Note dependency addition (`react-markdown`) in `web/README.md` if relevant.

## Out of scope
- Syntax highlighting for fenced code blocks (future enhancement).
- Remark/Rehype plugins (tables, math) beyond baseline CommonMark.
- Streaming partial Markdown rendering (current SSE already handles append-only lines, but ReactMarkdown will render final concatenated text only).
