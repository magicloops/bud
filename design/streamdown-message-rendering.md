# Design: Streamdown Message Rendering

Status: Draft

Created: 2026-05-28

Audience: Web

Related:
- [../reference/streamdown/getting-started.md](../reference/streamdown/getting-started.md)
- [../reference/streamdown/configuration.md](../reference/streamdown/configuration.md)
- [../reference/streamdown/styling.md](../reference/streamdown/styling.md)
- [../reference/streamdown/customize-components.md](../reference/streamdown/customize-components.md)
- [../reference/streamdown/plugins.md](../reference/streamdown/plugins.md)
- [../reference/streamdown/plugins-code.md](../reference/streamdown/plugins-code.md)
- [../reference/streamdown/plugins-mermaid.md](../reference/streamdown/plugins-mermaid.md)
- [../reference/streamdown/plugins-math.md](../reference/streamdown/plugins-math.md)
- [../debug/assistant-message-render-bounce.md](../debug/assistant-message-render-bounce.md)
- [../web/src/components/workbench/chat-timeline.tsx](../web/src/components/workbench/chat-timeline.tsx)
- [../web/src/components/message-renderers/roles/markdown-content.tsx](../web/src/components/message-renderers/roles/markdown-content.tsx)
- [../web/src/components/message-renderers/roles/markdown-file-actions.ts](../web/src/components/message-renderers/roles/markdown-file-actions.ts)
- [../web/src/features/threads/use-thread-messages.ts](../web/src/features/threads/use-thread-messages.ts)
- [../web/src/index.css](../web/src/index.css)

---

## 1. Summary

Bud currently renders assistant drafts as plain `whitespace-pre-wrap` text and then replaces the same message with `react-markdown` once the canonical assistant row arrives. That branch switch is the likely cause of the visible timeline bounce documented in [assistant-message-render-bounce.md](../debug/assistant-message-render-bounce.md).

The preferred direction is to make one renderer own both states:

- streaming assistant drafts
- final persisted assistant markdown
- user markdown
- Markdown file previews if we choose to fold them into the same renderer later

Use `streamdown` for the shared renderer, with:

- `mode="streaming"` / `isAnimating` / `animated` for draft assistant rows
- `mode="static"` and no animation for persisted rows
- `@streamdown/code`, `@streamdown/mermaid`, and the math plugin
- Tailwind v4 `@source` entries for Streamdown core and installed plugin packages
- Bud's current file-open affordances preserved through `components.a` and `components.inlineCode`

This should be a client-side web change. It does not require backend SSE or message-contract changes.

---

## 2. Current Implementation

### Draft vs. final rendering

`web/src/features/threads/use-thread-messages.ts` creates draft assistant rows from `agent.message_start`, `agent.message_delta`, and `agent.message_done`. These rows have:

```ts
metadata: {
  turn_id: turnId,
  draft: true,
}
```

`web/src/components/workbench/chat-timeline.tsx` then renders draft assistant rows with a special branch:

```tsx
<div className="whitespace-pre-wrap">
  {message.content}
  <span className="..." />
</div>
```

When the later `agent.message` event arrives, the route removes the draft row for that turn and upserts the canonical assistant message. The visible row is keyed by `client_id`, so React can keep the same message component mounted while the body switches to the role renderer.

The final assistant renderer is `MarkdownContent`, which uses:

- `react-markdown`
- `remark-gfm`
- `remark-breaks`
- Tailwind Typography `prose`
- custom `code`, `pre`, and `a` components
- `CodeBlock`, which lazy-loads `react-syntax-highlighter`
- `InlineCode`, including click-to-copy behavior

That means the visible DOM can switch from simple pre-wrapped text to markdown block layout, then shift again when syntax highlighting finishes loading.

### File-open affordances

`MarkdownContent` has important Bud-specific behavior that must survive the Streamdown migration:

