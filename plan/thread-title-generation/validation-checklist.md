# Thread Title Generation Validation Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).

## Status Legend

- `[ ]` not yet run
- `[x]` verified
- `[-]` deferred or not applicable

## Phase 1: Backend Title Generation Foundation

### Qualification And Generation

- [ ] first qualifying user message on an untitled thread triggers title generation
- [ ] non-first user messages do not trigger title generation
- [ ] duplicate `client_id` retry does not trigger a second meaningful generation pass
- [ ] generated output is sanitized before persistence
- [ ] malformed generated output is rejected and logged
- [ ] missing Anthropic provider/model skips generation and logs

### Persistence And Stream

- [ ] successful generation writes `thread.title`
- [ ] conditional persistence prevents overwrite once title exists
- [ ] successful persistence emits `thread.title`
- [ ] emitted payload uses snake_case fields
- [ ] `thread.title` participates in the existing thread-stream cursor space
- [ ] `POST /messages` remains responsive while title generation runs in parallel

## Phase 2: Thread Stream Event And Reference Web Adoption

### New Thread Flow

- [ ] create a new thread from `/$budId/new`
- [ ] send the first message
- [ ] confirm the thread appears in the Bud thread list
- [ ] confirm fallback title is replaced live when `thread.title` arrives

### Existing Thread View

- [ ] active thread header shows canonical fallback title before live update if needed
- [ ] active thread header updates live when `thread.title` arrives
- [ ] reopening an already-titled thread shows the canonical title without needing a new stream event
- [ ] missing the stream event before attach still converges through canonical thread detail

## Phase 3: Docs, Mobile Handoff, And Validation

### Docs / Spec Alignment

- [ ] `docs/proto.md` updated
- [ ] `service/src/routes/routes.spec.md` updated
- [ ] `service/src/runtime/runtime.spec.md` updated
- [ ] `service/src/agent/agent.spec.md` updated
- [ ] `web/src/routes/$budId/budId.spec.md` updated
- [ ] `web/src/components/workbench/workbench.spec.md` updated
- [ ] `bud.spec.md` updated
- [ ] `design/mobile-thread-title-stream-handoff.md` updated if the shipped payload differs from the draft

### Failure And Fallback

- [ ] title-generation failure leaves web stable on fallback labels
- [ ] durable thread reads still return the correct title after refresh/reopen when generation succeeded
- [ ] no title-specific follow-up fetch is required on the happy path

## Notes

- This checklist validates the first-pass contract only: generated title from first user message plus streamed `thread.title`.
- Generic live thread-summary updates and manual rename flows are intentionally out of scope here.
