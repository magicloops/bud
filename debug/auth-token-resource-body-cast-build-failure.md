# Debug: auth-token-resource-body-cast-build-failure

## Environment
- Local macOS development
- Service TypeScript build via `pnpm --dir /Users/adam/bud/service build`
- Better Auth mounted through the Fastify bridge in `service/src/auth/auth.ts`

## Repro Steps
1. Run `pnpm --dir /Users/adam/bud/service build`.
2. Let `tsc --project tsconfig.json` compile the service package.
3. Observe the compile failure in `service/src/auth/auth.ts`.

## Observed
- The build fails with `TS2352` at `service/src/auth/auth.ts:235`.
- Exact error:

```text
src/auth/auth.ts(235,47): error TS2352: Conversion of type 'ReadableStream<any> | Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer> | FormData' to type 'Record<string, unknown>' may be a mistake because neither type sufficiently overlaps with the other. If this was intentional, convert the expression to 'unknown' first.
  Type 'FormData' is not comparable to type 'Record<string, unknown>'.
    Index signature for type 'string' is missing in type 'FormData'.
```

## Expected
- The service should compile cleanly.
- The Better Auth request adapter should only parse request-body shapes it actually expects to receive.

## Findings
- The failing code lives in `injectDefaultTokenResource(...)`, which currently accepts `body: BodyInit | undefined`.
- The failing branch tries to treat arbitrary object-shaped `BodyInit` values as `Record<string, unknown>` so it can rebuild a `URLSearchParams` instance before adding the default `resource` parameter.
- In the actual call flow, `injectDefaultTokenResource(...)` is only called from `toWebRequest(...)`.
- `toWebRequest(...)` always runs `buildAuthBody(...)` before calling `injectDefaultTokenResource(...)`.
- `buildAuthBody(...)` already normalizes form bodies:
  - string bodies stay strings
  - `URLSearchParams` stays `URLSearchParams`
  - plain object form bodies are converted to `URLSearchParams`
  - non-form bodies are converted to JSON strings or binary buffers
- That means the object-cast branch inside `injectDefaultTokenResource(...)` appears to be dead for the current implementation path. By the time the helper runs, form data should already be a string or `URLSearchParams`, not a plain object.
- The compile failure is therefore not pointing to a real runtime bug in the token-resource injection logic. It is exposing a mismatch between the helper's broad `BodyInit` type and the narrower body shapes our adapter actually passes in practice.
- This blocker is inside the auth bridge, not the transcript/tool-payload Phase 5 work that triggered the latest validation pass.

## Hypotheses
- Primary hypothesis: the clean fix is to narrow `injectDefaultTokenResource(...)` to the normalized body shapes produced by `buildAuthBody(...)` for form-encoded token requests, instead of trying to support every `BodyInit` variant.
- Secondary hypothesis: the current object branch was added defensively during earlier auth bring-up, but is now redundant after `buildAuthBody(...)` took over normalization.
- Lower-confidence fallback: an `unknown` cast or extra runtime guards could silence TypeScript, but that would preserve dead or misleading code and would not improve the adapter contract.

## Proposed Fix
- Refactor `injectDefaultTokenResource(...)` so it only reparses bodies it can safely understand:
  - `string`
  - `URLSearchParams`
- For any other `BodyInit` variant, leave the body unchanged and skip default-resource injection.
- Keep `buildAuthBody(...)` as the single normalization layer for raw Fastify request bodies.
- Re-run `pnpm --dir /Users/adam/bud/service build` after the refactor.

## Open Questions
- Do we want `injectDefaultTokenResource(...)` to be a general-purpose BodyInit mutator, or should it explicitly document that it only operates on normalized form bodies from `buildAuthBody(...)`?
- If we ever need to support native `FormData` token requests through this bridge, should that happen here, or should `buildAuthBody(...)` own that conversion as well?

## Spec Files Affected
- `bud.spec.md`
- `service/src/auth/auth.spec.md`