- Markdown links are passed through `getMarkdownLinkAction(...)`.
- Local file candidates render as explicit file-open buttons.
- Unsupported local links can be rendered inert for Markdown file previews.
- External links are constrained to safe external forms.
- Inline-code file candidates keep the copyable code styling and add a separate file-open button.
- `createFileOpenClickHandler(...)` only invokes file opening on user click, never during render.

The thread route turns parsed file candidates into `OpenFileCandidate` payloads and calls `useFileViewer(...)`. The backend route accepts source metadata with optional `message_id` and `client_id`. `message_id` is used for source-message path context when present.

### Tailwind setup

`web/src/index.css` currently uses Tailwind v4:

```css
@import "tailwindcss";
@plugin "@tailwindcss/typography";
@import "tw-animate-css";
```

There is no Tailwind config content array. Streamdown's docs require Tailwind v4 `@source` directives in the CSS file so Tailwind sees utility classes inside `streamdown` and plugin package distributions.

---

## 3. Streamdown Findings

From the local Streamdown docs:

- Core package: install `streamdown`.
- Tailwind v4: add `@source` entries for `streamdown/dist/*.js`.
- Animation: import `streamdown/styles.css` when using the built-in `animated` prop.
- Streaming state: pass `isAnimating={true}` while content is streaming. This disables interactive controls during streaming.
- Renderer mode: `mode` supports `"streaming"` and `"static"`.
- Incomplete markdown: `parseIncompleteMarkdown` defaults to `true`, using remend to complete unterminated markdown blocks while streaming.
- GFM is default via Streamdown's default remark plugins.
- Custom component overrides fully replace Streamdown defaults for that element.
- For inline code, use the virtual `inlineCode` component if we only want to customize inline spans. Do not override `code` unless we also want to replace block code, syntax highlighting, Mermaid, and other code-fence renderers.
- Built-in/default rehype behavior includes raw HTML processing plus sanitization and hardening. This differs from the current `react-markdown` setup and should be reviewed explicitly.
- The code plugin is `@streamdown/code`, imported as `code` or built with `createCodePlugin(...)`.
- The Mermaid plugin is `@streamdown/mermaid`, imported as `mermaid` or built with `createMermaidPlugin(...)`.
- The math plugin is `@streamdown/math`, imported as `math` or built with `createMathPlugin(...)`; it also requires `katex/dist/katex.min.css`.

---

## 4. Proposed Architecture

### New shared renderer

Replace `MarkdownContent` with a Streamdown-backed renderer, or keep the same exported name while changing the implementation:

```tsx
type MarkdownContentProps = MessageContentRendererProps & {
  isStreaming?: boolean
  inertLocalLinks?: boolean
  allowedFilePathKinds?: readonly AllowedFilePathKind[]
}
```

The implementation should render:

```tsx
<Streamdown
  mode={isStreaming ? 'streaming' : 'static'}
  isAnimating={isStreaming}
  animated={isStreaming}
  caret={isStreaming ? 'block' : undefined}
  className="bud-markdown"
  remarkPlugins={[...Object.values(defaultRemarkPlugins), remarkBreaks]}
  plugins={{ code, mermaid, math }}
  components={{
    a: BudMarkdownLink,
    inlineCode: BudInlineCode,
  }}
>
  {content}
</Streamdown>
```

Exact imports should still be confirmed against installed package exports. The important shape is:

- use Streamdown for both streaming and static content
- keep `remark-breaks` unless we intentionally accept changed soft-line-break behavior
- use Streamdown's default GFM instead of importing `remark-gfm` directly
- use `inlineCode`, not `code`, for Bud inline-code behavior
- do not override `pre` in v1

### Chat timeline usage

`ChatTimelineMessage` should stop special-casing draft assistant rows as plain text. Instead:

- still compute `isDraftAssistant`
- still use draft metadata for activity-indicator behavior
- pass `isStreaming={isDraftAssistant}` into the role renderer
- render assistant draft and persisted assistant content through the same component

