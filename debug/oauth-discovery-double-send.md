# Debug: OAuth discovery double-send during dev startup

## Environment and reproduction

- macOS, Node.js 22.14.0, Fastify 4.29.1.
- Run `BUD_BROWSER_STREAMING_EXPERIMENT=1 BUD_DEV_NGROK_URL=https://b21325f57611.ngrok.app pnpm dev:ngrok`.
- The launcher requests protected-resource metadata, then OpenID metadata and JWKS.
- Metadata reproduction needs no database queries or LLM calls.

## Observed

The first metadata request returns 200, followed by `Reply was already sent` and
`Error [ERR_HTTP_HEADERS_SENT]: Cannot write headers after they are sent to the client`.
The stack includes the access-log `writeHead` wrapper and Fastify's `onSendEnd`.
The service exits; the next discovery request receives HTTP 502 from Caddy.

## Expected

Each discovery request sends one response and startup verification completes.

## Hypothesis and proposed fix

The new async serialization/send instrumentation yields even though its work is
synchronous. Auth handlers send replies without waiting for response completion;
Fastify can resolve their promises while those hooks are pending and send again.
Keep synchronous instrumentation synchronous and make auth handlers wait for their
replies, including when other asynchronous response hooks are installed.
Add regression coverage composing access logging with the real discovery routes
and exercising delayed response hooks. Update the source and auth folder specs.

## Reproduction confirmed

`pnpm exec node --import tsx --test src/access-log.test.ts src/auth/auth.test.ts`
(from `service/`) initially failed both new regression tests with
`ERR_HTTP_HEADERS_SENT: Cannot write headers after they are sent to the client`,
matching the reported stack through `access-log.ts`, `onSendEnd` and `handleResolve`.
The seven existing tests passed, confirming the missing composition coverage.

## Fix and validation

Serialization/send instrumentation now completes synchronously. Auth response
forwarding awaits Fastify reply completion; metadata and error handlers return
their replies. All nine focused tests now pass, including delayed-hook coverage
for all three metadata routes and forwarded auth success/failure responses.

- `pnpm build` in `service/`: passed.
- `pnpm exec eslint src/access-log.ts src/access-log.test.ts src/auth/auth.ts src/auth/auth.test.ts`:
  no errors; two existing exported-function return-type warnings.
- `git diff --check`: passed.

The full ngrok/Caddy startup sequence was not rerun; validation used isolated
Fastify requests and did not modify the running development environment.
