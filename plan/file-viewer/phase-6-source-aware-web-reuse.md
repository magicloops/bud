# Phase 6: Source-Aware Web File Reuse

**Implementation status:** Complete on 2026-05-06.

**Verification status:** Focused web file-viewer flow test, web production
build, and `git diff --check` passed.

## Context

Phase 5 made source-message path context meaningful. The backend can now resolve
the same relative path differently depending on which assistant message produced
the link.

The web viewer still keys ready entries by normalized relative path only:

```text
workspace:src/index.ts
```

That can incorrectly reuse an existing file session when two assistant messages
from different project contexts mention the same relative path.

## Objective

Keep valid-session reuse for repeated clicks on the same message and file, while
avoiding cross-message reuse when message-time cwd context may differ.

Acceptance criteria:

- Assistant-message file candidates with a `source.message_id` include that id
  in the web file-viewer key.
- Contextless candidates keep the existing relative-path key.
- Repeated clicks on the same assistant-message file still reuse a valid ready
  session.
- Clicking the same relative path from a different assistant message creates a
  fresh file session.
- Reload preserves the source-aware key because it reuses the active entry
  source metadata.

## Implementation

Update [../../web/src/features/threads/file-viewer-state.ts](../../web/src/features/threads/file-viewer-state.ts):

- extend `fileViewerKey(...)` to accept optional source metadata
- return `workspace:<relative_path>:source_message:<message_id>` for
  assistant-message candidates with a message id
- return the existing `workspace:<relative_path>` key otherwise
- use the source-aware key in `createPendingFileEntry(...)`

Update [../../web/src/features/threads/file-viewer-flow.ts](../../web/src/features/threads/file-viewer-flow.ts):

- compute the open-flow key from both `candidate.relative_path` and
  `candidate.source`

Update focused tests:

- keep existing same-key reuse coverage
- add coverage that a ready entry from one `source.message_id` is not reused for
  the same relative path from another `source.message_id`

## Docs And Specs

Update:

- [./file-viewer.spec.md](./file-viewer.spec.md)
- [./progress-checklist.md](./progress-checklist.md)
- [./validation-checklist.md](./validation-checklist.md)
- [../../web/src/features/threads/threads.spec.md](../../web/src/features/threads/threads.spec.md)
- [../../reference/IOS_FILE_VIEWER_HANDOFF.md](../../reference/IOS_FILE_VIEWER_HANDOFF.md) if wording needs to reflect the implemented web behavior

## Test Plan

Run:

```bash
pnpm --dir /Users/adam/bud/web exec node --experimental-strip-types --test src/features/threads/file-viewer-flow.test.ts
pnpm --dir /Users/adam/bud/web build
git diff --check
```

Completed on 2026-05-06.
