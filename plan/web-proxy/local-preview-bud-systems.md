# Local previews on bud.systems

## Objective
Expose local Bud-generated app previews at
https://<site>.bud.systems through a named Cloudflare Tunnel.
Keep the current ngrok Bud app/API/OAuth origin. This uses a separate zone from
bud.show and its existing Worker.

## Routing and ownership
Browser → Cloudflare TLS → outbound cloudflared tunnel on the Mac →
http://127.0.0.1:3000 → Bud proxy gateway → owned Bud → target application.

Preserve the incoming Host, so existing gateway endpoint lookup and one-time
viewer grant / host-only viewer cookie authentication apply. Do not replace Host
with localhost and do not send preview traffic directly to the target app port.
No Worker is required. Do not add preview domains to Better Auth trusted origins.
Configure cache bypass for these development hosts. Validate WebSockets and SSE
through the full path. No new application tables or schema changes are required.

## DNS and TLS
The bud.systems zone must be active in Cloudflare. A proxied wildcard CNAME named
* points to <TUNNEL_UUID>.cfargotunnel.com. Standard Universal SSL covers
bud.systems and *.bud.systems; wait for its certificate to become active before
cutover. No Advanced Certificate Manager add-on is needed for this layout.
The apex is not an app preview and falls through to the tunnel's 404 rule.

## Prepared template and setup
Template: ../../dev/cloudflared/config.local-preview.example.yml.
No local ~/.cloudflared credentials were found on September 7, 2026.
Setup sequence:

1. Install cloudflared and authenticate with `cloudflared tunnel login`.
2. Create a named tunnel: `cloudflared tunnel create bud-local-preview`.
3. Copy the template to ~/.cloudflared/bud-local-preview.yml; replace its UUID
   and credentials-file placeholders. Never check the JSON credential into git.
4. Create DNS via `cloudflared tunnel route dns bud-local-preview '*.bud.systems'`.
5. Validate: `cloudflared tunnel --config ~/.cloudflared/bud-local-preview.yml ingress validate`.
6. Run: `cloudflared tunnel --config ~/.cloudflared/bud-local-preview.yml run bud-local-preview`.

## Service integration before cutover
Use:
```
PROXY_BASE_DOMAIN=bud.systems
PROXY_PUBLIC_SCHEME=https
PROXY_PUBLIC_PORT=
PROXY_VIEWER_COOKIE_NAME=__Host-bud_proxy_viewer
```
The checked-in launcher now supports explicit shell overrides. At cutover, use:
```
BUD_DEV_HTTPS_ORIGIN=https://b21325f57611.ngrok.app \
BUD_DEV_PROXY_BASE_DOMAIN=bud.systems BUD_DEV_PROXY_PUBLIC_PORT= \
node dev/local-https.mjs start
```
These are launcher environment variables, not service/.env settings. The local
Caddy certificates and .test DNS remain the default underlying HTTPS profile.
The temporary ngrok launcher need not be maintained after switching to this.
Existing sites persist their endpoint_host: migrate only selected, owned local
dev sites, retaining site IDs, attachments and permission/key destination identity.
Review any destination metadata binding and invalidate/review stale pending
permission proposals as needed. Do not silently broaden approved access.

## Acceptance
- TLS valid on a synthetic wildcard hostname from a public network.
- Existing authenticated preview loads on Mac and iPhone, including assets/HMR.
- Anonymous/foreign viewers denied; no auth bypass or raw credentials in URLs/logs.
- Unknown hosts rejected, application origin remains on ngrok.
- Selected site identity and app-key bindings preserved across hostname change.

## Status
Tunnel and DNS are live; local service now advertises bud.systems previews.
Public TLS and unauthenticated viewer rejection pass. Authenticated browser/mobile
loading and assets/HMR remain to validate. User confirmed cache bypass was deployed.

References:
- https://developers.cloudflare.com/tunnel/advanced/local-management/configuration-file/
- https://developers.cloudflare.com/ssl/edge-certificates/advanced-certificate-manager/
- https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/

## September 7 setup progress
- Selected first-level *.bud.systems layout; no paid certificate add-on.
- Installed cloudflared 2026.8.3. Zone NS resolves to Cloudflare.
- Template ingress validation passed; example app matches service:3000 and
  apex matches terminal 404.
- Launcher syntax and default/overridden print-env checks passed, including
  empty public port and preserved ngrok OAuth origin.
- Started cloudflared tunnel login; browser authorization is pending.
- No named tunnel/DNS record created and no running-service or site cutover yet.


## September 7 cutover
Created tunnel bud-local-preview, ID 2eaa069a-14b1-4716-8de8-271e047b39dd.
Private config: ~/.cloudflared/bud-local-preview.yml. Running tunnel log:
/tmp/bud-cloudflared-preview.log. Replaced wildcard parking CNAME pixie.porkbun.com
with this tunnel. Initial HTTP525 resolved after DNS propagation; TLS now passes.

Restarted checked-in launcher with documented overrides (no running/leased
invocations before restart). Log: /tmp/bud-cloudflare-local-https.log. OAuth/JWKS
probe passed with unchanged ngrok origin. Service /readyz passed directly on
port 3000; /readyz through Caddy currently falls through to Vite HTML and is not
a valid service readiness probe.

Migrated only site_01M1YY2GK1TMCYNPKC604ECHBT (neo-contacts on 5174) to
neo-contacts-kxe4hc.bud.systems under owner/Bud/old-host predicates. Site ID and
app data permission binding remain unchanged. Public unauthenticated request
returns 401 proxy_viewer_unauthorized with CF-Cache-Status DYNAMIC.

Cloudflared login credential cannot read Rulesets (HTTP403/code10000). User
confirmed deployment of the hostname cache-bypass rule. Subsequent public probe
returned uncached 401 (CF-Cache-Status DYNAMIC), and local dashboard returned 200.
This probe does not independently verify cache behavior for authenticated assets.
Full authenticated preview and WebSocket/HMR checks remain manual. Old unrelated
local sites are unmigrated.