This is the core bounce fix. The row can still transition from streaming mode to static mode, but it no longer changes from plain text to a different markdown renderer.

### File actions

Preserve the current helper seam:

- keep `markdown-file-actions.ts`
- keep `getMarkdownLinkAction(...)`
- keep `getInlineCodeFileCandidate(...)`
- keep `createFileOpenClickHandler(...)`
- update tests only as needed for Streamdown component props

Recommended component override split:

| Markdown element | Streamdown override | Reason |
| --- | --- | --- |
| Links | `components.a` | Preserve file-open buttons, inert local links, safe external links |
| Inline code | `components.inlineCode` | Preserve click-to-copy and inline file-open affordances without replacing fenced-code plugins |
| Fenced code | no override in v1 | Let `@streamdown/code`, Mermaid, and math pipelines handle blocks |
| Pre | no override in v1 | Avoid disrupting Streamdown controls and block wrappers |

For draft assistant rows, avoid passing the synthetic draft `message_id` as a persisted message id. The source should either:

1. include only `client_id` while the row is still a draft, or
2. disable file actions until the persisted assistant row arrives.

Recommendation: use option 1. The backend accepts `client_id` without `message_id`; the file can still open, but the route will not try to load historic source-message path context until the canonical row exists. Once the row is persisted, include both `message_id` and `client_id` as today.

---

## 5. Tailwind And CSS

Install dependencies in the web package:

```bash
pnpm --dir /Users/adam/bud/web add streamdown @streamdown/code @streamdown/mermaid @streamdown/math
```

The math docs now confirm the package and import shape; implementation should still verify installed package exports during the dependency phase.

Add Tailwind v4 sources to `web/src/index.css`. Because this package has its own `web/pnpm-lock.yaml` and normally installs dependencies under `web/node_modules`, the path from `web/src/index.css` should be:

```css
@source "../node_modules/streamdown/dist/*.js";
@source "../node_modules/@streamdown/code/dist/*.js";
@source "../node_modules/@streamdown/mermaid/dist/*.js";
@source "../node_modules/@streamdown/math/dist/*.js";
```

If pnpm hoists these packages differently, adjust the paths before landing.

Import Streamdown animation CSS from the web entrypoint:

```ts
import 'streamdown/styles.css'
```

`web/src/main.tsx` is the likely place because it already imports `./index.css` and is the app-wide entrypoint.

No Tailwind prefix is needed. `web/components.json` uses an empty prefix, and `web/src/index.css` imports Tailwind without `prefix(...)`.

The current theme variables already expose `--background`, `--foreground`, `--muted`, `--muted-foreground`, `--border`, `--ring`, and `--radius`, which are the main variables Streamdown documents. The values are OKLCH rather than HSL; verify rendered Streamdown controls in light and dark modes because some third-party CSS may assume shadcn-style HSL variable contents.

---

## 6. Security And UX Decisions

### Raw HTML

Current `react-markdown` usage does not install `rehype-raw`, so raw HTML is not intentionally rendered as live HTML.

Streamdown defaults include `rehype-raw`, `rehype-sanitize`, and `rehype-harden`. Sanitized HTML is safer than raw HTML, but still changes behavior. For v1, prefer preserving the stricter current product posture unless there is a clear reason to support model-produced HTML.

Implementation should evaluate one of:

- pass `skipHtml`
- customize `rehypePlugins` to omit raw HTML
- keep Streamdown defaults only after confirming the sanitizer schema and allowed attributes match Bud's risk tolerance

### Link safety

Bud already owns link behavior in `getMarkdownLinkAction(...)`. Overriding `components.a` means Streamdown's default link component and any default link-safety UI may not apply to anchors. That is acceptable for v1 if we keep the current rules:

- file links become explicit buttons
- unsafe protocols are inert
- supported external links open with `target="_blank"` and `rel="noopener noreferrer"`
- unsupported local links can be inert in preview contexts

### Controls

