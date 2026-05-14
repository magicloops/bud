# Phase 4a: HTTP Methods, Request Bodies, And Cancellation

## Objective

Unblock normal local-app mutation APIs through the existing private proxied-site
gateway without taking on the full Phase 4 cookie and redirect surface.

## Scope

- Expand HTTP proxy methods to `GET`, `HEAD`, `POST`, `PUT`, `PATCH`,
  `DELETE`, and `OPTIONS`.
- Buffer browser request bodies at the service edge under a configured cap.
- Forward request bodies from service to daemon as generic `stream_data` frames
  after `proxy_open`.
- Add daemon request-body assembly before opening the local loopback request.
- Propagate browser disconnects as `stream_reset` so daemon local requests stop.
- Preserve safe request headers needed for bodies, especially `Content-Type`.

## Non-Goals

- No local-app cookie forwarding or `Set-Cookie` rewriting yet.
- No redirect `Location` rewriting yet.
- No unbounded or streaming uploads.
- No arbitrary non-loopback targets.

## Design

`proxy_open` gains `request_body_bytes`. When this value is greater than zero,
the daemon waits for exactly that many bytes on the same stream id before
sending the loopback request. The service sends the buffered body in
`stream_data` chunks over the selected data-plane carrier and then waits for
`proxy_open_result`.

The body remains bounded and never goes through logs or audit payloads. The
service rejects bodies over the configured cap with `413`, and the daemon also
rejects oversized or malformed body streams before opening the local target.

This keeps the HTTP proxy model close to the existing file/proxy stream
machinery while avoiding a separate upload protocol. A later Phase 4 sub-phase
can move large uploads to credit-driven streaming if product needs exceed the
bounded-buffer path.

## Follow-Up Work

- Phase 4b: endpoint-host local-app cookies and reserved cookie protection.
- Phase 4c: redirect rewriting and broader response-header policy.
- Phase 4d: larger streaming uploads if the buffered cap becomes limiting.

## Test Plan

- Service unit tests for body extraction and method expansion.
- Daemon unit tests for allowed method validation and request body decoding.
- Focused TypeScript/Rust checks for the touched proxy paths.
- Manual validation with a local app that performs JSON `POST`/`PATCH`
  requests through a proxied site.
