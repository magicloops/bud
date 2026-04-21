# Validation Checklist: Service Layer Refactor

## Boot / Setup

- [ ] `pnpm --dir /Users/adam/bud/service dev` starts successfully with no LLM provider keys configured
- [ ] auth and device-claim flows remain usable without LLM provider keys
- [ ] agent flows still start successfully when a supported provider key is configured

## Ownership / Streams

- [ ] browser-visible thread agent stream still requires an authenticated viewer
- [ ] browser-visible thread terminal stream still requires an authenticated viewer
- [ ] unauthorized or cross-user resource reads still return `404` rather than leaking resource existence
- [ ] no deleted legacy run or Bud-scoped terminal stream paths remain exposed

## Device Claim / Enrollment

- [ ] seeded enrollment tokens and runtime enrollment verification use the same hashing logic
- [ ] a Bud can still claim/authenticate successfully after the hashing cleanup

## Terminal Runtime

- [ ] creating a terminal explicitly and sending the first user message immediately does not race or fail
- [ ] `terminal.send` still works for a normal shell command flow
- [ ] `terminal.observe` still works for a normal shell observation flow
- [ ] canceling an active terminal wait fails promptly
- [ ] disconnecting a Bud during an active wait fails promptly
- [ ] terminal readiness/context behavior remains correct for common shell cases
- [ ] the Node REPL `>` prompt is classified as REPL rather than shell

## Agent Runtime

- [ ] a normal user message still produces assistant/tool/system transcript behavior correctly
- [ ] thread-title generation works with the available provider set or skips quietly when no compatible provider exists
- [ ] terminal-heavy agent turns still emit the expected tool-call, tool-result, and final assistant events

## Legacy Runtime Removal

- [ ] `/api/runs` is removed or intentionally absent from the active service
- [ ] `RunManager` is no longer part of normal service bootstrap
- [ ] no active browser path depends on the removed standalone run/event surface

## Documentation / DB Workflow

- [ ] service specs describe the new module layout accurately
- [ ] root docs index the new refactor plan and updated service docs accurately
- [ ] README and related DB docs describe `db:push` for local dev and `db:migrate` for staging accurately
- [ ] if schema changed, local validation used `db:push`
- [ ] if schema changed, staging validation used `db:migrate`