Streamdown can render copy/download/fullscreen controls for code, tables, and Mermaid. The first implementation should configure controls deliberately instead of accepting surprising defaults in the compact chat column.

Recommended initial stance:

- code: copy on, download off unless requested
- tables: copy on, download off unless requested
- Mermaid: fullscreen and copy on; download/pan-zoom can be enabled after visual review
- controls disabled during streaming via `isAnimating`

---

## 7. Implementation Plan

1. Verify package APIs locally after install:
   - `streamdown`
   - `@streamdown/code`
   - `@streamdown/mermaid`
   - math plugin package exports and KaTeX CSS resolution
2. Add Tailwind `@source` lines to `web/src/index.css`.
3. Import `streamdown/styles.css` from `web/src/main.tsx`.
4. Replace `MarkdownContent` internals with Streamdown while keeping the public component export stable.
5. Add `isStreaming?: boolean` to `MessageContentRendererProps`.
6. Update `ChatTimelineMessage` so draft assistant rows use the role renderer with `isStreaming`.
7. Preserve file-open behavior with `components.a` and `components.inlineCode`.
8. Adjust draft file-action source handling so synthetic draft `message_id` is not sent as a persisted source message id.
9. Remove old markdown dependencies only after the build and visual review pass:
   - likely remove `react-markdown`
   - likely remove `react-syntax-highlighter`
   - likely remove `@types/react-syntax-highlighter`
   - likely remove `remark-gfm`
   - keep `remark-breaks` if we pass it to Streamdown
   - consider removing `@tailwindcss/typography` only if no `prose` classes remain
10. Update specs:
   - `web/web.spec.md`
   - `web/src/src.spec.md`
   - `web/src/components/message-renderers/message-renderers.spec.md`
   - `web/src/components/message-renderers/roles/roles.spec.md`
   - `web/src/components/workbench/workbench.spec.md`
   - `web/src/components/ui/ui.spec.md` if `CodeBlock` is deleted or no longer used

---

## 8. Validation Plan

Automated:

- run existing file-action helper tests
- add/update tests proving link and inline-code file candidates remain lazy and click-only
- run the web test suite
- run the web build

Manual:

- plain streaming assistant response does not bounce on finalization
- markdown list streamed incrementally stays visually stable
- fenced code block streams as incomplete markdown, then finalizes with code highlighting
- Mermaid fence streams as code/placeholder until complete, then renders the diagram
- math syntax renders after the math plugin is enabled
- external links still open safely
- unsafe links stay inert
- relative file links open the file viewer from final assistant messages
- absolute POSIX file links still open through the file viewer
- inline-code file candidates still show copyable code plus a separate file-open affordance
- dark mode and light mode Streamdown controls are readable
- the timeline remains sticky while the last message grows

---

## 9. Risks And Follow-Ups

- Implementation must verify Streamdown package exports after install, including `@streamdown/math` and KaTeX CSS resolution.
- Streamdown's sanitized raw HTML default is a behavior change from the current renderer unless we explicitly disable or customize it.
- Mermaid, math, and Shiki can still cause legitimate height changes after a block completes. If bounce remains after renderer unification, the next fix should be timeline scroll anchoring on message resize.
- Streamdown controls may not match Bud's neobrutalist UI out of the box. Prefer CSS variables and `data-streamdown` selectors before replacing block components.
- Overriding `code` would break the plugin pipeline; avoid that in v1.
- Download/fullscreen controls in a narrow chat column need visual review before enabling broadly.

---

## 10. Recommendation

Proceed with a web-only Streamdown migration:

- one Streamdown-backed renderer for streaming and final markdown
- Streamdown animations for draft assistant rows
- Streamdown code, Mermaid, and math plugins
- Tailwind v4 `@source` integration
- Bud-owned link and inline-code overrides preserved
- no backend event-flow changes

Keep the implementation narrow enough that any remaining movement can be attributed to real block finalization, not to switching from a text renderer to a markdown renderer.
