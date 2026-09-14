# Debug: local web OAuth origin

September 13, 2026. Browser testing at https://localhost:3443.

## Observed

The running `dev/local-https.mjs start` launcher had
`BUD_DEV_HTTPS_ORIGIN=https://b21325f57611.ngrok.app`, overriding the localhost
values in service/.env. OIDC discovery advertised the ngrok issuer and endpoints;
localhost:3443 was absent from its explicit trusted-origin list.

## Local web profile

Restart the launcher with:

```sh
BUD_DEV_HTTPS_ORIGIN=https://localhost:3443 \
BUD_DEV_PROXY_BASE_DOMAIN=bud.systems \
BUD_DEV_PROXY_PUBLIC_PORT= \
pnpm dev:https
```

Keep Cloudflare preview hosting on bud.systems and the independent ngrok tunnel.
For future mobile testing, restart this same command with
`BUD_DEV_HTTPS_ORIGIN=https://b21325f57611.ngrok.app` (or the current tunnel URL).
No secrets, OAuth provider registrations or mobile settings are changed.

## Validation

Check `pnpm dev:https:check` with localhost origin, plus generated social-login
redirect_uri. Full provider login still requires the browser session.

Verified after restart: web returns HTTP 200; HTTPS OAuth/JWKS check passes with
localhost resource and issuer; both Google and GitHub social-sign-in initiation
return redirect_uri `https://localhost:3443/api/auth/callback/<provider>`.
Ngrok and cloudflared processes remain running.

The first background `nohup` launch did not survive the command runner; its log
was empty, and `pnpm dev:https:check` reported `service did not become reachable
at 127.0.0.1:3000`. Relaunched in a persistent command session; checks above passed.
