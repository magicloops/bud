# Debug: service-build-agent-type-regressions

## Environment

- Deploy failure reported from Render on April 17, 2026
- Service package build command: `pnpm install --frozen-lockfile && pnpm build`
- TypeScript compile target: `service/tsconfig.json`
- Affected code paths:
  - `service/src/agent/agent-service.ts`
  - `service/src/agent/thread-title-service.ts`

## Repro Steps

1. Run the service build in the `service/` package.
2. Let `tsc --project tsconfig.json` compile the agent sources.
3. Observe the TypeScript failures in the terminal-tool dispatcher and thread-title streaming collector.

## Observed

- Render reports two compile failures:

```text
src/agent/agent-service.ts(1160,60): error TS2339: Property 'tool' does not exist on type 'never'.
src/agent/thread-title-service.ts(221,49): error TS2339: Property 'text' does not exist on type 'CanonicalContentBlock'.
  Property 'text' does not exist on type '{ type: "image"; source: { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string; }; }'.
```

## Expected

- The service should compile cleanly in both local and deploy builds.
- Agent code should model terminal-tool exhaustiveness and streamed content accumulation in a way TypeScript can prove safe.

## Findings

- `executeTerminalCall(...)` receives `Extract<AgentDirective, { type: "tool_call"; tool: string }>` which narrows to the two supported terminal tools.
- The method already fully handles both union members with explicit `if (directive.tool === "terminal.observe")` and `if (directive.tool === "terminal.send")` branches.
- The trailing `throw new Error(\`unsupported_terminal_tool:${directive.tool}\`)` sits in unreachable code from TypeScript's perspective, so `directive` becomes `never` and `.tool` is rejected.
- This is a type-level exhaustiveness issue, not a runtime support gap.
- `ThreadTitleService.collectResponse(...)` appends text blocks into `CanonicalResponse["content"]`, whose element type is the full `CanonicalContentBlock` union.
- The `content[activeTextIndex]?.type === "text"` guard narrows the condition but does not reliably preserve the narrowed indexed access for the later object literal that reads `content[activeTextIndex].text`.
- That leaves TypeScript seeing the indexed value as `CanonicalContentBlock`, where `image`, `tool_use`, `tool_result`, and `reasoning_redacted` members do not expose `.text`.
- Both failures are caused by control-flow narrowing limits around discriminated unions, not by incorrect deploy configuration.

## Hypotheses

- Primary hypothesis: replace the unreachable throw with a plain exhaustive error string so the method still fails loudly at runtime without reading a property from `never`.
- Primary hypothesis: capture the active content block in a local variable after narrowing, then read `.text` from that narrowed variable before writing the updated text block back.
- Secondary hypothesis: small regression tests around the current helper behavior will keep these compiler-only mistakes from reappearing during future refactors.

## Proposed Fix

- Update `agent-service.ts` to use an exhaustive fallback that does not access `directive.tool` after the union is fully narrowed.
- Update `thread-title-service.ts` to accumulate streamed text through a locally narrowed text block reference.
- Add or extend lightweight agent/title tests as needed.
- Re-run `pnpm --dir /Users/adam/bud/service build` to verify the fix.

## Spec Files Affected

- `service/src/agent/agent.spec.md`
