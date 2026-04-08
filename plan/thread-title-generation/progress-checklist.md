# Thread Title Generation Progress Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).

Use this as the running status board while the title-generation work lands.

## Status Legend

- `[ ]` not yet started or not yet verified
- `[x]` implemented and verified
- `[-]` deferred or intentionally out of scope for now

## Phase 1: Backend Title Generation Foundation

### Backend Contract

- [ ] dedicated title-generation helper/service exists
- [ ] title-generation model is fixed to `claude-haiku-4-5`
- [ ] title prompt is constrained to short plain-text output
- [ ] sanitization exists
- [ ] validation exists
- [ ] invalid output fails closed
- [ ] missing Anthropic provider/model fails closed

### Trigger And Persistence

- [ ] only the first qualifying user message on an untitled thread triggers generation
- [ ] duplicate `client_id` retries do not schedule a second meaningful generation pass
- [ ] title generation is launched only after the assistant turn is queued successfully
- [ ] `POST /messages` does not await title generation
- [ ] title persistence uses a conditional `title IS NULL` write
- [ ] successful persistence emits `thread.title`

## Phase 2: Thread Stream Event And Reference Web Adoption

### Bud Route State

- [ ] `/$budId` uses mutable thread summary state rather than only immutable loader projections
- [ ] child thread route can upsert thread summaries into the Bud route state
- [ ] thread-open canonical detail patches the Bud route state

### Live Title Updates

- [ ] `/$budId/$threadId` listens for `thread.title`
- [ ] `thread.title` updates the Bud thread list row live
- [ ] `thread.title` updates the active thread header live
- [ ] existing delete/select behavior still works after the Bud-route state change

## Phase 3: Docs, Mobile Handoff, And Validation

### Docs And Handoff

- [ ] `docs/proto.md` updated
- [ ] service specs updated
- [ ] web specs updated
- [ ] mobile handoff updated
- [ ] `bud.spec.md` updated

### Verification

- [ ] first new-thread send shows a live title update in the web app
- [ ] the durable title survives refresh/reopen through canonical reads
- [ ] failure-to-generate remains stable on fallback labels
- [ ] deferred follow-up scope is documented explicitly

## Overall Progress

| Phase | Status | Notes |
|-------|--------|-------|
| 1 | Not Started | Backend still does not generate or stream thread titles today |
| 2 | Not Started | Reference web still uses loader-seeded placeholder titles and static active-thread labels |
| 3 | Not Started | Protocol/spec/handoff docs do not yet describe `thread.title` |

## Notes

- Keep this checklist current as soon as implementation or verification status changes.
- If the shipped contract diverges from the current design docs, update those docs during Phase 3 rather than leaving them partially correct.
