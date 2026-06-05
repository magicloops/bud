# Debug: get.bud.dev Stale Stable Manifest Smoke

## Environment

- GitHub Actions workflow: `Promote get.bud.dev`
- Failed promotion smoke version: `v0.0.1-install-canary.7`
- Observed date: 2026-06-01
- Cloudflare Worker: `get-bud-dev`

## Repro Steps

1. Promote `v0.0.1-install-canary.7`.
2. Let Wrangler deploy complete.
3. Run the post-deploy smoke step.

## Observed

The smoke step fetched `/releases/stable/manifest.json` and got the previously
promoted version:

```text
Error: expected v0.0.1-install-canary.7, got v0.0.1-install-canary.6
```

The response headers showed:

```text
cf-cache-status: HIT
cache-control: public, max-age=0, must-revalidate
content-type: application/json
```

Those headers match Cloudflare Workers static asset serving, not the Worker
script response shape.

After enabling Worker-first routing, a second smoke failure happened while
checking the root installer alias:

```text
curl -fsSL https://get.bud.dev | head -n 1 | grep -Fx '#!/bin/sh'
#!/bin/sh
curl: (23) Failed writing body
```

That was a smoke-test bug: `head -n 1` closes the pipe after the first line, so
`curl` sees a broken pipe and exits `23`. Because the job uses `set -o
pipefail`, the pipeline fails even though the first line matched.

## Expected

Promotion smoke should read the just-promoted stable manifest from the Worker
script and confirm it matches the workflow input version.

## Hypotheses

- Static assets were served before the Worker script because
  `assets.run_worker_first` was not enabled.
- Cloudflare's static asset cache returned the previous
  `/releases/stable/manifest.json` asset during the post-deploy smoke.
- Mutable installer and stable-manifest routes should run through the Worker
  script so route aliases, headers, and smoke behavior are deterministic.

## Proposed Fix

- Set `run_worker_first = true` under `[assets]` in
  `deploy/get-bud-dev/wrangler.toml`.
- Make mutable Worker responses for `/`, `/install.sh`, and
  `/releases/stable/manifest.json` use `Cache-Control: no-store`.
- Expand promotion smoke to validate the root installer alias and use the
  Worker-controlled stable manifest response.
- Download the root installer alias to a temp file before checking the first
  line so `head` cannot trigger a broken-pipe `curl` failure.

Spec files affected:

- `deploy/get-bud-dev/get-bud-dev.spec.md`
- `.github/workflows/workflows.spec.md`
