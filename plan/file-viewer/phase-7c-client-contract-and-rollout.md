# Phase 7c: Client Contract And Rollout

**Implementation status:** Implemented on this branch.

## Context

Phase 7a and Phase 7b add backend support for absolute POSIX file opens. Phase
7c updates the client-facing contract and defines how mobile/web should enable
Markdown-preview links without taking on filesystem-policy responsibilities.

Related:

- [./phase-7-absolute-path-opens.md](./phase-7-absolute-path-opens.md)
- [./phase-7a-daemon-file-resolve-frame.md](./phase-7a-daemon-file-resolve-frame.md)
- [./phase-7b-service-absolute-preflight.md](./phase-7b-service-absolute-preflight.md)
- [../../reference/IOS_FILE_VIEWER_MARKDOWN_PREVIEW_LINKS_BACKEND_RESPONSE.md](../../reference/IOS_FILE_VIEWER_MARKDOWN_PREVIEW_LINKS_BACKEND_RESPONSE.md)

## Objective

Document and validate the public behavior mobile/web can rely on once absolute
POSIX opens ship.

Acceptance criteria:

- mobile handoff documents that absolute POSIX paths are accepted when backend
  support is deployed
- mobile keeps parent-file context local for back navigation only
- mobile uses the open response `file_session.path.relative_path` for
  cache/display keys
- mobile maps outside-root absolute paths to denied
- clients still reject web URLs, `mailto:`, NUL, Windows, backslash, and
  trailing-slash directory forms locally where practical
- web remains compatible, even if recursive Markdown-preview links are still
  deferred on web

## Client Contract

Request shape:

```json
{
  "path": "/Users/adam/bud/docs/proto.md",
  "source": {
    "kind": "markdown_preview",
    "message_id": "22222222-2222-4222-8222-222222222222",
    "client_id": "33333333-3333-4333-8333-333333333333"
  },
  "viewer_intent": "preview"
}
```

Response shape remains the normal file-session response. Clients should:

- preserve `file_session.path.raw_path` as the original request
- use `file_session.path.relative_path` for normalized cache/display identity
- use `viewer.display_name` for the title when available
- keep `display_metadata.requested_path_kind` and
  `display_metadata.resolved_against` as optional diagnostics
- keep `display_metadata.path_context` hidden if present in older/relative flows

## Mobile Markdown-Preview Behavior

Recommended mobile behavior after backend support is enabled:

- web links open Safari
- non-web absolute POSIX links call the thread open route
- `source.kind = "markdown_preview"`
- original assistant `message_id` / `client_id` are included when available
- parent file session/path stays in the local navigation stack only
- back navigation selects the prior viewer stack entry
- reload creates a fresh session only when the current session is expired,
  revoked, missing, content-changed, or explicitly refreshed

Relative Markdown-preview links such as `./next.md` and `../README.md` remain
deferred. They need parent-file-relative backend context.

## Rollout Gate

Mobile should not enable absolute Markdown-preview file opens against backends
that do not include Phase 7 support.

Acceptable gates:

- environment/release coordination for the first staging rollout
- an explicit backend capability endpoint later, if product needs independent
  client/server rollout
- conservative fallback: if the open route returns `400 invalid_file_path` for
  an absolute POSIX path, treat absolute opens as unsupported for that session

Recommended default for the first rollout: coordinate by backend release version
or staging environment. Add a formal capability only if mobile and backend need
to ship independently across mixed environments.

## Error Mapping

| HTTP / condition | Mobile state |
| --- | --- |
| `201`, then `HEAD 200` | Open normally |
| `400 invalid_file_path` | Invalid/unsupported path |
| `403` | Denied/outside scope |
| `404` from open route | Thread inaccessible or file not found, based on body |
| `410` from edge | Expired/revoked; create fresh session |
| `409` | Content changed during read, or stale range identity; create fresh session |
| `413` or `HEAD content-length > viewer.max_display_bytes` | Too large |
| `424` / `503` | Bud/file transport unavailable |
| `504` | Retryable timeout |
| invalid UTF-8 or NUL decoded content | Unsupported binary |

## Documentation Updates

Update after implementation:

- [../../reference/IOS_FILE_VIEWER_HANDOFF.md](../../reference/IOS_FILE_VIEWER_HANDOFF.md)
- [../../reference/IOS_FILE_VIEWER_MARKDOWN_PREVIEW_LINKS_BACKEND_RESPONSE.md](../../reference/IOS_FILE_VIEWER_MARKDOWN_PREVIEW_LINKS_BACKEND_RESPONSE.md)
- [../../docs/proto.md](../../docs/proto.md)
- [./validation-checklist.md](./validation-checklist.md)
- [./progress-checklist.md](./progress-checklist.md)

## Validation

Mobile validation:

- absolute Markdown-preview link under allowed root opens
- absolute Markdown-preview link outside allowed root shows denied
- absolute missing in-root path shows not found
- directory path shows invalid/unsupported
- navigation stack back returns to the parent file
- response `relative_path` is used for cache/display
- web links still open Safari

Backend/web validation:

- existing assistant-message relative opens still work
- web parser/action tests still pass
- web file-viewer flow tests still pass
- service focused absolute-open tests pass
- daemon file resolver tests pass
