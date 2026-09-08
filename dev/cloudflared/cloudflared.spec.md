# cloudflared

Optional public local-development preview ingress through Cloudflare Tunnel.

## Files
- `config.local-preview.example.yml`: locally managed named-tunnel template for
  `*.bud.systems`, forwarding to the loopback service on port 3000
  with the original Host. Replace UUID/credential path in a private local copy.
  A terminal 404 rule rejects other hosts. Contains no credentials.

## Dependencies and status
Requires cloudflared, an active Cloudflare bud.systems zone, wildcard DNS and
an active standard Universal SSL certificate covering *.bud.systems. No tunnel is provisioned or
running by adding this template. Current Bud app/OAuth ngrok setup is unchanged.
The service must use this proxy base domain, HTTPS and public port 443 (empty
PROXY_PUBLIC_PORT). The HTTPS launcher accepts BUD_DEV_PROXY_BASE_DOMAIN and
BUD_DEV_PROXY_PUBLIC_PORT shell overrides, keeping local cert/DNS setup separate.

Setup and remaining integration: [runbook](../../plan/web-proxy/local-preview-bud-systems.md).
Parent: [dev](../dev.spec.md).
