# Progress Checklist: Agent Message Duration Metadata

- [x] Create `plan/message-duration-metadata/` folder
- [x] Create parent implementation spec
- [x] Create phase specs
- [x] Create validation checklist
- [x] Add folder spec
- [x] Add root `bud.spec.md` documentation index entries
- [x] Phase 1: add shared timing type/helper/serializer
- [x] Phase 1: preserve existing tool timing helper compatibility
- [x] Phase 1: add helper unit tests
- [x] Phase 2: persist `turn_id` on tool metadata
- [x] Phase 2: persist `duration_source` on tool metadata
- [x] Phase 2: verify reasoning rows retain `turn_id`
- [x] Phase 2: persist `duration_ms` on reasoning metadata
- [x] Phase 2: persist `duration_source` on reasoning metadata
- [x] Phase 2: verify tool `message.content` remains replay-safe
- [x] Phase 3: track assistant draft `started_at` in runtime state
- [x] Phase 3: add `draft_assistant.started_at` to `/agent/state`
- [x] Phase 3: add `started_at` to `agent.message_start`
- [x] Phase 3: add `started_at`, `finished_at`, `duration_ms`, and `duration_source` to `agent.message_done`
- [x] Phase 3: persist timing metadata on intermediate assistant rows
- [x] Phase 3: persist timing metadata on final assistant rows
- [x] Phase 3: add assistant timing tests
- [x] Phase 4: update `docs/proto.md`
- [x] Phase 4: update service specs
- [x] Phase 4: update first-party web types if needed
- [x] Phase 4: update web specs if web files change
- [ ] Phase 4: add or update mobile-facing examples/fixtures
- [x] Run automated validation and record exact commands
- [ ] Run manual validation checklist
- [ ] Record follow-up for turn-level status or paused/active duration if still needed

Deferred follow-up: durable turn-level status, exact turn wall-clock duration,
and active-vs-paused duration for `ask_user_questions` remain intentionally out
of scope for this plan.
