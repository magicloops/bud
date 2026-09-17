# Phase 3n: Sync Chrome's profile color to its Bud

Status: **Scoped; not implemented.** Builds on
[Phase 3k](phase-3k-shared-persistent-browser.md) and
[profile appearance defaults](profile-appearance-defaults.md).

## Objective

Use the owning Bud's accent color as the managed Chrome profile's theme seed.
Apply it whenever Bud starts the actual Chrome process, including existing
profiles. Changing a Bud's color does not restart Chrome or interrupt its tabs;
the change becomes visible on the next browser process start.

Chrome derives toolbar/background shades from the seed and system appearance.
This promises coordinated color, not a pixel-exact match to the web UI.

Related specs: [service composition](../../service/src/src.spec.md),
[service browser](../../service/src/browser/browser.spec.md),
[daemon browser](../../bud/src/browser/browser.spec.md),
[protocol](../../docs/proto.md).

## Product contract

- `bud.accent_color` is the source of truth. Reuse the service's existing
  `withFallbackAccentColors` resolution for legacy NULL values, scoped to that
  owner's Buds; do not invent a different fallback in the daemon.
- Sync on Chrome process launch, not daemon startup, service reconnect, a new
  thread tab, or every browser operation. Reusing a running process is a no-op.
- Chrome color changes made manually are replaced by the Bud color on its next
  managed launch. This supersedes the existing preserve-customization promise
  **for color only**. Profile name/avatar remain first-creation defaults, with
  subsequent user customization preserved.
- Explicit Reset clears the profile; its next launch uses the current Bud color.
  The headless readiness probe remains disposable and does not sync appearance.
- Keep the existing Chrome theme variant initially. Do not force light/dark mode,
  install an extension/theme, or silently remove a user-installed theme. If an
  installed theme takes precedence, document that limit rather than overriding it.

## Smallest implementation

### Service: resolve and normalize at launch-capable dispatch

Resolve the effective accent using the authorized Bud identity already associated
with the browser resource. Convert validated OKLCH into sRGB once in a small pure
helper with explicit out-of-gamut handling (clamp channels and round to 8-bit).
Send a normalized `#RRGGBB` seed as optional service-owned
`browser_color` metadata in the existing browser command envelope. The daemon
converts that value to Chrome's opaque signed ARGB preference representation.

Cover all commands that can create the root browser today: ordinary open and
private recovery/pause. Future Phase 3l restoration must use the same launch
configuration path. Prefer a shared enrichment helper for these dispatch sites;
do not query Bud colors on renewals, media frames or input gestures.

Resolve at dispatch rather than persisting the color in an invocation, workspace,
or browser-resource row. A concurrent edit after dispatch can take effect on the
following launch; no appearance revision protocol or live synchronization is needed.

### Daemon: update before spawning Chrome

Split existing profile initialization into two small responsibilities:

1. First-creation name/avatar defaults, preserving existing values afterward.
2. A pre-launch theme-color update for new and existing profiles.

Hold the existing profile ownership lock and verify Chrome is absent before
touching preferences. Perform the update only in the root persistent launch path,
not generic profile acquisition (which is also used by Reset). Read the complete
Preferences object and preserve every unrelated key. Update only the color seed
and any strictly necessary Chrome theme selector established by the fixture.
Do not rewrite Local State's derived color cache unless real-Chrome testing proves
it necessary. Never copy account/profile data from the developer's live profile.

Use a private temporary file in the same directory, flush it, then atomically
replace Preferences. Skip writes when the desired values already match. Reject
symlink/nonregular preference paths rather than following them. Missing preferences
in a new profile can be initialized; malformed existing JSON is never replaced
with a blank object. A cosmetic failure preserves the original file and allows
normal launch with a bounded diagnostic; normal ownership/secure-store failures
still block launch. Do not weaken existing profile recovery checks.

An absent/invalid optional color leaves existing appearance intact. On a brand-new
profile, retain the current magenta default only as the no-color fallback. This
must not become another daemon-owned palette or persistent desired-color record.

## Ownership and affected contracts

The Bud owns its accent; the browser resource binds the persistent profile to that
Bud and owner. Model arguments and browser clients cannot override envelope color,
profile paths or browser identity. Reuse current invocation/control authorization
and authenticated daemon transport. Any legacy fallback SQL filters by owner;
never load all users' Buds and filter afterward.

No new browser-facing endpoint, SSE event, table, row stamping, permission or
viewer state. The existing owner-authorized Bud settings route remains the only
color write path. The wire metadata and Rust strict request schema must change
together, with WS/gRPC tests. This unreleased browser feature uses coordinated
service/daemon updates as already agreed; no legacy lifecycle implementation.

## Validation

- Conversion fixtures: current palette, custom hue, grayscale and out-of-gamut
  values; malformed input; stable rounding and opaque signed ARGB conversion.
- Owner-scoped fallback equals the existing Bud API's effective color. Model/tool
  arguments and other users cannot select another Bud's color or profile.
- New and existing disposable profiles receive the current color before launch;
  unrelated preferences/name/avatar survive byte-value comparison after parsing.
- Reopen with a changed Bud color and verify Chrome's effective theme and saved
  preferences. Check Local State cache refresh on supported Chrome, not only JSON.
- Existing running process and second-thread open perform no appearance writes;
  private recovery that launches a process applies the color without releasing
  privacy or disclosing content. Reset/new-owner profiles use their own Bud color.
- Corrupt/nonregular/unwritable preferences remain intact; diagnostic contains no
  preference contents. No live-file edit, forced browser restart or lost sign-in.
- Daemon build, focused service/daemon tests and real headed visual comparison.

## Documentation and debt cleanup

Update service/browser and daemon/browser specs, service composition spec for the
conversion helper, and `docs/proto.md` for `browser_color`. Update the existing
appearance-defaults doc to describe the color exception. If files are added,
register them in their parent specs. Add ownership regression to the auth checklist.
No database migration or mobile changes are planned.

Keep one preference writer and one service color conversion helper. Remove the
hard-coded magenta from the normal configured-color path, retaining only the
explicit no-color fallback. No duplicated palette, per-thread theme setting,
appearance cache, timer, new broker, or runtime color polling.

## Won't-dos

No live Chrome theme updates, automatic restart, color-change acknowledgements in
chat, two-way Chrome-to-Bud sync, sync toggle, profile name/avatar synchronization,
light/dark synchronization, theme-extension management, native window visibility,
or tab/history restoration. Those do not belong in this small launch-time change.
