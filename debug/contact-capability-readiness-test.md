# Debug: Contacts capability readiness assertion

## Environment and reproduction

Local service TypeScript build: `cd /Users/adam/bud/service && pnpm build`.
Eight focused runtime tests pass, but compilation rejects the Fastify thenable
passed directly to Node assert.rejects.

## Observed

```text

> @bud/service@0.0.1 build /Users/adam/bud/service
> tsc --project tsconfig.json

src/personal-data/routes.test.ts(183,24): error TS2769: No overload matches this call.
  Overload 1 of 2, '(block: Promise<unknown> | (() => Promise<unknown>), message?: string | Error | undefined): Promise<void>', gave the following error.
    Argument of type 'FastifyInstance<Server<typeof IncomingMessage, typeof ServerResponse>, IncomingMessage, ServerResponse<IncomingMessage>, FastifyBaseLogger, FastifyTypeProviderDefault> & PromiseLike<...>' is not assignable to parameter of type 'Promise<unknown> | (() => Promise<unknown>)'.
      Type 'FastifyInstance<Server<typeof IncomingMessage, typeof ServerResponse>, IncomingMessage, ServerResponse<IncomingMessage>, FastifyBaseLogger, FastifyTypeProviderDefault> & PromiseLike<...>' is missing the following properties from type 'Promise<unknown>': catch, finally, [Symbol.toStringTag]
  Overload 2 of 2, '(block: Promise<unknown> | (() => Promise<unknown>), error: AssertPredicate, message?: string | Error | undefined): Promise<void>', gave the following error.
    Argument of type 'FastifyInstance<Server<typeof IncomingMessage, typeof ServerResponse>, IncomingMessage, ServerResponse<IncomingMessage>, FastifyBaseLogger, FastifyTypeProviderDefault> & PromiseLike<...>' is not assignable to parameter of type 'Promise<unknown> | (() => Promise<unknown>)'.
      Type 'FastifyInstance<Server<typeof IncomingMessage, typeof ServerResponse>, IncomingMessage, ServerResponse<IncomingMessage>, FastifyBaseLogger, FastifyTypeProviderDefault> & PromiseLike<...>' is missing the following properties from type 'Promise<unknown>': catch, finally, [Symbol.toStringTag]
 ELIFECYCLE  Command failed with exit code 2.
```

## Proposed fix

Use an async assertion callback that awaits readiness and returns a real Promise.
This preserves the missing-schema rejection check. No runtime API change.
