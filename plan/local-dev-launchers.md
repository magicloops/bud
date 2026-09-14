# Plan: explicit local development launchers

Provide `pnpm dev` (HTTP localhost:5173), `pnpm dev:https` (HTTPS localhost:3443),
and `pnpm dev:ngrok` (configured public HTTPS origin). Each sets matching app,
auth and API audience values without editing service secrets. HTTPS presets reuse
local-https.mjs for mkcert, Caddy, readiness and shutdown. Normal HTTP needs no
Caddy/mkcert. Optional ignored dev/.env.local stores the ngrok URL and preview
settings; shell values take precedence. Ngrok reuses a matching existing tunnel,
or starts its own; it never stops an independently managed tunnel.

Refuse occupied app ports before starting, rather than silently selecting new
ports or replacing another dev process. Stop one launcher before switching.
No automatic daemon/iOS provisioning, OAuth provider edits, cloudflared changes,
DB migration, or production configuration changes.

Update README, dev/dev.spec.md and root script documentation. Validate preset
environments, syntax, conflict handling, and live localhost OAuth discovery.

## Implemented and validated

- Three root commands implemented through dev/local-dev.mjs; existing HTTPS
  setup/check/provision commands remain available.
- Three preset tests pass (`node --test dev/local-dev.test.mjs`); syntax and
  whitespace checks pass. Occupied-port refusal verified against the running stack.
- Started/stopped HTTP and verified localhost:5173 OIDC issuer.
- Started/stopped ngrok mode, verified public OAuth/JWKS readiness and reuse of
  the existing tunnel without stopping it.
- Left `pnpm dev:https` running; localhost:3443 OAuth/JWKS check passes.
- Current ngrok URL and bud.systems preview settings saved in ignored dev/.env.local.
  Independent ngrok and cloudflared remain running. New-tunnel creation was not
  exercised because the existing tunnel was reused; full OAuth browser sign-in
  remains a manual check.
