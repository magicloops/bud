# Validation Checklist: Bud Offline Mode

## Backend Contract

- [ ] `/agent/state` includes `environment` while idle and Bud online.
- [ ] `/agent/state` includes `environment` while idle and Bud offline.
- [ ] `/agent/state` includes `environment` during active turns.
- [ ] Signed-in non-owners receive `404` for `/agent/state`.
- [ ] `POST /messages` returns `201` for offline-aware starts.
- [ ] `POST /messages` response includes canonical user message and `agent` metadata.
- [ ] Duplicate `client_id` retries remain idempotent.

## Offline Startup

- [ ] Offline startup skips context sync.
- [ ] Offline startup skips terminal ensure.
- [ ] Offline provider calls exclude `terminal_send`.
- [ ] Offline provider calls exclude `terminal_observe`.
- [ ] Offline provider calls exclude web-view tools.
- [ ] Offline provider calls include `ask_user_questions`.
- [ ] Offline assistant final response persists normally.
- [ ] Offline provider failure emits/stores a normal failure boundary.

## Transport Recovery

- [ ] Terminal send offline during a normal turn records a structured tool result.
- [ ] Terminal observe offline during a normal turn records a structured tool result.
- [ ] Web-view transport failure records a structured tool result.
- [ ] Timed-out terminal request maps to a timeout-style tool result.
- [ ] Generic transport dispatch failure maps to a non-offline transport tool result.
- [ ] Agent loop continues after expected transport tool results.
- [ ] Environment switches to offline after disconnect.
- [ ] Environment returns to normal after reconnect.
- [ ] Later provider calls can receive Bud tools again after reconnect.

## Client UX

- [ ] Composer shows Bud offline state from `/agent/state.environment`.
- [ ] Composer status clears or changes when Bud returns online.
- [ ] Offline send success does not mark the message failed.
- [ ] Offline send success keeps normal assistant loading.
- [ ] Normal request failures still show failed-send behavior.
- [ ] No system transcript row is created solely for offline status.

## Manual Local Restart Scenarios

- [ ] Bud offline before send: assistant answers without Bud tools.
- [ ] Bud offline before command request: assistant explains limitation and recovery steps.
- [ ] Bud offline with `ask_user_questions`: structured question flow still works.
- [ ] Bud disconnects during terminal tool: structured tool result, coherent final response.
- [ ] Bud reconnects mid-turn: later provider step can use Bud tools again.
- [ ] Service restart during idle thread: `/agent/state.environment` recovers from current transport/db state.

## Documentation

- [x] `docs/proto.md` documents message-send `agent` metadata.
- [x] `docs/proto.md` documents `/agent/state.environment`.
- [x] `docs/proto.md` documents offline tool-catalog behavior.
- [x] `docs/proto.md` documents transport-error tool results.
- [x] Service specs document route, runtime, and agent changes.
- [x] Web specs document composer-status behavior if touched.
