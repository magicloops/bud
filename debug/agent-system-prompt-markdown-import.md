# Debug: Agent System Prompt Markdown Import

## Environment
- Workspace: `/Users/adam/bud`
- Package: `service`
- Runtime: Node.js `v22.14.0` from the command output
- Current implementation under review:
  - `service/src/agent/default-system-prompt.md` is the markdown prompt source
  - `service/src/agent/system-prompt.ts` reads the markdown source and exports `AGENT_SYSTEM_PROMPT`
  - `service/src/agent/conversation-loader.ts` imports `AGENT_SYSTEM_PROMPT` from `system-prompt.ts`
  - `service/package.json` copies the markdown source into `dist/agent/` after build

## Repro Steps
1. From the repo root, run:

```bash
pnpm --dir /Users/adam/bud/service test
```

## Observed
- The package `pretest` hook did run the generator successfully:

```text
> @bud/service@0.0.1 pretest /Users/adam/bud/service
> pnpm generate:agent-system-prompt

> @bud/service@0.0.1 generate:agent-system-prompt /Users/adam/bud/service
> tsx src/scripts/generate-agent-system-prompt.ts

Generated /Users/adam/bud/service/src/agent/default-system-prompt.generated.ts
```

- The full service test command failed with 2 failures out of 328 tests:

```text
# Subtest: final no-tool response records exactly one LLM call
not ok 6 - final no-tool response records exactly one LLM call
  error: 'this.runtime.setLastError is not a function'
  stack: |-
    AgentService.runAgentFlow (/Users/adam/bud/service/src/agent/agent-service.ts:894:20)
    async TestContext.<anonymous> (/Users/adam/bud/service/src/agent/agent-service.test.ts:606:3)

# Subtest: OpenAI tool-loop replay marks pre-tool assistant text as commentary
not ok 7 - OpenAI tool-loop replay marks pre-tool assistant text as commentary
  error: 'this.runtime.setLastError is not a function'
  stack: |-
    AgentService.runAgentFlow (/Users/adam/bud/service/src/agent/agent-service.ts:894:20)
    async TestContext.<anonymous> (/Users/adam/bud/service/src/agent/agent-service.test.ts:889:3)

1..328
# tests 328
# pass 326
# fail 2
```

- The prompt-specific tests in `conversation-loader.test.ts` passed during the same broad run:
  - `system prompt documents only public wait_for modes`
  - `system prompt scopes ask_user_questions usage policy`
  - the loader reconstruction tests that compare the first system message against `AGENT_SYSTEM_PROMPT`

## Expected
- The markdown-authored prompt should be consumable by all service tests and builds without depending on a stale generated file in the working tree.
- Tests that import `AGENT_SYSTEM_PROMPT` from `conversation-loader.ts` should keep working or should be updated to import from a single prompt module with no dual ownership.
- Running package-local scripts should not require manual generation outside the documented package hooks.

## Hypotheses
- The broad test failure observed here is not directly caused by the markdown prompt path. The generator ran, the generated module imported, and the prompt/loader tests passed. The failing stack points at an `AgentService` runtime mock that lacks `setLastError`.
- The current dual-path shape is still fragile:
  - `conversation-loader.ts` both imports and re-exports `AGENT_SYSTEM_PROMPT`, which keeps old imports alive but hides the prompt ownership boundary.
  - The generated shim is ignored, so any ad hoc command that imports `conversation-loader.ts` before running the generator can fail with a missing module.
  - Tests run through `pnpm test` are covered by `pretest`, but focused commands such as `pnpm exec node --import tsx --test src/agent/conversation-loader.test.ts` only work if the generated file already exists from a prior package script.
  - Because the generated file sits under `src/agent`, TypeScript treats an untracked build artifact as a normal source module, which can make test behavior depend on local workspace state.
- A cleaner design should avoid two visible prompt paths. Either the markdown file should be the only source loaded by one prompt module, or the generated TypeScript module should be checked in and treated as source, not ignored. The latter weakens the point of splitting the prompt into markdown.

## Proposed Fix
- Replace the current import-plus-re-export shim with a single prompt ownership module, likely `service/src/agent/system-prompt.ts`, and have all callers import from that module instead of `conversation-loader.ts`.
- Avoid an ignored generated source file under `src/` if possible. Candidate directions:
  - Load `default-system-prompt.md` through `readFileSync(new URL(..., import.meta.url), "utf8").trim()` in a dedicated prompt module, then make the build copy the markdown asset into `dist/agent/` before `node dist/server.js` runs.
  - Or keep generation, but generate into a clearly named build-output location and ensure every package-local dev/test/build entrypoint depends on it. This still leaves ad hoc focused tests fragile unless their command also runs the generator.
- Update `conversation-loader.test.ts` to import `AGENT_SYSTEM_PROMPT` from the new prompt module, leaving `conversation-loader.ts` responsible only for conversation assembly.
- Update `service/src/agent/agent.spec.md` and `service/src/scripts/scripts.spec.md` to document the final ownership model after the implementation is changed.

## Resolution
- Replaced the generated TypeScript prompt shim with `service/src/agent/system-prompt.ts`.
- Removed `service/src/scripts/generate-agent-system-prompt.ts` and the package `predev` / `prebuild` / `pretest` generator hooks.
- Updated `service/src/agent/conversation-loader.test.ts` to import `AGENT_SYSTEM_PROMPT` from the single prompt module rather than from `conversation-loader.ts`.
- Added a package `postbuild` asset-copy step so compiled service runtime loads `dist/agent/default-system-prompt.md` through the same prompt module path.
- Kept `readFileSync` in the prompt module because Node/tsx do not import `.md` as a text module by default; updated `dev` to `tsx watch --include src/agent/default-system-prompt.md src/server.ts` so markdown prompt edits restart the dev server.

## Validation After Resolution
- `pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/agent/conversation-loader.test.ts`: passed 9/9 tests.
- `pnpm --dir /Users/adam/bud/service build`: passed, including the `postbuild` markdown copy into `dist/agent/`.
- `node -e 'import("/Users/adam/bud/service/dist/agent/system-prompt.js").then((m)=>console.log(`dist prompt: ${m.AGENT_SYSTEM_PROMPT.length} chars`))'`: printed `dist prompt: 10025 chars`.
- `pnpm --dir /Users/adam/bud/service exec tsx -e 'import("./src/agent/default-system-prompt.md").then((m)=>console.log(typeof m.default, m.default?.length ?? 0)).catch((e)=>{ console.error(e.message); process.exit(1); })'`: printed `Unknown file extension ".md" for /Users/adam/bud/service/src/agent/default-system-prompt.md`, confirming direct markdown imports are not supported without extra loader machinery.

## Spec Files Affected
- `service/src/agent/agent.spec.md`
- `service/service.spec.md`
