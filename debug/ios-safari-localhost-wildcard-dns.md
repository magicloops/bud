# Debug: iOS Safari Localhost Wildcard DNS

## Environment

- Local HTTPS profile: Caddy + mkcert at `https://localhost:3443`
- Proxy endpoint host before the fix:
  `https://<slug>.bud-proxy.localhost:3443`
- Affected clients: iOS Simulator Safari and the Bud iOS WKWebView
- Working client: desktop Chrome

## Repro Steps

1. Start the local HTTPS profile.
2. Create or reuse a proxied site.
3. Open the generated `https://<slug>.bud-proxy.localhost:3443` URL in
   Chrome.
4. Open the same URL in iOS Simulator Safari or in the iOS app's WKWebView.

## Observed

- Chrome resolves the wildcard `.localhost` proxy endpoint host.
- iOS Simulator Safari/WKWebView does not reliably resolve wildcard
  subdomains under `localhost`.
- The failure happens before Caddy host routing, TLS certificate validation,
  or Bud gateway authorization can prove anything useful.

## Expected

The local proxy endpoint hostname should resolve consistently in desktop
browsers and in the iOS Simulator path used for mobile development.

## Hypotheses

- Literal `localhost` remains a good local app/API/auth origin.
- Browser-specific handling of `*.localhost` is not portable enough for
  generated proxy endpoint hosts.
- A reserved `.test` domain backed by explicit local DNS should remove the
  browser-specific wildcard `.localhost` dependency.

## Proposed Fix

- Keep app/API/auth/SSE/Bud WSS on `https://localhost:3443`.
- Move generated local HTTPS proxy endpoint hosts to
  `https://<slug>.bud-show.test:3443`.
- Require explicit local wildcard DNS:
  `*.bud-show.test -> 127.0.0.1`.
- Use dnsmasq as the documented macOS/Homebrew setup path, but keep repo
  scripts limited to validation and remediation output rather than writing
  `/etc/resolver` or Homebrew service files automatically.
- Regenerate local mkcert certs with `bud-show.test` and
  `*.bud-show.test` SANs.

## Spec Files Affected

- `dev/dev.spec.md`
- `dev/caddy/caddy.spec.md`
- `service/service.spec.md`
- `web/web.spec.md`
- `plan/web-proxy/web-proxy.spec.md`
- `plan/dev-https-setup-script/dev-https-setup-script.spec.md`
- `bud.spec.md`
