# Phase 3: UI Diagnostics And Docs

## Objective

Expose the new resolution behavior clearly enough for users and developers without adding heavyweight UI or broad path support.

## Product Behavior

First-pass UI copy should be lightweight and display-safe.

Possible viewer labels:

- `Opened from terminal directory`
- `Opened from Bud workspace`

Possible failure copy:

- `File not found from the current terminal directory or Bud workspace.`
- `This file is outside the Bud file-viewer scope.`

Avoid showing raw absolute cwd by default.

## Implementation Steps

1. Decide whether `resolved_against` reaches the browser response.

   Options:

   - response header from file edge, such as `x-bud-file-resolved-against`
   - serialized file-session metadata after successful `HEAD`
   - internal logs/audit only

   Recommendation: start with headers/logs if easy; do not add DB persistence.

2. If exposed to web, update the file viewer state model to store resolution basis from `HEAD`.

3. Add compact copy in the viewer header or metadata area.

4. Update docs:

   - `docs/proto.md`
   - `service/src/files/files.spec.md`
   - `bud/src/files/files.spec.md`
   - `web` specs only if UI copy/state changes
   - [../../design/daemon-owned-file-path-resolution.md](../../design/daemon-owned-file-path-resolution.md) if implementation materially differs

5. Capture follow-ups explicitly:

   - pin resolved target if `HEAD` / `GET` mismatch becomes real
   - absolute path support
   - home-relative support
   - basename search
   - configured extra roots

## Tests

Add tests only for surfaces that change:

- service response/header metadata if exposed
- web viewer copy if rendered
- protocol/wire tests if typed fields change

Manual validation should cover:

- file opened from terminal cwd shows terminal-directory basis when exposed
- workspace fallback still opens and shows workspace basis when exposed
- failure copy mentions both locations without leaking absolute host paths

## Acceptance Criteria

- Developers can tell from logs/audit/protocol metadata whether terminal cwd or workspace fallback was used.
- Users get sensible copy when a file is not found.
- Browser/mobile API remains compatible.
- Docs and specs match the implemented metadata surface.
