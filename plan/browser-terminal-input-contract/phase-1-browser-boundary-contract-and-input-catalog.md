# Phase 1: Browser Boundary Contract And Input Catalog

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Draft

---

## Objective

Define exactly what the browser terminal supports in phase 1, how browser shortcuts and terminal control bytes should be prioritized, and where the input translation logic should live before changing behavior.

By the end of this phase:

- the supported input catalog is explicit
- browser-vs-terminal shortcut precedence is documented
- the implementation has a clear helper/module shape
- unsupported modifier combinations can be surfaced during development

## Current Problem

Today the route lets xterm decide what comes out, then forwards whatever string `onData` emits. That makes the browser input contract implicit and impossible to reason about cleanly.

Before changing behavior, we need an explicit phase-1 contract for:

- what counts as supported human intent
- what becomes raw terminal input bytes
- what stays a browser shortcut
- what is intentionally unsupported

## Scope

### In Scope

- browser terminal input contract
- keyboard/paste catalog
- shortcut precedence rules
- helper/module boundaries for the cutover
- dev logging for unsupported key combos

### Out Of Scope

- actual removal of `onData`
- reconnect/history/resize regression hardening
- PTY-backed browser attach design

## Contract Decisions For This Phase

### Supported key families

Support in phase 1:

- printable text
- `Enter`
- `Tab`
- `Backspace`
- `Escape`
- arrows
- `Home`
- `End`
- `PageUp`
- `PageDown`
- raw `Ctrl+A` through `Ctrl+Z`
- paste text, including multiline paste

### Unsupported key families

Explicitly unsupported in phase 1:

- `Alt` / `Meta` terminal forwarding
- IME/composition input
- mouse reporting
- xterm-emitted protocol replies
- binary input paths

### Shortcut precedence

Recommended precedence rules:

1. Preserve explicit browser copy/paste behavior first.
2. If the event is a supported terminal-intent action, translate it to terminal bytes.
3. If the event falls into an explicitly unsupported modifier family, do not silently fake support.

Specific expectations:

- `Ctrl+C` with no active selection should send raw ETX.
- Copy intent should still be preserved when the user is clearly copying selected terminal text.
- Paste should flow through an explicit paste handler, not through `Meta+V` / `Ctrl+V` key translation.
- `Alt` / `Meta` combinations should be logged in development rather than forwarded by default.

## Implementation Direction

### Helper extraction

Recommended extraction to keep [`$threadId.tsx`](../../web/src/routes/$budId/$threadId.tsx) from absorbing more terminal-specific branching:

- `web/src/lib/terminal-input.ts` or
- `web/src/lib/terminal-intent.ts`

That helper should own:

- supported-key detection
- key-event to terminal-byte translation
- control-byte mapping
- navigation-sequence mapping
- development-only unsupported-event logging

Keep the route responsible for:

- listener registration and cleanup
- calling the batching/send function
- gating on connection state and active view

### Suggested helper shape

Suggested pure interfaces:

```ts
type TerminalIntent =
  | { kind: 'text'; text: string }
  | { kind: 'bytes'; text: string }
  | { kind: 'paste'; text: string }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'browser'; reason: string }

function translateTerminalKeydown(event: KeyboardEvent, options: {
  hasSelection: boolean
  platform: 'mac' | 'non-mac'
}): TerminalIntent
```

The helper should return explicit intent, not directly mutate xterm or perform network work.

### Dev instrumentation

During development, log:

- unsupported modifier combinations
- unsupported named keys
- composition-related events if observed

This should be low-noise and dev-only.

## Tasks

### Task 1: Lock the translation table

Write down the canonical phase-1 mappings, including:

- printable text
- `Ctrl+A` through `Ctrl+Z`
- navigation keys
- `Backspace`, `Escape`, `Tab`, `Enter`

### Task 2: Lock shortcut precedence

Document how the browser should distinguish:

- raw `Ctrl+C`
- copy selected text
- paste intent
- unsupported modifier shortcuts

### Task 3: Pick the helper/module boundary

Decide whether to:

- keep a small pure helper in `web/src/lib/`
- or keep the translator inline in the route

Recommendation: extract the translator into a pure helper so behavior stays testable and easier to reason about.

### Task 4: Add dev-only unsupported logging

Add light instrumentation so we can discover whether omitted `Alt`/`Meta` support matters in practice.

## Validation Checklist

- [ ] The supported key catalog is explicitly documented in code comments or the helper module.
- [ ] Copy/paste precedence is documented before implementation cutover.
- [ ] The phase-1 unsupported classes are explicit rather than accidental.
- [ ] The route-level integration plan is clear enough that Phase 2 can stay small and mechanical.

## Exit Criteria

This phase is done when the implementation team can make the input cutover without reopening questions about key support, shortcut precedence, or helper structure.
