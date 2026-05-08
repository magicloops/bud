# Phase 2: Web Path Detection And Message Actions

## Priority

Urgent

## Goal

Teach the web message timeline to expose explicit file-open actions for likely workspace-relative paths in assistant responses, without creating file sessions during render.

## Scope

In scope:

- shared web path-candidate parser
- parser unit tests
- assistant-message-only detection
- Markdown local-link handling
- inline-code path handling
- optional conservative plain-text token handling
- source metadata construction for the open route
- click handler that calls Phase 1 route

Out of scope:

- polished file viewer UI
- absolute path opening
- terminal transcript detection
- user/system/tool-message detection
- server-assisted persisted-message path extraction
- structured file-reference message metadata

## Parser Contract

Add a focused helper under `web/src/lib/`, for example:

```ts
type FilePathCandidate = {
  raw_path: string;
  relative_path: string;
  line?: number;
  column?: number;
  text_range?: {
    start: number;
    end: number;
  };
  confidence: "high" | "medium";
  source_surface: "markdown_link" | "inline_code" | "plain_text";
};
```

The helper should:

- detect POSIX workspace-relative paths
- normalize leading `./`
- parse `:line`, `:line:column`, `#Lline`, and `#Lline-Lend`
- reject absolute, home, parent traversal, Windows, URL, email, NUL, and empty candidates
- preserve `raw_path` for display/audit
- keep parsing independent of React components

Line ranges can be parsed down to the starting line only in the first pass.

## Detection Surfaces

Start with high-signal assistant-message surfaces:

- Markdown links whose `href` is a local path
- inline code spans that parse as path candidates
- plain text tokens only when conservative rules pass

Recommended plain-text rules:

- require at least one slash or a known filename with extension
- require a file extension or line suffix
- avoid package names, command flags, URLs, emails, and bare directories
- trim surrounding punctuation without changing the raw display text used for audit

If plain-text detection is too noisy during implementation, keep it behind a small helper that can be disabled while Markdown links and inline code ship.

## Renderer Integration

Choose the smallest integration that keeps message rendering testable:

- pass an `openFileCandidate(...)` action from the thread route down into assistant message rendering, or
- add a thread-scoped file-viewer action context consumed by message-rendering components

Either approach is acceptable if:

- the renderer does not import route-specific state directly
- render-time detection does not call the backend
- source message id/client id can be attached to the click action
- unit tests can render content with a mocked open action

## Interaction Behavior

Markdown local links:

- render as link-like actions
- prevent default browser navigation
- call `openFileCandidate(...)` with parsed path and source metadata
- preserve external links as normal links

Inline code:

- if the full code span parses as a path, render an adjacent small file-open button or make the chip itself clickable with an accessible title
- avoid adding action chrome to non-path code spans

Plain text:

- if enabled, render only clear path candidates as file actions
- avoid noisy button insertion in dense prose

All file actions should be explicit and accessible by keyboard.

## Source Metadata

For assistant messages, include:

```json
{
  "source": {
    "kind": "assistant_message",
    "message_id": "server message id if available",
    "client_id": "stable client id if available",
    "text_range": {
      "start": 120,
      "end": 153
    }
  }
}
```

`text_range` is useful but should not block the first pass if Markdown AST integration makes exact offsets expensive. Preserve message id/client id first.

## API Call

The click action calls:

```text
POST /api/threads/:thread_id/files/open
```

Payload:

```json
{
  "path": "service/src/files/file-session.ts",
  "source": {
    "kind": "assistant_message",
    "message_id": "01HY...",
    "client_id": "0195..."
  },
  "line": 42,
  "column": 7,
  "viewer_intent": "preview"
}
```

The click handler should hand the response to the Phase 3 viewer state. Until Phase 3 lands, it can store the response in route state or show a minimal placeholder state.

## Tests

Parser tests:

- accepts relative files
- accepts leading `./`
- parses `:line`, `:line:column`, `#Lline`, and `#Lline-Lend`
- rejects absolute, home, parent traversal, Windows, URL, email, and NUL forms
- trims safe punctuation around candidates
- avoids common false positives

Renderer/action tests:

- Markdown local link calls `openFileCandidate(...)`
- Markdown external link remains a normal link
- inline code path exposes an action
- non-path inline code stays inert
- assistant render does not call the backend by itself
- user/system/tool messages do not receive first-pass file actions

## Docs And Specs

Update when implementing:

- `web/src/src.spec.md`
- relevant component folder specs
- this plan's progress and validation checklists

## Completion Gate

- [ ] Path parser exists with focused tests.
- [ ] Assistant Markdown local links expose file actions.
- [ ] Assistant inline-code path candidates expose file actions.
- [ ] Rendering a transcript does not create file sessions.
- [ ] Click actions carry source metadata and call the thread open route.
