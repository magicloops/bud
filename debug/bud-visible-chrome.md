# Debug: visible managed Chrome experiment

## Environment and observations
Local macOS; regular Chrome 152.0.7977.83. The user reports that Reddit's human
challenge does not complete through Bud's viewer. No cause has been established.
The current launcher always uses headless mode and debugging port zero; human
input forwards clicks and wheel events but not the full pointer/keyboard stream.

## Approach
Add opt-in `BUD_BROWSER_HEADED=1` for a visible, isolated managed browser with a
nonzero loopback debugging port. Preserve ephemeral profiles and all existing
control/ownership checks. Discover the endpoint from the owned child's stderr
(nonzero ports do not use the port-zero discovery-file path). Drain stderr without
logging page content. Retain the default headless path.

Validate launch, semantic helper attachment, snapshot/capture and the observed
`navigator.webdriver` value on a synthetic page, without patching page properties.
A successful check does not establish Reddit compatibility. The user must take
private control before entering sensitive information in the native window;
OS-level interaction is outside Bud's input admission boundary.

No service, protocol or migration change. Rebuild and restart the daemon with the
new environment option; restart closes existing ephemeral browser sessions.

## Validation
Regular Chrome 152.0.7977.83 passed the live adapter test: visible launch,
Playwright-backed compact snapshot, `navigator.webdriver === false` after helper
attachment/observation, screenshot capture, and owned-child close. `cargo check`
passed. This was a synthetic data page, not a Reddit challenge test.

Run from `bud/` after stopping the current foreground daemon:

```sh
BUD_BROWSER_HEADED=1 \
BUD_BROWSER_EXECUTABLE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
cargo run -- --terminal-enabled
```

Open a fresh browser session. Take control in Bud before interacting in the visible
window, then explicitly return to the agent through Bud.
