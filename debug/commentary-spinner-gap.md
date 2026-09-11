# Commentary ends before the model response completes

Proposed fix: [assistant output activity design](../design/assistant-output-activity.md).

## Evidence
Production Debug mobile capture `chat-debug-5.log`, thread
`f98905e9-55a1-4cbe-ac41-c5e9392ff6ca`, invocation
`01M2758Y8CHPWSDJYHKB1SFKBD`:

- First text arrives about 13.9 seconds after the optimistic user row; first
  render acknowledgement follows about 102 ms later. Client logs cannot assign
  that upstream latency to provider, backend or network.
- Commentary's last delta to message_done is 5,769 ms. Last acknowledged
  text-length change to done is 5,781 ms. A tool arrives 16 ms after done.
- The spinner remains suppressed by the streaming message during this interval.
  This is not the 150 ms spinner grace period.

## Source findings before the fix
In `service/src/llm/providers/openai.ts`, `response.output_text.done` becomes
`content_done`; function-call creation and arguments become `tool_use_start`
and `tool_use_delta`. In `service/src/agent/model-runner.ts`, the event switch
does not handle any of those three events. It streams text deltas but collects
tool calls only at `tool_use_done`, then returns after the provider iterator
finishes. `completeAssistantDraft` separately emits the classified
`agent.message_done` after the agent loop has decided continuation versus final.

Consequently, an already-ended text block stays streaming on clients while
non-text generation can continue. This mechanism fits the capture; the capture
does not contain provider event timestamps proving what occupied the exact gap.
These findings describe the current working tree, including the earlier
completion-classification change, not a verified deployment SHA.

## Implemented change
Keep final/intermediate classification tied to the validated response decision.
Separately expose transitions between actual text generation and non-text work
so the spinner does not depend on a draft remaining incomplete. Use provider
content boundaries and tool/reasoning starts, rather than an inactivity timer
that guesses message completion. A subsequent text block must suppress the
spinner again without duplicating the draft or its text.

Before changing the contract, cover:
- commentary → slow tool arguments → execution;
- text → another text block and interleaved reasoning;
- final text ending just before response completion (retain no-flash behavior);
- cancellation/error while classification is pending;
- reconnect snapshot/replay carrying the same activity facts;
- equivalent web/mobile handling and provider-specific boundary availability.

If more timing evidence is needed, record only boundary timestamps (last text
delta, content_done, tool start/done, provider completion, SSE completion) per
model call. No argument payloads or per-token logs are needed.

The implementation adds output activity to the backend snapshot/SSE and both clients.
No deployment has been performed.

Validation initially caught test fixture type errors (`LLMProvider` capabilities,
`ResolvedModelReasoning`, and Swift `ChatTurn.createdAt`) and an exhaustive
`ChatBackendEvent` switch missing the new case. These were corrected. Commands:
`pnpm --dir service exec tsc --noEmit`, `pnpm --dir web test:render`, and
`xcodebuild test -project Bud.xcodeproj -scheme "Bud Production Debug"` with the
iOS simulator destination and focused chat test suites. The static web render
assertion now accounts for the new client-side entry grace.
