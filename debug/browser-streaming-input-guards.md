# Debug: streaming input evidence

The current adapter retains one screenshot viewport token; non-wheel input must
match that latest token and be younger than three seconds. A continuous source
would replace evidence more quickly than a displayed-frame click round trip.

Keep bounded evidence for recently delivered frames within one active immutable
source generation. Verify current document/layout and existing focus/controller
guards at input time. Retire all evidence on generation invalidation, and never
retry an uncertain action. Validate through real adapter input before WSS wiring.

See [implementation plan](../plan/browser-streaming/input-and-wss-integration.md).

## Validation notes

`pnpm exec tsc -b` in web initially rejected constructor parameter properties
with TS1294 (`erasableSyntaxOnly`). Replaced them with explicit typed fields.
An initial test-file write used repo-relative paths from web and failed with
FileNotFoundError; rerun from the repository root before package-local tests.

The first `pnpm --dir service exec tsx --test src/browser/stream-wss.test.ts`
failed with `feedback timeout`; TLS reported `unable to verify the first
certificate`. The local mkcert leaf is not its issuing CA. The opt-in fixture
now requires BUD_STREAM_TEST_CA pointing to the public mkcert root certificate;
certificate verification remains enabled.

## Final integration evidence

The real-Chrome guard fixture passes retained displayed-frame click/text, idle
refresh after four seconds, navigation retirement, new resized geometry and
Return waiting for source/focus cleanup. It uses a disposable headless profile.
TLS relay fixture passes with the public mkcert root CA explicitly supplied;
it does not disable verification or exercise live database/account authorization.
Default daemon browser tests: 95 passed, 7 opt-in ignored. Focused service tests:
30 passed. Canvas/queue: 8 passed. Mounted web/mobile viewer: 15 passed. Both
TypeScript checks pass. No live daemon/service restart or deployment performed.

The continuous decoder exposed a client assumption: queued clicks/text required
exact equality with the newest displayed token. New frames could cancel typing.
Streaming frames now carry an internal generation marker; the queue accepts only
same-generation/same-viewport receipts and sends the **original** displayed token.
Daemon age/layout/focus checks remain authoritative. A local target-selection
fence also prevents old arriving or already decoding frames from repainting.

Full-stack headed/WSS/actual-canvas, physical phone/ngrok and latency measurements
remain open. Idle refresh and one-second feedback deadlines need measurement;
component tests do not establish smooth scrolling or the latency acceptance bars.
