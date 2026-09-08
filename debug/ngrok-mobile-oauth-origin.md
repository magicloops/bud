# Debug: Physical mobile OAuth through ngrok

The Debug iPhone build uses `https://b21325f57611.ngrok.app` for app origin,
ingestion, issuer (`/api/auth`) and audience (`/api`). Xcode command-line
overrides keep the temporary tunnel out of checked-in mobile configuration.

Discovery through ngrok initially returned issuer and authorization/token URLs
at `https://localhost:3443/api/auth`. Updating upstream social-provider callbacks
alone does not change these service-derived values; the phone cannot reach them.

For this manual test session, use a temporary copy of `dev/local-https.mjs` at
`/tmp/bud-ngrok-local-https.mjs`, with the original repository root explicitly set
and its HTTPS_ORIGIN set to the tunnel. This preserves the existing managed
service/web/Caddy lifecycle and local TLS trust while deriving public OAuth URLs.
Restart the local launcher, then verify discovery and protected-resource metadata
through ngrok. No production configuration changes are required.

Build log: `/tmp/bud-ngrok-device-build.log`.
Launcher log: `/tmp/bud-ngrok-local-https.log`.

Verified: device build succeeded and installed as `chat.bud.app.local`.
The built Info.plist contains the ngrok app/ingest origins, issuer and audience.
The restarted launcher's OAuth/JWKS probe passed, and separate public discovery
and protected-resource requests returned matching ngrok URLs. Human sign-in and
live ingestion remain manual acceptance steps.
