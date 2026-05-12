# Phase 7e: Web Markdown Preview Links

**Implementation status:** Implemented on this branch.

## Context

The backend can now open absolute POSIX paths, but web Markdown previews still
render links as normal anchors.

Current web behavior:

- `FileViewerPane` renders ready Markdown files with
  `MarkdownContent content={entry.content}` and no `fileActions`.
- `MarkdownContent` renders non-intercepted links as `<a target="_blank">`.
- A preview link like `/Users/adam/bud/bud.spec.md` becomes a same-origin web
  URL and can 404 in the browser instead of calling the file-open route.

This phase wires Markdown-preview file links into the existing user-initiated
file viewer flow.

Related:

- [./phase-7d-web-absolute-path-candidates.md](./phase-7d-web-absolute-path-candidates.md)
- [../../reference/IOS_FILE_VIEWER_MARKDOWN_PREVIEW_LINKS_BACKEND_RESPONSE.md](../../reference/IOS_FILE_VIEWER_MARKDOWN_PREVIEW_LINKS_BACKEND_RESPONSE.md)

## Objective

When a user clicks an absolute POSIX link inside an opened Markdown file, web
should open that target in the file viewer instead of navigating the browser to
an app-relative URL.

Acceptance criteria:

- ready Markdown previews receive file-open actions
- absolute POSIX Markdown hrefs call the existing `useFileViewer(...)` open flow
- preview-originated opens use `source.kind = "markdown_preview"`
- original assistant `message_id` / `client_id` are preserved when the current
  file entry has them
- web URLs keep opening as external links
- unsafe protocols do not become clickable links
- unsupported local Markdown links do not navigate to misleading web-app 404s
- relative Markdown-preview file links remain deferred until parent-file-relative
  backend context exists

## React Markdown Handling

The web app uses `react-markdown` and does not own the parser/rendering library.
Keep the integration at the public component boundary:

- continue using the `components.a` override to decide how Markdown links render
- do not post-process rendered DOM
- do not install a global click handler over the Markdown pane
- do not rely on private mdast/hast node shapes for product behavior
- keep link classification in Bud-owned helpers under `web/src/lib/file-paths.ts`

`react-markdown@10` provides a default `urlTransform` that strips unsafe
protocols. Do not replace it with a permissive transform. If we need custom
behavior, compose a local safe transform that preserves the default safety model.

## Link Classification

Classify each Markdown href into one of these outcomes:

```ts
type MarkdownLinkAction =
  | { kind: "file"; candidate: FilePathCandidate }
  | { kind: "external"; href: string }
  | { kind: "unsupported_local" }
  | { kind: "unsafe" };
```

Recommended behavior:

| Href shape | Preview behavior |
| --- | --- |
| `https://...`, `http://...` | Render external anchor. |
| `mailto:...` | Render external anchor if product wants mail links; otherwise unsupported. |
| `javascript:...`, `data:...`, unsafe protocol | Render inert text, no `href`. |
| `/Users/adam/bud/docs/proto.md` | Render file-open button using `markdown_preview` source. |
| `/settings`, `/api/threads` | Render normal app link only if explicitly allowed; default to inert text in file previews. |
| `./next.md`, `../README.md`, `sibling.md` | Render unsupported local link for now; parent-file-relative open is deferred. |
| `#section` | Optional in-page anchor behavior; default to inert until heading anchors exist. |

The key product rule: file-looking local links that web cannot correctly open
must not silently navigate to the Bud app origin and show an unrelated 404.

## Preview Source Metadata

When opening a link from a Markdown preview, build the source as:

```ts
{
  kind: "markdown_preview",
  message_id: currentEntry.source?.message_id,
  client_id: currentEntry.source?.client_id
}
```

Do not send parent file context yet. The backend route does not accept a parent
file session id, and relative preview links are out of scope for this phase.

## File Viewer Integration

Add an optional callback to `FileViewerPane`:

```ts
type FileViewerPaneProps = {
  entry: FileViewerEntry | null;
  onClose: () => void;
  onReload: () => void;
  onOpenMarkdownPreviewFile?: (candidate: FilePathCandidate) => void;
};
```

For ready Markdown content:

- pass `fileActions` to `MarkdownContent`
- translate candidates to `OpenFileCandidate` with
  `source.kind = "markdown_preview"`
- leave code and plain-text viewer modes unchanged

The first web pass does not need a dedicated back stack. Clicking a supported
Markdown-preview link can switch the active file viewer entry to the opened
file. Existing entries remain in `entries_by_key`, so a later tabbed or back
navigation UI can build on the same state.

## Rendering Details

For supported file links, keep the existing file-action visual language:

- render a button, not an `<a href>`
- keep the link text wrapping behavior that prevents long paths from pushing
  controls out of view
- preserve keyboard accessibility with `type="button"` and clear labels
- avoid opening any file session during render; only call the open flow from the
  click handler

For unsupported local links, render the children without `href`. A subtle
disabled-link style is acceptable, but avoid copy that implies the file does not
exist. The backend has not evaluated those links.

## Tests

Component/parser tests:

- Markdown preview absolute POSIX link renders as a file-open button
- clicking the button calls the file-open callback with
  `source.kind = "markdown_preview"`
- original assistant message id/client id are preserved in the preview source
- external `https://` links remain anchors and do not call file-open
- unsafe protocol links do not render as clickable anchors
- relative Markdown-preview file links do not call file-open and do not navigate
  to a same-origin 404 path
- long absolute link text wraps without pushing the action out of view

Flow tests:

- clicking a Markdown-preview absolute link creates a new file session through
  `POST /api/threads/:thread_id/files/open`
- route body sends the raw absolute path
- backend-normalized `relative_path` becomes the ready entry path/display basis
- existing assistant-message relative opens still work

Manual validation:

- open a Markdown file in the web viewer
- click an absolute in-scope host path and confirm it opens in the file viewer
- click an absolute out-of-scope host path and confirm denied state
- click an external web link and confirm it opens outside the file viewer
- click a relative Markdown link and confirm it does not produce a web-app 404

## Files Likely Touched

- [../../web/src/components/workbench/file-viewer-pane.tsx](../../web/src/components/workbench/file-viewer-pane.tsx)
- [../../web/src/components/message-renderers/roles/markdown-content.tsx](../../web/src/components/message-renderers/roles/markdown-content.tsx)
- [../../web/src/components/message-renderers/roles/markdown-file-actions.ts](../../web/src/components/message-renderers/roles/markdown-file-actions.ts)
- [../../web/src/routes/$budId/$threadId.tsx](../../web/src/routes/$budId/$threadId.tsx)
- [../../web/src/features/threads/use-file-viewer.ts](../../web/src/features/threads/use-file-viewer.ts)
- [../../web/src/features/threads/file-viewer-flow.ts](../../web/src/features/threads/file-viewer-flow.ts)
- [../../web/src/components/workbench/workbench.spec.md](../../web/src/components/workbench/workbench.spec.md)
- [../../web/src/components/message-renderers/message-renderers.spec.md](../../web/src/components/message-renderers/message-renderers.spec.md)
- [../../web/src/routes/$budId/budId.spec.md](../../web/src/routes/$budId/budId.spec.md)

## Deferred Work

- parent-file-relative Markdown links such as `./next.md`
- in-page heading anchors for `#section`
- a visible file-viewer back stack
- browser visual regression coverage for long preview links
- image/PDF/binary preview expansion
