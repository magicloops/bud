# Streamdown Message Rendering Validation Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).

## Status Legend

- `[ ]` not yet run
- `[x]` verified
- `[-]` deferred or not applicable

## Automated Validation

### Dependency And Build

- [x] `pnpm --dir /Users/adam/bud/web build`
- [x] production build includes Streamdown and plugin styles without Tailwind missing-class regressions
- [x] KaTeX CSS resolves in Vite

### Tests

- [x] `pnpm --dir /Users/adam/bud/web exec node --experimental-strip-types --test src/components/message-renderers/roles/markdown-file-actions.test.ts`
- [x] `pnpm --dir /Users/adam/bud/web test`
- [-] any new renderer helper tests pass

## Manual Validation

### Streaming Stability

- [ ] send a plain text assistant response and confirm the message does not visibly bounce when finalizing
- [ ] stream a multi-paragraph response and confirm layout remains stable
- [ ] stream a fast multi-paragraph response and confirm no Streamdown text-reveal animation, caret chrome, or delayed word reveal appears
- [ ] stream a bulleted list and confirm incomplete markdown renders acceptably
- [ ] stream a fenced code block and confirm incomplete code does not break the row
- [ ] confirm final assistant replacement keeps the same visual renderer family

### Code

- [ ] fenced TypeScript block renders with highlighting
- [ ] fenced shell block renders with highlighting
- [ ] code block chrome matches Bud's compact message styling
- [ ] code block surface has no visible outer border
- [ ] code block corners visually align with Mermaid/table rich-block surfaces
- [ ] code font size is close to the previous renderer density or intentionally revised
- [ ] chat line-number behavior is explicit and unobtrusive
- [ ] code copy control works
- [ ] code controls do not cover code text in the compact chat pane
- [ ] code copy control aligns with the block edge in light and dark mode
- [ ] code copy control is hidden until hover/focus on desktop/fine-pointer devices
- [ ] code copy control stays visible while moving the pointer from the code block to the above-surface control
- [ ] code copy control remains visible on mobile/coarse-pointer devices
- [ ] code copy control appears above the code surface without shifting layout
- [ ] code copy control background uses the dark code surface treatment
- [ ] multi-line fenced code preserves line breaks when chat line numbers are disabled
- [ ] no-language fenced code renders without a visible header
- [ ] wide code blocks scroll or wrap acceptably without breaking the message bubble

### Mermaid

- [ ] valid Mermaid flowchart renders
- [ ] invalid Mermaid syntax fails gracefully
- [ ] Mermaid controls fit the chat bubble
- [ ] Mermaid block chrome is visually calmer than the default plugin surface
- [ ] Mermaid label/header is not visible in chat output
- [ ] Mermaid block shows only one diagram surface border
- [ ] Mermaid copy/fullscreen controls are hidden until hover/focus on desktop/fine-pointer devices
- [ ] Mermaid copy/fullscreen controls stay visible while moving the pointer from the diagram to the above-surface controls
- [ ] Mermaid copy/fullscreen controls remain visible on mobile/coarse-pointer devices
- [ ] Mermaid copy/fullscreen controls appear above the diagram surface without shifting layout
- [ ] Mermaid output is readable in light mode
- [ ] Mermaid output is readable in dark mode

### Tables

- [ ] normal table renders in light mode
- [ ] normal table renders in dark mode
- [ ] table block chrome is visually aligned with Mermaid/code rich blocks
- [ ] table block shows only one table surface border
- [ ] table action row does not create a visible top gap
- [ ] table copy control is hidden until hover/focus on desktop/fine-pointer devices
- [ ] table copy control stays visible while moving the pointer from the table to the above-surface control
- [ ] table copy control remains visible on mobile/coarse-pointer devices
- [ ] table copy control appears above the table surface without shifting layout
- [ ] table copy action works
- [ ] wide tables remain horizontally scrollable inside the message column
- [ ] long cell content remains contained
- [ ] table controls do not overlap table content in the compact chat pane

### Math

- [ ] inline math using `$$x = 1$$` renders
- [ ] block math using standalone `$$` delimiters renders
- [ ] malformed math fails gracefully
- [ ] KaTeX output is readable in light mode
- [ ] KaTeX output is readable in dark mode

### Links And File Actions

- [ ] external HTTP link opens in a new tab
- [ ] `mailto:` link behavior remains safe
- [ ] unsafe protocol such as `javascript:` remains inert
- [ ] relative Markdown file link opens the file viewer from a persisted assistant message
- [ ] absolute POSIX Markdown file link opens through the file viewer when supported
- [ ] unsupported local links stay inert in Markdown preview contexts
- [ ] inline-code file candidate shows copyable code plus a separate open-file button
- [ ] clicking inline code copies text
- [ ] clicking the file button opens the file viewer and does not copy instead
- [ ] draft assistant file-open payload omits synthetic `message_id`
- [ ] persisted assistant file-open payload includes durable `message_id`

### Timeline And Activity

- [ ] thinking indicator remains below the latest message
- [ ] thinking indicator remains suppressed while assistant text is visibly streaming
- [ ] final text-only answer does not flash the thinking indicator before `final`
- [ ] tool-loop response can show activity between assistant text segments
- [ ] long messages render at full natural height without expand/collapse controls
- [ ] message copy button still copies raw markdown content

### Theme And Layout

- [ ] light mode message markdown is readable
- [ ] dark mode message markdown is readable
- [ ] links and file action buttons match Bud's accent behavior
- [ ] tables fit the chat pane
- [ ] block math overflow is contained in the chat pane
- [ ] blockquotes, headings, and lists have acceptable spacing
- [ ] Streamdown controls have visible focus states
- [ ] no text/control overlap in compact chat messages

## Docs / Spec Alignment

- [x] `web/web.spec.md` describes Streamdown dependencies
- [x] `web/src/src.spec.md` describes Streamdown CSS/Tailwind sources
- [x] `web/src/components/message-renderers/message-renderers.spec.md` describes streaming/static renderer props
- [x] `web/src/components/message-renderers/roles/roles.spec.md` describes Streamdown and plugins
- [x] `web/src/components/workbench/workbench.spec.md` describes draft rows using shared markdown renderer
- [x] `web/src/components/ui/ui.spec.md` reflects any `CodeBlock`/`InlineCode` changes
- [x] `bud.spec.md` references the new plan folder

## Notes

- Human visual validation may be performed outside the implementation turn. If so, leave those items unchecked until someone actually runs them.
- If residual bounce remains after renderer unification, create or update a debug note before implementing scroll anchoring.
- Automated validation completed on 2026-05-29, including the Phase 9 code copy chrome build; manual validation remains open for the team to run against the already-running dev server.
