# Phase 4: Hardening, Mobile Handoff, And Follow-Ups

## Priority

High

## Goal

Close the first file viewer pass with validation, docs/spec alignment, mobile contract handoff, and explicit follow-up scoping for capabilities intentionally deferred from the web-first implementation.

## Scope

In scope:

- real-daemon smoke validation
- daemon policy negative smokes where practical
- backend/web docs and specs alignment
- mobile route contract handoff
- final decisions on remaining first-pass parser/viewer unknowns
- follow-up tickets or plan notes for absolute paths and richer previews

Out of scope:

- implementing absolute host-path support
- implementing daemon `file_resolve`
- implementing binary/image/PDF viewers
- implementing true chunk-by-chunk daemon file reads
- adding model-facing file tools

## Real-Daemon Validation

Run a WebSocket-only daemon/service/web stack and validate:

1. assistant references a known workspace-relative file
2. message action appears only after render and does not create a session
3. clicking creates one file session
4. `HEAD` and `GET` complete through the service edge
5. file renders in the web right pane
6. repeated click reuses the active entry while valid
7. reload works after session expiry or revocation

Negative smokes to add where possible:

- path outside workspace is rejected
- symlink is rejected
- directory is rejected
- non-regular file is rejected
- too-large file returns the viewer too-large state
- content identity change is detected when the existing foundation exposes it
- daemon offline/carrier unavailable maps to viewer offline state

## Mobile Handoff

Capture the mobile-ready contract in [../../reference/IOS_FILE_VIEWER_HANDOFF.md](../../reference/IOS_FILE_VIEWER_HANDOFF.md).

Minimum handoff content:

- route: `POST /api/threads/:thread_id/files/open`
- edge routes: `HEAD /api/files/:file_session_id`, `GET /api/files/:file_session_id`
- auth behavior: `401` unauthenticated, `404` non-owner
- first-pass path scope: workspace-relative only
- request/response JSON examples
- parser rules and rejected forms
- 1 MiB viewer cap
- expected status-code-to-UI-state mapping
- line/column metadata behavior
- session reuse guidance
- limitations and planned follow-ups

The handoff should make clear that mobile should not use the Bud-scoped low-level file-session create route for this product workflow unless a later design changes that.

## Remaining Decisions To Close

Before marking the first pass complete, decide:

- whether plain-text path detection stays enabled or limited to links/inline code
- whether the first web state remains single-visible-entry only or includes hidden entry cache for future tabs
- whether recursive Markdown-preview file references shipped in Phase 3 or move to follow-up
- which source metadata fields are reliably available from persisted and streamed assistant messages

Record the final decisions in this plan and any mobile handoff.

## Follow-Up Scope

Track these separately from the first pass:

- absolute path support through daemon-owned `file_resolve`
- safe service-side display-root stripping if a daemon/workspace root contract is added
- true chunk-by-chunk daemon file reads
- viewer pagination/range loading for large files
- image preview
- PDF preview
- binary download/open-with behavior if product wants it
- directory browsing if product wants a file explorer
- clickable references inside Markdown previews if deferred
- server-assisted path detection after streamed-response behavior is reconciled
- structured file-reference message metadata if prompt conventions and client parsing are not enough
- model-facing file-read tools under a separate security design

## Docs And Specs

Update:

- `docs/proto.md`
- `service/src/files/files.spec.md`
- `service/src/routes/routes.spec.md`
- affected web specs
- [../../reference/IOS_FILE_VIEWER_HANDOFF.md](../../reference/IOS_FILE_VIEWER_HANDOFF.md)
- [../../bud.spec.md](../../bud.spec.md)
- this plan's progress and validation checklists

## Completion Gate

- [ ] Real-daemon happy-path smoke passes.
- [ ] Negative policy smokes are covered or explicitly deferred with rationale.
- [ ] Mobile handoff exists if needed by the iOS repo.
- [ ] Remaining first-pass parser/viewer decisions are recorded.
- [ ] Follow-up capabilities are scoped outside this implementation pass.
- [ ] Specs and protocol docs match the implementation.
