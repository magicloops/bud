# Debug: Bud Daemon Local HTTPS Mkcert Unknown Issuer

## Environment

- Local HTTPS profile from `plan/web-proxy/phase-8-local-https-dev.md`
- Caddy serves `https://localhost:3443` with mkcert-generated certs from
  `.certs/`
- Bud daemon connects with `BUD_SERVER_URL=wss://localhost:3443/ws`

## Repro Steps

1. Install/trust mkcert locally.
2. Generate `.certs/bud-local.pem` and `.certs/bud-local-key.pem`.
3. Start Caddy with `dev/caddy/Caddyfile.https-local`.
4. Start the daemon against `wss://localhost:3443/ws`.

## Observed

The daemon fails before handshake:

```text
Session failed; retrying error=failed to connect to wss://localhost:3443/ws

Caused by:
    0: IO error: invalid peer certificate: UnknownIssuer
    1: invalid peer certificate: UnknownIssuer
```

## Expected

The daemon should trust the mkcert local CA after `mkcert -install`, matching
Chrome and curl behavior on the same machine.

## Findings

- `bud/Cargo.toml` enables `tokio-tungstenite` with
  `rustls-tls-webpki-roots`.
- `bud/Cargo.toml` enables `reqwest` with `rustls-tls`, which maps to
  `rustls-tls-webpki-roots` in reqwest 0.12.
- WebPKI roots do not include the developer's local mkcert CA from the macOS
  system trust store.
- The WebSocket control path fails first for an already claimed daemon.
- The device-claim HTTP path would hit the same issue on a fresh daemon because
  it also uses Rustls WebPKI roots.

## Hypothesis

The daemon must use native OS roots for Rustls-backed HTTP and WebSocket
clients so local mkcert certificates are trusted after `mkcert -install`.

## Proposed Fix

- Switch `reqwest` from `rustls-tls` to `rustls-tls-native-roots`.
- Switch `tokio-tungstenite` from `rustls-tls-webpki-roots` to
  `rustls-tls-native-roots`.
- Keep the default HTTPS certificate validation behavior; do not add an
  insecure local-only bypass.

## Spec Files Affected

- `bud/src/src.spec.md`
- `bud/bud.spec.md`
