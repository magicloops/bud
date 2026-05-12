# Phase 7d: Web Absolute Path Candidates

**Implementation status:** Implemented on this branch.

## Context

Phase 7a/7b added backend and daemon support for absolute POSIX path opens, but
the web client still treats file candidates as workspace-relative only.

Current web behavior:

- `web/src/lib/file-paths.ts` rejects candidates that start with `/`.
- `OpenFileCandidate` requires `relative_path`, even before the backend has
  resolved an absolute path.
- The file-viewer flow keys pending entries by that relative path.

That means a user-clicked absolute path cannot reach
`POST /api/threads/:thread_id/files/open` from web today, even though the
backend can handle it.

Related backend phases:

- [./phase-7-absolute-path-opens.md](./phase-7-absolute-path-opens.md)
- [./phase-7a-daemon-file-resolve-frame.md](./phase-7a-daemon-file-resolve-frame.md)
- [./phase-7b-service-absolute-preflight.md](./phase-7b-service-absolute-preflight.md)

## Objective

Let the web client parse and submit absolute POSIX file candidates while keeping
existing relative-path behavior unchanged.

Acceptance criteria:

- assistant-message Markdown links and inline code can expose absolute POSIX
  file actions when the path is file-like
- relative assistant-message candidates keep source-message-aware reuse keys
- absolute candidates send the raw path to the existing thread file-open route
- pending absolute entries do not require a fake `relative_path`
- after the backend returns a session, the viewer stores the daemon-normalized
  `file_session.path.relative_path`
- existing URL, `mailto:`, Windows, backslash, home-relative, NUL, directory,
  email, and low-confidence prose rejections remain in place

## Candidate Model

Replace the relative-only candidate shape with a narrow union:

```ts
type FilePathCandidate =
  | {
      path_kind: "relative";
      raw_path: string;
      relative_path: string;
      line?: number;
      column?: number;
      source_surface: FilePathSourceSurface;
    }
  | {
      path_kind: "absolute_posix";
      raw_path: string;
      requested_path: string;
      display_path: string;
      line?: number;
      column?: number;
      source_surface: FilePathSourceSurface;
    };
```

`OpenFileCandidate` should mirror the same union plus `source`.

The route body stays simple:

```ts
{
  path: candidate.raw_path,
  source: candidate.source,
  line: candidate.line,
  column: candidate.column,
  viewer_intent: "preview"
}
```

Do not make the web client prove workspace containment. The daemon owns that
policy through backend `file_resolve`.

## Parser Rules

Keep the current relative parser behavior.

Add absolute POSIX support only for high-confidence file candidates:

- starts with a single `/`
- does not start with `//`
- does not contain NUL or backslashes
- does not end with `/`
- is not URL-like, `mailto:`, or a Windows drive path
- has a file-like basename by known extension, known filename, or line suffix

Examples to accept:

- `/Users/adam/bud/bud.spec.md`
- `/Users/adam/bud/service/src/files/file-session.ts:42`
- `/home/codex/project/README.md#L12`
- `/workspaces/bud/Makefile`

Examples to reject:

- `/settings`
- `/api/threads`
- `/Users/adam/bud/docs/`
- `//example.com/file.md`
- `C:/Users/adam/file.md`
- `~/bud/README.md`
- `https://example.com/file.md`

Rationale: absolute POSIX paths and app-relative URLs both begin with `/` in
HTML. Requiring file-like signals prevents common app links from being hijacked
as host-file opens.

## File Viewer Keying

Relative candidates should keep the existing key:

```text
workspace:<relative_path>:source_message:<message_id>
```

Absolute candidates need a two-step key:

1. Pending key before backend response:

   ```text
   absolute_posix:<raw_path>
   ```

2. Canonical key after successful open:

   ```text
   workspace:<file_session.path.relative_path>
   ```

When an absolute open succeeds and the canonical key differs from the pending
key, move the entry under the canonical key and set `active_key` to the
canonical key.

For absolute paths, do not include `source.message_id` in the canonical key by
default. The daemon has already resolved the absolute path to a concrete
workspace-relative target. Source-aware keying remains necessary for relative
assistant-message links because the same relative text can resolve differently
from different message-time cwd contexts.

## UI Copy

The existing file-viewer states can be reused.

One copy update is needed:

- `invalid_path` should no longer say only workspace-relative paths are
  supported. It should describe unsupported path syntax more generally.

## Tests

Parser tests:

- accepts absolute POSIX Markdown-link candidates with known extensions
- accepts absolute POSIX inline-code candidates with known extensions
- parses line and column metadata on absolute candidates
- rejects app-like slash paths such as `/settings` and `/api/threads`
- rejects URLs, protocol-relative URLs, Windows paths, backslashes, home paths,
  directories, NUL bytes, and low-confidence absolute strings
- keeps existing relative parser cases passing

Flow/state tests:

- absolute candidate sends `raw_path` to the open route
- absolute pending entry uses an absolute pending key
- successful absolute open moves the entry to the backend-normalized workspace
  key
- repeated absolute clicks reuse a ready normalized entry after the first open
- relative source-message keying remains unchanged

## Files Likely Touched

- [../../web/src/lib/file-paths.ts](../../web/src/lib/file-paths.ts)
- [../../web/src/lib/file-paths.test.ts](../../web/src/lib/file-paths.test.ts)
- [../../web/src/features/threads/file-viewer-state.ts](../../web/src/features/threads/file-viewer-state.ts)
- [../../web/src/features/threads/file-viewer-flow.ts](../../web/src/features/threads/file-viewer-flow.ts)
- [../../web/src/features/threads/file-viewer-flow.test.ts](../../web/src/features/threads/file-viewer-flow.test.ts)
- [../../web/src/components/message-renderers/roles/markdown-content.tsx](../../web/src/components/message-renderers/roles/markdown-content.tsx)
- [../../web/src/lib/lib.spec.md](../../web/src/lib/lib.spec.md)
- [../../web/src/features/threads/threads.spec.md](../../web/src/features/threads/threads.spec.md)

## Known Unknowns

- Whether to percent-decode Markdown hrefs before sending them to the backend.
  Default: preserve the href string for now and add decoding only after testing
  real Markdown sources with spaces.
- Whether absolute paths without extensions should be allowed beyond the current
  known filename list. Default: keep the file-like requirement conservative.
- Whether the web client should eventually use a backend capability before
  exposing absolute file actions. Default: rely on route errors for this branch;
  add explicit capability gating only if mixed web/backend deployments become a
  practical issue.
