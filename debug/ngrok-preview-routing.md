# Debug: Local previews do not follow the ngrok app origin

## Environment
September 7, 2026, macOS local service :3000, Vite [::1]:5173, Caddy :3443.
ngrok b21325f57611.ngrok.app forwards to https://localhost:3443 with a
localhost:3443 Host override. Contact dashboard listens on 127.0.0.1:5173.

## Observed
- Public ngrok app root returns 200. Dashboard IPv4 root and Bud IPv6 root both
  return 200; they are separate servers sharing a port across address families.
- Temporary launcher changes HTTPS_ORIGIN to ngrok but retains
  PROXY_BASE_DOMAIN=bud-show.test and PROXY_PUBLIC_PORT=3443.
- Most recently updated proxied_site (21:44 UTC) stores endpoint host
  localhost-5173-3k42y0.proxy.localhost, target 127.0.0.1:5173.
- HTTPS to that legacy endpoint at :3443 fails TLS. Direct service request with
  that Host returns 404. Caddy cert/site blocks cover bud-show.test and
  bud-proxy.localhost, not proxy.localhost; service matches only current base.
- createOrReuseProxiedSite filters owner/Bud/target/path but not current endpoint
  domain, so it renews an old incompatible endpoint unchanged.
- proxiedSiteViewUrl/createViewerGrant combine persisted endpoint_host with
  current scheme/port, producing a hybrid origin after configuration changes.
- There is only one configured ngrok tunnel, for the main application. Preview
  hosts have separate origin routing and are not carried by that tunnel.

An initial metadata query included nonexistent proxied_site.status and failed
with PostgreSQL 42703. Corrected query used endpoint_host, target_host,
target_port, updated_at; no credentials or contact contents were inspected.

## Implications and proposed fix
There are two independent issues: stale persisted preview domains, and lack of a
public preview-domain route. A fresh current-domain site can address Mac-local
routing but does not make .test reachable on a remote phone.

Choose an explicit public development preview origin/domain route, preserving
per-app origin isolation and existing viewer authentication, before changing
URLs. Then handle stored endpoints across domain changes (including attached
sites and app-permission destination binding) rather than only creation.
Do not simply put arbitrary generated app content under Bud's authenticated
ngrok origin or trust arbitrary forwarded Host headers.

No user sites, viewer grants, keys, or deployments changed. The exact user-visible
failure URL/client is requested separately to correlate this evidence.

## Authorized local repair
User requested fixing the stale hostname to bud-show.test before public preview
routing. Updated site_01KRGZR42BKT5DE6X4ZRWZ9TG4 on bud-dev to
localhost-5173-3k42y0.bud-show.test. The update matched the exact old host, site ID,
Bud ID and equal site/Bud owner; exactly one row changed. Site ID, target,
attachments and permissions were preserved. This site had zero app data access
requests. No service code or schema changed.

The first attempt to append this note used a repo-relative path from service/
and failed; the database update succeeded. This corrected note records the result.
