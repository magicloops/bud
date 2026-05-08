# file-viewer

Implementation planning documents for the first product pass of user-initiated host file viewing from file-path references in Bud assistant messages.

## Purpose

This folder turns [../../design/file-serving-user-initiated-viewer.md](../../design/file-serving-user-initiated-viewer.md) into a phased implementation spec and now tracks follow-on work for preserving message-time cwd context in file-viewer links.

The plan assumes:

- the existing daemon/service file-session foundation is the byte-serving primitive
- web and mobile clients use service-owned REST routes, never daemon-direct file reads
- the first product pass is user-initiated and does not add an agent file-read tool
- first-pass path support is workspace-relative only
- line and column hints are carried as metadata but do not drive first-pass scroll or highlight behavior
- the web client is the reference implementation, while the backend route is mobile-ready from day one
- the first viewer display cap is 1 MiB
- binary, image, PDF, directory, and absolute-path support remain follow-on viewer/resolver work
- historic file-link stability should use daemon-reported message-time `host_cwd` metadata before click-time tmux cwd when source-message context is available

## Files

### `implementation-spec.md`

Parent implementation spec for the file viewer productization work.

Documents:

- fixed product and security decisions
- target backend route contract
- target web interaction model
- phase sequencing
- expected implementation areas
- risks, rollout strategy, and definition of done

### `phase-1-thread-open-route-and-contract.md`

Backend-contract phase covering:

- `POST /api/threads/:thread_id/files/open`
- ownership-aware thread resolution
- relative-path validation
- viewer-scoped file-session creation
- 1 MiB display cap
- source, line, and column metadata
- backend route tests and protocol/spec updates

### `phase-2-web-path-detection-and-message-actions.md`

Web path-affordance phase covering:

- a shared path-candidate parser
- assistant-message-only path actions
- Markdown link and inline-code handling
- lazy session creation on click
- source metadata wiring from rendered messages
- parser and renderer tests

### `phase-3-web-file-viewer-and-fetch-flow.md`

Reference web viewer phase covering:

- a `file` workspace view mode
- client-side active file state
- `HEAD` and `GET` fetch flow
- Markdown, code, and plain-text rendering
- loading, denial, expiry, offline, too-large, binary, and content-change states
- reload, close, copy path, and copy content actions

### `phase-4-hardening-mobile-handoff-and-follow-ups.md`

Hardening and handoff phase covering:

- real-daemon negative file smokes
- mobile route contract handoff
- first-pass unresolved decisions
- recursive Markdown file references if straightforward
- follow-up resolver and viewer expansions

### `phase-5-historic-cwd-preservation.md`

Follow-on implementation phase covering:

- daemon `host_cwd` emission on terminal send/observe results
- service-side latest cwd persistence through `terminal_session.cwd`
- transcript `path_context` stamping for user, assistant, and tool messages
- source-message path-context lookup in the thread file-open route
- `file_open.resolution_hint` propagation to the daemon
- message-time cwd resolution before workspace-root fallback
- mixed-version rollout, tests, and spec updates

### `phase-6-source-aware-web-reuse.md`

Minimal web hardening phase covering:

- source-message-aware file-viewer entry keys
- preserving valid-session reuse for repeated clicks on the same source message
- avoiding cross-project reuse for identical relative paths from different
  assistant messages
- focused web flow tests and spec/checklist updates

### `pr-summary.md`

PR handoff summary for the branch, including changed surfaces, verification,
remaining follow-ups, and branch notes compared to `origin/main`.

### `progress-checklist.md`

Running implementation checklist for the file viewer rollout.

### `validation-checklist.md`

Automated and manual validation checklist for the backend route, web parser/actions, web viewer, and mobile handoff.

## Dependencies

- [../../design/file-serving-user-initiated-viewer.md](../../design/file-serving-user-initiated-viewer.md) - product design and fixed decisions for user-initiated file viewing
- [../../design/file-viewer-historic-cwd-preservation.md](../../design/file-viewer-historic-cwd-preservation.md) - design for preserving message-time cwd context on transcript file links
- [../../design/network-upgrade-file-serving-productization.md](../../design/network-upgrade-file-serving-productization.md) - original file-serving productization design context
- [../../design/network-upgrade-web-serving-productization.md](../../design/network-upgrade-web-serving-productization.md) - adjacent localhost web-serving productization context
- [../../design/network-upgrade-quic-transport.md](../../design/network-upgrade-quic-transport.md) - deferred optional transport context
- [../swappable-transport/implementation-spec.md](../swappable-transport/implementation-spec.md) - WebSocket-first transport foundation that file viewing builds on
- [../swappable-transport/validation-checklist.md](../swappable-transport/validation-checklist.md) - existing file/proxy foundation validation notes
- [../../docs/proto.md](../../docs/proto.md) - REST/SSE and daemon-service protocol documentation
- [../../reference/IOS_FILE_VIEWER_HANDOFF.md](../../reference/IOS_FILE_VIEWER_HANDOFF.md) - mobile client handoff for the file-viewer product contract
- [../../bud/src/terminal/terminal.spec.md](../../bud/src/terminal/terminal.spec.md) - daemon terminal cwd reporting used by historic file-link context
- [../../bud/src/files/files.spec.md](../../bud/src/files/files.spec.md) - daemon file-serving resolver behavior
- [../../service/src/runtime/runtime.spec.md](../../service/src/runtime/runtime.spec.md) - terminal runtime cwd cache and request dispatch contracts
- [../../service/src/agent/agent.spec.md](../../service/src/agent/agent.spec.md) - transcript persistence and tool-result metadata contracts
- [../../service/src/files/files.spec.md](../../service/src/files/files.spec.md) - service file-session foundation spec
- [../../service/src/routes/routes.spec.md](../../service/src/routes/routes.spec.md) - service route-family spec
- [../../web/src/src.spec.md](../../web/src/src.spec.md) - web source overview spec
- [../../web/src/components/components.spec.md](../../web/src/components/components.spec.md) - web component folder spec
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog

## TODOs / Technical Debt

- Absolute host-path support is intentionally deferred until a safe workspace-root stripping feature or daemon-owned `file_resolve` frame is designed.
- True chunk-by-chunk daemon file reading should land before increasing the 1 MiB viewer display cap.
- Binary, image, PDF, and directory viewers are follow-on expansions, not first-pass requirements.
- Server-assisted path detection and structured file-reference message metadata remain future options if client parsing proves too inconsistent.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
