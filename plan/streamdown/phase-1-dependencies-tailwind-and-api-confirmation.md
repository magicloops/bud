# Phase 1: Dependencies, Tailwind, And API Confirmation

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented

---

## Objective

Install and confirm the Streamdown integration surface before changing product rendering behavior.

By the end of this phase:

- Streamdown core and requested plugins are installed
- KaTeX CSS is available for math rendering
- Streamdown animation CSS is imported once
- Tailwind v4 scans Streamdown core and plugin distributions
- the implementation has verified actual package exports locally

## Scope

### In Scope

- dependency installation in `web`
- `web/pnpm-lock.yaml` updates
- Streamdown animation CSS import
- KaTeX CSS import
- Tailwind v4 `@source` directives
- quick API export confirmation for core, code, Mermaid, and math packages
- build sanity check after dependency/CSS setup

### Out Of Scope

- replacing `MarkdownContent`
- changing `ChatTimelineMessage`
- removing old markdown dependencies
- styling Streamdown controls beyond making classes available

## Implementation Tasks

### Task 1: Install Streamdown packages

Run from the web package boundary:

```bash
pnpm --dir /Users/adam/bud/web add streamdown @streamdown/code @streamdown/mermaid @streamdown/math
```

The math reference now confirms:

- package: `@streamdown/math`
- default plugin export: `math`
- factory export: `createMathPlugin`
- required CSS import: `katex/dist/katex.min.css`

Do not remove old dependencies in this phase.

### Task 2: Confirm package exports

Before writing the renderer, inspect installed package exports through TypeScript/build feedback or direct package metadata.

Expected imports:

```ts
import {
  Streamdown,
  defaultRemarkPlugins,
  defaultRehypePlugins,
} from 'streamdown'
import { code } from '@streamdown/code'
import { mermaid } from '@streamdown/mermaid'
import { math } from '@streamdown/math'
```

If the package exports differ from the docs, update this plan or capture the divergence in the implementation PR notes before continuing.

### Task 3: Add global CSS imports

Import Streamdown animation CSS and KaTeX CSS once, likely from `web/src/main.tsx`:

```ts
import 'streamdown/styles.css'
import 'katex/dist/katex.min.css'
```

Keep `./index.css` as the app theme import.

### Task 4: Add Tailwind v4 sources

Add these source directives to `web/src/index.css`, near the Tailwind import block:

```css
@source "../node_modules/streamdown/dist/*.js";
@source "../node_modules/@streamdown/code/dist/*.js";
@source "../node_modules/@streamdown/mermaid/dist/*.js";
@source "../node_modules/@streamdown/math/dist/*.js";
```

The relative path assumes dependencies are installed under `web/node_modules`, which is consistent with the package-local lockfile. If pnpm layout differs, adjust the relative path rather than leaving broken sources.

### Task 5: Build sanity check

Run:

```bash
pnpm --dir /Users/adam/bud/web build
```

If this fails, capture the exact command and error in the implementation notes before proceeding.

## Validation Checklist

- [ ] `web/package.json` includes Streamdown core and plugin dependencies
- [ ] `web/pnpm-lock.yaml` reflects the new packages
- [ ] `streamdown/styles.css` imports successfully
- [ ] `katex/dist/katex.min.css` imports successfully
- [ ] Tailwind source directives point to real installed package files
- [ ] package exports match the expected imports or divergence is documented
- [ ] web build passes after dependency/CSS setup

## Exit Criteria

This phase is done when the project can build with Streamdown packages, animation CSS, KaTeX CSS, and Tailwind sources in place, before any renderer behavior is changed.
