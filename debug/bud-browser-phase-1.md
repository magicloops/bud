# Debug: Phase 1 browser runtime integration

Environment: local macOS development; Rust daemon, Node service, PostgreSQL.

`pnpm build` in `service/` initially failed with
`TS2339: Property 'browser' does not exist` in the WS and gRPC gateways.
The shared hello schema deliberately selects known capabilities. Added the
optional browser capability to both parsing and transformation; old peers still
omit it. This also prevents silently dropping the advertised runtime readiness.

Validation and subsequent findings are recorded in the Phase 1 plan.

Further validation findings:
- `pnpm build` exposed a transport-test fixture missing `lastHeartbeat`; the fixture now supplies it.
- `pnpm exec node --import tsx --test src/ws/gateway.test.ts src/proto/wire.test.ts src/grpc/envelope-codec.test.ts src/grpc/control-gateway.test.ts src/agent/invocation-worker.test.ts` initially failed the unknown-payload test: expected `UnsupportedBudEnvelopePayloadError`, received `typed protobuf payload missing frame_json bytes`. Its formerly unknown tag 190 is now BrowserCommand; moved the fixture to unassigned tag 192.
- `pnpm db:push` proposed an unrelated `agent_invocation` dedupe constraint change and offered truncation of 127 rows. Canceled that prompt without changing existing data. Applied only the reviewed additive migration `0039_tiny_loners.sql` transactionally to the verified localhost database; isolated PostgreSQL migration/repository tests validate it independently. No production migration ran.
