# Debug: Personal-data worker shutdown

## Environment and reproduction
Local PostgreSQL, `pnpm --dir service exec node --import tsx --test src/server.test.ts`.

## Observed
The test passes but logs `Contact processing failed; durable work retained for retry`
after the terminal idle monitor stops. Fastify runs `onClose` hooks in reverse
registration order: the composition root closes the pool before the previously
registered contact worker's drain hook runs.

## Expected
Background database work finishes before the database pool closes.

## Proposed fix
Drain contact processing in `preClose`, before connection/pool finalizers. Inject
the processor in a focused lifecycle test and hold a processing operation open
while closing Fastify; assert that the pool-finalizer stand-in waits for it.

## Fix and validation
Moving the drain to `preClose` passed the isolated lifecycle fixture but did not
remove the warning from real server composition. Registering finalizers before
plugin boot also proved insufficient. The final composition explicitly awaits
the personal-data `stop` handle and invocation worker before closing gateways and
pools, with idempotent early drains retained. The subsequent real server test
passes without the warning. This avoids relying on implicit hook ordering.
