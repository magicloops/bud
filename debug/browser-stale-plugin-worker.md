# Debug: Browser worker retains a removed plugin version

## Environment
September 7, 2026, macOS, Codex browser plugin.
Installed plugin: `26.820.60940`; previous catalog path `26.810.50856` is absent.

## Reproduction
Read the installed Browser skill and invoke its documented setup through the
JavaScript tool, importing the installed version's `scripts/browser-client.mjs`.

## Observed
`Cannot find module '/Users/adam/.codex/plugins/cache/openai-bundled/browser/26.814.41407/scripts/browser-service.mjs' imported from /private/var/folders/_n/tdtkt70j47qgsv8_3yq9vmj80000gn/T/.tmpiiTJto/trusted-worker.js`

The current installation contains browser-service.mjs. A supported JavaScript
kernel reset succeeded, but setup afterward produced the identical missing-module
error referencing the same trusted-worker path. No browser connection or page
access was established. This replaces the earlier node:process import failure.

## Diagnosis and next step
The host's trusted browser worker retains a stale service-module path across a
JavaScript kernel reset. Restart the hosting Codex app to rebuild its tool runtime
against the current plugin installation, then retry documented browser setup.
This recovery is not yet verified. Do not patch the generated trusted worker or
alias different plugin versions together. No Bud source changes are needed for
this startup failure; restarting Bud's backend does not reset the Codex tool host.

## After host update and restart
The user quit, updated and reopened Codex. Documented runtime setup now succeeds:
the stale-module failure is resolved. Selecting for `https://localhost:3443`
returns `No browser is available`. Following bootstrap troubleshooting,
`agent.browsers.list()` returns `[]`. No connected browser exists in this session;
page interaction remains unverified. No plugin files were modified.
