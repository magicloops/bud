# Progress Checklist: Tool Timing For Mobile Compaction

- [x] Create the `plan/tool-timing/` folder, parent implementation spec, phase docs, and checklist docs
- [x] Add the new plan folder to the root `bud.spec.md` documentation index
- [x] Define the canonical service-side timing boundaries for one tool call
- [x] Add a narrow internal timing type or equivalent service-local structure
- [x] Capture `started_at` in `AgentService.runAgentFlow(...)` before `agent.tool_call`
- [x] Capture `finished_at` and compute `duration_ms` after tool execution resolves
- [x] Thread timing data through transcript-writer boundaries without recomputing it
- [x] Extend `agent.tool_call` to include `started_at`
- [x] Extend `agent.tool_result` to include `started_at`, `finished_at`, and `duration_ms`
- [x] Persist timing fields in canonical tool `message.metadata`
- [x] Keep canonical tool `message.content` free of timing-only fields
- [x] Update first-party types/fixtures to tolerate the additive fields
- [x] Add focused automated coverage for stream payloads, canonical metadata, and replay safety
- [ ] Run the manual validation checklist
- [x] Update protocol docs and relevant service/root specs
- [ ] Record explicit follow-up if exact assistant timing is still desired

Deferred follow-up: exact assistant-response timing, turn-summary contracts, and any product-specific non-tool timing analytics remain intentionally out of scope for this rollout and should land as a separate design/plan if still required.
