# Validation Checklist: OpenAI Responses Assistant Phase Preservation

Manual validation pending.

## Dependency Baseline

- [x] `service/package.json` declares `openai` as `^6.39.0`
- [x] `service/pnpm-lock.yaml` resolves `openai@6.39.0`
- [x] SDK declaration support for `phase` is recorded in the implementation notes

## OpenAI Request Shape

- [x] Replayed assistant commentary text lowers to an OpenAI input message with `phase: "commentary"`
- [x] Replayed assistant final text lowers to an OpenAI input message with `phase: "final_answer"`
- [x] Assistant text without known phase omits `phase` until fallback derivation supplies one
- [x] Non-assistant messages never emit `phase`

## OpenAI Output Parsing

- [x] Streaming output message with `phase: "commentary"` produces canonical `assistantPhase: "commentary"`
- [x] Streaming output message with `phase: "final_answer"` produces canonical `assistantPhase: "final_answer"`
- [x] Non-streaming output message with `phase: "commentary"` produces canonical `assistantPhase: "commentary"`
- [x] Non-streaming output message with `phase: "final_answer"` produces canonical `assistantPhase: "final_answer"`
- [x] Tool calls and reasoning blocks keep current ordering and payload semantics

## Persistence And Replay

- [x] Provider-ledger round trip preserves explicit `assistantPhase`
- [x] Provider-ledger replay derives `commentary` for historical output with text plus tool calls
- [x] Provider-ledger replay derives `final_answer` for historical output with text and no tool calls
- [x] Intermediate assistant product rows carry `metadata.assistant_phase: "commentary"`
- [x] Final assistant product rows carry `metadata.assistant_phase: "final_answer"`
- [x] Conversation-loader fallback uses `metadata.assistant_phase` before `segment_kind`
- [x] Conversation-loader maps `segment_kind: "intermediate"` to `commentary`
- [x] Conversation-loader maps `segment_kind: "final"` to `final_answer`

## Same-Turn Agent Loop

- [x] Visible assistant text before a tool call is replayed to OpenAI as `commentary`
- [x] Final visible assistant text with no tool call is replayed to OpenAI as `final_answer`
- [x] Multi-tool turns preserve phase across every follow-up provider request

## Anthropic Regression

- [x] Anthropic transformed messages do not include phase-like metadata
- [x] Anthropic streaming behavior is unchanged
- [x] Anthropic non-streaming behavior is unchanged

## Commands

- [x] `pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/llm/providers/providers.test.ts src/llm/provider-ledger.test.ts src/agent/conversation-loader.test.ts src/agent/transcript-writer.test.ts src/agent/model-runner.test.ts src/agent/agent-service.test.ts`
- [x] `pnpm --dir /Users/adam/bud/service build`

## Docs / Specs

- [x] `service/src/llm/llm.spec.md` reflects the canonical assistant phase contract
- [x] `service/src/llm/providers/providers.spec.md` reflects OpenAI phase round trip and Anthropic no-op behavior
- [x] `service/src/agent/agent.spec.md` reflects transcript fallback and same-turn replay behavior
- [x] `service/service.spec.md` reflects the OpenAI SDK dependency
- [x] `bud.spec.md` includes the plan folder references
