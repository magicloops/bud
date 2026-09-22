# Debug: Background headed Chrome feasibility (Phase 3m)

## Environment and scope
macOS, installed Google Chrome 152.0.7977.83, disposable profiles and local synthetic
pages only. The user's live daemon/profile is not touched.

## Observations
Initial CDP minimize test allowed snapshots, semantic fill/click and screenshots.
A later wheel saw the window restored; isolating the operations showed that the
preceding `Page.bringToFront` caused delayed restoration. Without that activation,
wheel input progressed 300px while the window remained minimized, including a
background target. Snapshot/fill/click/capture took roughly 5–42ms in this fixture.

A bounded macOS NSRunningApplication experiment hid the exact spawned process;
`Page.bringToFront` unhides it as well. No native fallback is selected while the
simpler CDP approach is being validated. No Accessibility/Automation grant requested.

## Proposed implementation
Use the existing CDP channel and process/workspace ownership, not a second native
window manager. Remove implicit foreground activation only if the existing fitted
private-input regression passes. Minimize newly discovered owned windows once;
explicit human Show restores the selected owned window after private takeover.
Return must acknowledge hiding before releasing private authority. Window APIs do
not guarantee invisible first-window/popup creation or hide Chrome's Dock presence.

Related: [Phase 3m](../plan/bud-owned-browser/phase-3m-background-headed-browser.md).

## Build validation
`cargo check --manifest-path bud/Cargo.toml` initially rejected the targets future:
`future cannot be sent between threads safely`, because the ownership MutexGuard
was inferred to live across the new window await. Scoped the inventory lock in a
block so it ends before CDP I/O; no lock is held across await.

The new minimized adapter fixture initially failed `browser_stale_reference` on
semantic click. The fixture omitted the required preceding observation; added the
snapshot instead of weakening the semantic action contract.

## Results and selected approach
CDP minimization selected. No platform helper, new dependency or OS permission is
needed. `Page.bringToFront` is now reserved for explicit native Show; ordinary
pane input dispatches to its validated CDP target. The existing headed private
input regression passes without foreground activation.

A separate minimized, background-tab fixture after 30 seconds idle completed
snapshot/fill/click in 5–31ms, screenshot in 193ms, and wheel dispatch in 1ms.
Scroll advanced 300px without restoring the window. These are local synthetic
measurements, not a production latency guarantee or long-duration soak.

The regression test verifies fitted background input,
actual synthetic text/scroll results, changed screenshot bytes after a page update,
Show/Hide, and opener-owned popup windows. A new popup is minimized upon existing
inventory discovery. There is no visibility polling or extra capture loop.

Limitations: minimize leaves Chrome in the Dock/task switcher. First-window and
popup creation may be visible before inventory minimizes them. Manual native
restore/close is not intercepted. Arbitrary native dialogs, fullscreen/Spaces,
real-site idle behavior and long-duration host acceptance remain manual checks.
