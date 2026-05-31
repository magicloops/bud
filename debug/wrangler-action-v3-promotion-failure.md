# Debug: Wrangler Action v3 Promotion Failure

## Environment

- GitHub Actions workflow: `Promote get.bud.dev`
- Failing step: `Deploy Worker`
- Action version: `cloudflare/wrangler-action@v3`
- Logged Wrangler version: `3.90.0`
- Date: 2026-05-31

## Repro Steps

1. Run `Promote get.bud.dev` for `v0.0.1-install-canary.3`.
2. Let manifest download and Worker promotion asset generation complete.
3. Observe the `Deploy Worker` step.

## Observed

The action emitted the Node.js 20 deprecation warning and then failed while
running Wrangler:

```text
Run cloudflare/wrangler-action@v3
Checking for existing Wrangler installation
Installing Wrangler
/usr/local/bin/npx --no-install wrangler --version
3.90.0
Running Wrangler Commands
Error: The process '/usr/local/bin/npx' failed with exit code 1
```

The abbreviated GitHub log did not include a useful Wrangler stderr body.

## Expected

The promotion workflow should deploy `deploy/get-bud-dev/worker.js` with the
generated static assets and then run the smoke checks.

## Hypotheses

- `cloudflare/wrangler-action@v3` itself runs on Node.js 20.
- The action selected Wrangler `3.90.0` instead of current Wrangler v4.
- Current Worker static assets/deploy behavior should be tested with Wrangler
  v4, which Cloudflare documents as the current line for the action.

## Proposed Fix

- Upgrade to `cloudflare/wrangler-action@v4`.
- Explicitly set `wranglerVersion: "4"` so the action does not reuse or install
  Wrangler v3.

Spec files affected:

- `.github/workflows/workflows.spec.md`

