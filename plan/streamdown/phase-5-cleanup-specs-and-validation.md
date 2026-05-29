# Phase 5: Cleanup, Specs, And Validation

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Automated validation complete; manual visual review deferred

---

## Objective

Finish the Streamdown migration by removing obsolete dependencies, updating specs, and recording automated/manual validation.

By the end of this phase:

- old markdown dependencies are removed or intentionally retained
- specs describe the new renderer
- tests/build pass
- manual validation status is recorded
- follow-ups are explicit

## Scope

### In Scope

- dependency cleanup
- dead component cleanup
- specs/docs updates
- automated tests
- production build
- manual validation checklist closure
- follow-up capture for deferred work

### Out Of Scope

- new backend contracts
- mobile handoff
- adding a full browser visual-regression framework

## Implementation Tasks

### Task 1: Remove obsolete dependencies when safe

After Streamdown renders all message markdown paths, evaluate removing:

- `react-markdown`
- `react-syntax-highlighter`
- `@types/react-syntax-highlighter`
- `remark-gfm`
- `@tailwindcss/typography`

Likely keep:

- `remark-breaks`, if still passed to Streamdown

Only remove `@tailwindcss/typography` if no `prose` classes remain in `web/src`.

### Task 2: Remove or retain old UI components deliberately

If `CodeBlock` is no longer referenced:

- delete `web/src/components/ui/code-block.tsx`
- update `web/src/components/ui/ui.spec.md`

If `InlineCode` is still used by the Streamdown `inlineCode` override:

- keep it
- update the spec to explain it is now used by Streamdown inline-code customization

### Task 3: Update specs

Update all specs affected by changed behavior:

- `web/web.spec.md`
- `web/src/src.spec.md`
- `web/src/components/message-renderers/message-renderers.spec.md`
- `web/src/components/message-renderers/roles/roles.spec.md`
- `web/src/components/workbench/workbench.spec.md`
- `web/src/components/ui/ui.spec.md`
- `bud.spec.md`

If no feature-thread behavior changes beyond passing `isStreaming`, `web/src/features/threads/threads.spec.md` may not need an update.

### Task 4: Run focused tests

At minimum:

```bash
pnpm --dir /Users/adam/bud/web exec node --experimental-strip-types --test src/components/message-renderers/roles/markdown-file-actions.test.ts
pnpm --dir /Users/adam/bud/web test
```

If new pure helpers are introduced, add targeted Node-runner tests for them.

### Task 5: Run production build

Run:

```bash
pnpm --dir /Users/adam/bud/web build
```

This validates TypeScript, Vite bundling, Tailwind source scanning, Streamdown imports, and KaTeX CSS resolution.

### Task 6: Record manual validation status

Use [validation-checklist.md](./validation-checklist.md) as the manual runbook.

If humans perform visual validation outside the implementation turn, update the checklist status later rather than claiming it was run.

### Task 7: Capture follow-ups

If any of these remain, capture them explicitly:

- residual message bounce requiring resize scroll anchoring
- Streamdown control styling refinements
- broader raw HTML policy review
- richer Mermaid controls
- math syntax guidance for model prompts
- visual regression harness

## Validation Checklist

- [ ] unused markdown dependencies removed or documented as retained
- [ ] unused UI components deleted or documented as retained
- [ ] affected specs updated
- [ ] focused file-action tests pass
- [ ] full web test suite passes
- [ ] web production build passes
- [ ] manual validation checklist is updated
- [ ] follow-ups are captured

## Exit Criteria

This phase is done when the Streamdown migration is cleanly documented, verified, and free of stale dependency/spec references.
