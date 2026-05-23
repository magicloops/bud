# Progress Checklist: OpenAI Responses Assistant Phase Preservation

- [x] Create the `plan/openai-phases/` folder, parent implementation spec, phase docs, and checklist docs
- [x] Add the new plan folder to the root `bud.spec.md` documentation index
- [x] Update the service OpenAI SDK dependency to `^6.39.0`
- [x] Confirm the lockfile resolves `openai@6.39.0`
- [x] Inspect SDK `6.39.0` declarations for Responses `phase` support
- [x] Add `AssistantMessagePhase` to canonical LLM types
- [x] Add optional `assistantPhase` to canonical text blocks
- [x] Verify Anthropic ignores canonical assistant phase
- [x] Lower canonical assistant phase into OpenAI Responses input messages
- [x] Preserve OpenAI non-streaming output message phase
- [x] Preserve OpenAI streaming output message phase
- [x] Persist explicit phase through provider-ledger canonical payloads
- [x] Reconstruct explicit phase from provider-ledger canonical payloads
- [x] Derive historical provider-ledger phase for OpenAI outputs without explicit phase
- [x] Persist transcript fallback `metadata.assistant_phase`
- [x] Derive transcript fallback phase in `conversation-loader`
- [x] Fill missing same-turn replay phase before OpenAI follow-up requests
- [x] Add focused OpenAI provider tests
- [x] Add provider-ledger tests
- [x] Add conversation-loader and transcript-writer tests
- [x] Add same-turn tool-loop replay coverage
- [x] Add Anthropic no-op regression coverage
- [x] Update relevant service specs after implementation
- [x] Update the validation checklist with completed automated coverage

Deferred follow-up: adopting OpenAI `previous_response_id` for continuity would
be a separate design and rollout. This plan preserves manual replay semantics.
