# Debug / setup: bud.systems local preview cutover

September 7, 2026. User authorized *.bud.systems Cloudflare Tunnel setup.
Created bud-local-preview (2eaa069a-14b1-4716-8de8-271e047b39dd); credentials
remain under ~/.cloudflared. Tunnel has four established outbound QUIC connections.
DNS creation initially failed code 1003 because wildcard already existed.
Authenticated read confirmed *.bud.systems CNAME pixie.porkbun.com (parking).
Replaced only that wildcard with the tunnel CNAME. Initial immediate smoke was
HTTP525 during propagation; subsequent synthetic host has valid TLS and reaches
local Fastify 404. No changes to bud.show or its Worker.

Next: restart managed HTTPS profile with bud.systems public proxy domain and no
public port. Zero executing/leased invocations observed before restart. Preserve
ngrok application/OAuth origin. Change only neo-contacts 5174 site endpoint;
permission destination binds site ID/public key, which remain unchanged.

Completed restart and selected site update. Public new hostname reaches viewer
401 over valid TLS; target returns 200. Cache Rules API denied cloudflared token
with HTTP403/code10000; dashboard configuration remains necessary. No token or
certificate contents logged. No existing viewer sessions extracted for testing.
