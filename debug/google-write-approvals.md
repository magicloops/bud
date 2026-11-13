# Debug: Google write approval validation

## Environment
- macOS development checkout, separate PR180/PR182 worktrees.
- Package-local pnpm/TypeScript and Node test runner; PostgreSQL tests use isolated
  schemas on the existing local database. OAuth and Google APIs are synthetic.
- No production connection, real message send, event write or Drive mutation.

## Reproduction and observations
The original PRs request write scopes and dispatch writes after ownership checks,
with only model instructions for approval. There is no per-service block or global
write control. The updated path must stop before dispatch and park for an exact
owner approval.

### Dependency setup
`pnpm install --frozen-lockfile` in both service worktrees installed dependencies
but exited 1 with `ERR_PNPM_IGNORED_BUILDS`: ignored esbuild@0.18.20,
esbuild@0.25.12 and protobufjs@7.5.5. Web install reported esbuild@0.25.12 and
esbuild@0.27.1. pnpm generated untracked placeholder pnpm-workspace.yaml files.
These setup artifacts are removed rather than adding unrelated dependency policy.
Installed package binaries successfully run backend builds and tests.
`pnpm install --frozen-lockfile --allow-build=esbuild` in web exited 2:
`unexpected argument '--allow-build'`. Web validation uses the installed tools.
An initial helper invocation with `python` failed `zsh: command not found: python`;
using `python3` resolved it without repository changes.

### Integration order
An intermediate PR182 `pnpm build` exited 2 before the shared runtime changes were
ported: `TS2339: Property 'parkGoogleApproval' does not exist on type
'AgentExecutionHooks'` and `TS2353` for the corresponding hook in agent tests.
The runtime hook and tests are updated together before final validation.
The initial PR182 connection suite reached the route test with expected 404 versus
actual 400 while the consent route still accepted the old single-service body.
Updating the route to the selected-service array fixed the test.

## Fix and validation
Use the existing durable invocation action for approval, plus explicit OAuth
choices and dispatch-time write policy. Both connection suites pass against local
PostgreSQL. Initial Calendar executor/transport checks pass (13); Gmail/Drive
executor/transport checks pass (20). Final consolidated results are recorded below
after the approval and UI suites complete.

### Approval repository regressions
`DOTENV_CONFIG_PATH=/Users/sp/Documents/bud/service/.env BUD_DATA_DB_TEST=1 pnpm exec node --import tsx --test src/google/approvals.test.ts`
initially failed with `Missing expected exception` for unsupported services /
malformed timestamps and `Missing expected rejection` when an approval's operation
key was changed before consumption. Parser validation and exact operation-key
matching fix those failures; decisions also lock invocation before action to
serialize with cancellation.

### Remote validation
`git ls-remote origin refs/heads/codex/google-calendar-access refs/heads/prashanth/googleservices refs/heads/main`
failed with `git@github.com: Permission denied (publickey). fatal: Could not read
from remote repository.` The local origin uses SSH without a usable key; test
HTTPS through the existing GitHub CLI credential helper instead of changing
user-wide Git configuration.

HTTPS remote validation succeeded using the existing GitHub CLI credential
helper with per-command Git settings. No user-wide Git configuration was changed.

### Final backend verification
The consolidated command below passed with local PostgreSQL enabled: **45 tests
for PR180 and 52 for PR182**, zero failures or skips.

```sh
DOTENV_CONFIG_PATH=/Users/sp/Documents/bud/service/.env BUD_DATA_DB_TEST=1 pnpm exec node --import tsx --test src/google/*.test.ts src/agent/google-approval-loop.test.ts src/agent/invocation-google-approval.test.ts src/agent/invocation-worker.test.ts src/routes/threads/state-loader.test.ts
```

`pnpm build` passed from both service package directories. The approval repository
suite was rerun after final identity validation tightening: 9/9 on each branch.
All provider requests in these checks used synthetic transport.

### Final web verification
`pnpm test`: 274 passed; `pnpm test:render`: 98 passed.
`pnpm build` and connected-apps ESLint passed. Only Vite's existing large-chunk
warning remains. Temporary pnpm build-approval configuration was removed.
A zsh harness used the read-only variable `status` after successful tests and
exited 1; changing the temporary harness variable fixed it, with no app changes.

The final three Google loop scenarios and approval repository suite were also
rerun after failure-path and identity review; all passed.
