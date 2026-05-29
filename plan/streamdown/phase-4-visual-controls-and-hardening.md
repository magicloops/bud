# Phase 4: Visual Controls And Hardening

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Partially implemented; manual visual review deferred

---

## Objective

Make the Streamdown-rendered output fit Bud's compact chat timeline and confirm code, Mermaid, math, controls, and theming behave correctly.

By the end of this phase:

- Streamdown controls are intentionally configured
- Streamdown elements are readable in light and dark mode
- code blocks, Mermaid diagrams, and math render correctly
- residual timeline movement is classified as either acceptable block finalization or a follow-up scroll-anchoring bug

## Scope

### In Scope

- CSS using `.bud-markdown` and `data-streamdown` selectors
- Streamdown control configuration
- light/dark theme checks
- code/Mermaid/math visual checks
- compact chat-column overflow behavior
- residual bounce triage

### Out Of Scope

- broad UI redesign
- replacing Streamdown internals with custom block components
- enabling every download/fullscreen control by default
- implementing scroll anchoring unless required by validation

## Implementation Tasks

### Task 1: Scope Streamdown styling

Use `className="bud-markdown"` on the Streamdown component and style through scoped selectors when needed:

```css
.bud-markdown [data-streamdown="code-block"] { ... }
.bud-markdown [data-streamdown="table-wrapper"] { ... }
.bud-markdown [data-streamdown="mermaid-block"] { ... }
```

Prefer CSS variables and `data-streamdown` selectors before component overrides.

### Task 2: Preserve compact message layout

Check these cases in the narrow left chat pane:

- long links
- long inline code
- wide code blocks
- wide tables
- Mermaid diagrams wider than the bubble
- block math wider than the bubble

The expected behavior is horizontal scrolling inside rich blocks where needed, not message-bubble overflow that breaks the timeline.

### Task 3: Review Streamdown controls

Controls should not dominate compact chat messages.

Initial control stance:

- code copy enabled
- code download disabled
- table copy enabled
- table download disabled
- Mermaid fullscreen/copy enabled if visually clean
- Mermaid download and pan/zoom disabled unless manual review says they fit

During streaming, `isAnimating` should disable controls for incomplete content.

### Task 4: Verify plugin rendering

Manual scenarios:

- fenced TypeScript or shell code block
- incomplete fenced code block while streaming
- Mermaid flowchart
- invalid Mermaid syntax
- inline math with `$$x = 1$$`
- block math with standalone `$$`
- malformed math expression

For invalid Mermaid/math, the output should fail gracefully and not break the whole message row.

### Task 5: Review light/dark theme behavior

The Streamdown docs describe shadcn-style CSS variables. Bud variables are OKLCH, not HSL tuple values.

Verify:

- text contrast
- muted code/table backgrounds
- borders and focus rings
- Mermaid controls
- KaTeX output color
- links and file-action buttons

If any Streamdown styles assume HSL tuples, patch with scoped CSS rather than changing Bud's global color model.

### Task 6: Classify residual bounce

After renderer unification, any remaining movement likely comes from:

- code highlighting finalization
- Mermaid rendering after a complete fence
- math rendering after delimiter completion
- message overflow collapse threshold
- missing resize-driven bottom anchoring

If movement is still visibly problematic, create or update a debug note before implementing scroll anchoring.

## Validation Checklist

- [ ] scoped `.bud-markdown` styling exists where needed
- [ ] long links wrap safely
- [ ] inline-code file paths wrap safely
- [ ] code blocks do not overflow the chat pane
- [ ] tables remain usable in the chat pane
- [ ] Mermaid diagrams render or fail gracefully
- [ ] math expressions render or fail gracefully
- [ ] controls do not obscure message text
- [ ] controls are disabled during streaming
- [ ] light mode is readable
- [ ] dark mode is readable
- [ ] residual bounce is absent, acceptable, or captured as a follow-up

## Exit Criteria

This phase is done when Streamdown output behaves like a polished Bud message renderer rather than an unstyled third-party embed.
