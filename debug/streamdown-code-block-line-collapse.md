# Debug: Streamdown Code Block Line Collapse

## Environment

- Repo: `/Users/adam/bud`
- Area: Web UI assistant/user Markdown renderer
- Date: 2026-06-03
- OS: macOS Darwin 24.6.0 arm64
- Node: v22.14.0
- Renderer: `streamdown@2.5.0` with `@streamdown/code@1.1.1`
- DB connection style: not involved
- LLM mode: not involved; investigation used a direct renderer probe

## Repro Steps

1. Render this Markdown through the Bud web message renderer:

````markdown
```bash
cd ~/code/prashanth-graduation
npm run dev
```
````

2. View the fenced code block in the chat timeline.

## Observed

- The two shell commands display on one visual line.
- The content reads like `cd ~/code/prashanth-graduationnpm run dev` rather than two stacked lines.

## Expected

- Fenced code blocks preserve authored newlines.
- The sample should display as two separate code lines.
- This should remain true with Bud's current chat preference of hiding code line numbers.

## Current Implementation Trace

- `web/src/components/message-renderers/roles/markdown-content.tsx` renders user and assistant Markdown through `Streamdown`.
- The renderer passes `lineNumbers={false}`.
- Streamdown owns fenced code block rendering through `@streamdown/code`.
- Bud's scoped CSS in `web/src/index.css` sets `.bud-markdown [data-streamdown="code-block-body"] code { white-space: pre; }`.

## Findings

- A direct static render of the repro Markdown through the installed Streamdown package reproduced the relevant DOM shape.
- With `lineNumbers={false}`, Streamdown renders highlighted code as one wrapper `<span>` per source line, but those line wrapper spans have no `block` class.
- Streamdown also does not insert newline text nodes between those wrapper spans.
- Because the line wrapper spans are inline by default, the browser lays them out adjacent to each other.
- Bud's `white-space: pre` rule cannot preserve a newline that is not present in the text node stream.
- Rendering the same sample with `lineNumbers={true}` adds Streamdown's per-line class list, including `block`, to each line wrapper span. That explains why the line collapse is tied to Bud's `lineNumbers={false}` configuration.

Reduced shape from the render probe:

```html
<code>
  <span><span>cd ~/code/prashanth-graduation</span></span>
  <span><span>npm run dev</span></span>
</code>
```

With line numbers enabled, those outer line spans become block-level:

```html
<code class="[counter-increment:line_0] [counter-reset:line]">
  <span class="block ..."><span>cd ~/code/prashanth-graduation</span></span>
  <span class="block ..."><span>npm run dev</span></span>
</code>
```

## Hypotheses

- Primary: Streamdown's code block body relies on the line wrapper spans being block-level, but only applies that block styling through the line-number class path.
- Secondary: Bud exposed the bug by intentionally disabling code line numbers for compact chat rendering.
- Unlikely: `remark-breaks` is involved. The repro is a fenced code block, and Streamdown's code path receives two token lines.
- Unlikely: Bud's code-block `white-space` override is the cause. It is insufficient here because the rendered code line wrappers lack newline text between them.

## Proposed Fix Direction

- Prefer a scoped CSS fix in `web/src/index.css`:
  - target direct line wrapper spans under `.bud-markdown [data-streamdown="code-block-body"] code`
  - set those direct line wrappers to `display: block`
  - leave nested token spans inline so syntax highlighting remains unchanged
- Validate:
  - two-line fenced code block without line numbers
  - one-line fenced code block
  - blank lines inside fenced code
  - horizontally long lines still scroll inside the code block body
  - copy control still copies the original newline-preserving code

## Spec Files Affected If Fixed

- `web/src/src.spec.md`
- `web/src/components/message-renderers/roles/roles.spec.md`
- `plan/streamdown/validation-checklist.md` if manual code-block validation expectations are updated

## Status

- Investigation documented.
- Upstream bug report filed separately.
- Applied a Bud-scoped CSS workaround in `web/src/index.css` that makes direct Streamdown code-line wrapper spans block-level under `[data-streamdown="code-block-body"] code`.
- The workaround keeps nested syntax token spans inline and keeps Bud's `lineNumbers={false}` chat preference.
