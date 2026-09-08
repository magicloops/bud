# Debug: Shared ACK fixture omitted response fields

From `service/`, `pnpm exec node --import tsx --test src/personal-data/wire-contract.test.ts`
failed its HTTP ACK comparison. Actual response additionally contained
`request_id: 'req-1'` and `retry_after_s: 0`. The fixture omitted those fields.

Include the existing public response fields in the shared fixture and update its
reviewed digest in both test suites. This is a fixture correction, not a change
to the HTTP response or mobile deletion rules. Verify the real Fastify response
and Swift decoder against identical fixture bytes.
