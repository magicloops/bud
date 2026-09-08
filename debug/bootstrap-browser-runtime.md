# Debug: Browser validation runtime unavailable

## Environment and reproduction

Attempted local web automation interaction validation using the installed Browser skill and its `scripts/browser-client.mjs` runtime through the supported JavaScript tool.

## Observed

Runtime initialization failed: `Importing module "node:process" is not allowed in node_repl`.

## Impact

No browser was initialized and no UI interaction was performed. Web build validation passes separately; browser rendering, navigation, consent and account-switch verification remain open. Retry browser setup after the runtime/environment compatibility issue is resolved. No product code change is indicated by this tooling failure.

Rechecked during rollout inventory on September 4: fresh runtime had no browser
binding, and the supported bootstrap failed with the same error. Local service
and web listeners were present, so this does not indicate a product-server outage.
No substitute browser session or authenticated UI was claimed validated.

Rechecked September 6 after the expanded-field web build: bootstrap again failed
with the same module error before browser selection. No cookies, credentials or
UI state were inspected, and no browser interaction is claimed.

Desktop fallback was also checked through the installed Computer Use skill on
September 6. Initializing @oai/sky and requesting the iOS Simulator state failed
with `Sky Computer Use native pipe startup failed`. No desktop UI was inspected
or changed. The user was asked to reconnect/unlock the physical test iPhone.
