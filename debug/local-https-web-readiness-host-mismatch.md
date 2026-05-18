# Debug: Local HTTPS Web Readiness Host Mismatch

## Environment

- OS / arch / versions: macOS local development, Homebrew Caddy + mkcert profile.
- DB connection style: unchanged from normal service development.
- LLM mode: not relevant.

## Repro Steps

1. Configure and start the local HTTPS profile with `pnpm dev:https`.
2. Observe that the site is reachable through Caddy at `https://localhost:3443`.
3. Wait for launcher readiness to complete.

## Observed

The launcher reports the web child as unreachable and then shuts down the whole
owned profile:

```text
[dev:https] web did not become reachable at 127.0.0.1:5173
[dev:https] Stopping local HTTPS profile.
[caddy] shutting down apps, then terminating
[caddy] exiting
[web] ELIFECYCLE Command failed with exit code 143.
```

`https://localhost:3443` remains the correct browser entrypoint before the
launcher stops the children.

## Expected

If Caddy can serve the web app through `https://localhost:3443`, the launcher
should treat the web child as ready and continue to the HTTPS OAuth/JWKS probe.

## Hypotheses

- Strongest: the readiness probe checked `127.0.0.1:5173`, but Caddy proxies
  app routes to `localhost:5173`. Vite can be reachable at `localhost` while
  not accepting the exact IPv4 loopback probe used by the launcher.
- The Caddy `SIGTERM` and web exit code `143` are downstream effects of the
  launcher cleanup path, not independent process failures.
- The service probe should remain on `127.0.0.1:3000` because the service child
  is explicitly started with `HOST=127.0.0.1`.

## Proposed Fix

- Define explicit local profile host/port constants in `dev/local-https.mjs`.
- Keep service readiness on `127.0.0.1:3000`.
- Probe web readiness at `localhost:5173`, matching the Caddy upstream.
- Keep Caddy readiness at `localhost:3443`.
- Update local HTTPS docs and plan checklists so the expected web readiness
  target is `localhost:5173`.
- Spec files affected: `dev/dev.spec.md`, `dev/caddy/caddy.spec.md`,
  `bud.spec.md`.
