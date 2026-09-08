# Debug: ngrok restart host header

Restart command: `ngrok http https://localhost:3443 --url=https://b21325f57611.ngrok.app`.
Then `node /tmp/bud-ngrok-local-https.mjs start`.
Launcher OAuth JSON probe failed twice with `SyntaxError: Unexpected end of JSON input`, then stopped children.
Caddy routes match localhost:3443, while the restarted tunnel preserved the public hostname.
Restore the tunnel's localhost Host override and rerun the same launcher/probe.
Logs: /tmp/bud-https-resume.log and /tmp/bud-https-resume-retry.log.

Resolved: restarted tunnel with `--host-header=localhost:3443`. Launcher OAuth/JWKS
probe passed and local readiness/public issuer checks passed at 2026-09-07 20:48:41 UTC.
