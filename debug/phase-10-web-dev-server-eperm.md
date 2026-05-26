# Debug: Phase 10 Web Dev Server EPERM

## Environment

- OS / arch / versions: local Codex desktop workspace
- DB connection style: not applicable
- LLM mode: not applicable

## Repro Steps

1. Implement Phase 10 radial context send button.
2. Run focused web test and production build successfully.
3. Attempt browser validation by starting the Vite dev server:

```bash
pnpm --dir /Users/adam/bud/web dev --host 127.0.0.1
```

## Observed

The command failed:

```text
> @bud/web@0.0.1 dev /Users/adam/bud/web
> vite --host 127.0.0.1

error when starting dev server:
Error: listen EPERM: operation not permitted 127.0.0.1:5173
    at Server.setupListenHandle [as _listen2] (node:net:1915:21)
    at listenInCluster (node:net:1994:12)
    at node:net:2203:7
    at process.processTicksAndRejections (node:internal/process/task_queues:90:21)
 ELIFECYCLE  Command failed with exit code 1.
```

An escalated rerun was requested because this looks sandbox-related, but the
approval was rejected. The user later clarified that the dev server was already
running, so no additional dev server was needed.

An attempt to open the running dev server through the in-app browser was also
blocked:

- `http://127.0.0.1:5173` returned `net::ERR_BLOCKED_BY_CLIENT`.
- `http://localhost:5173` was rejected by browser security policy.

## Expected

Vite should bind a local development port so the composer can be inspected in
the browser.

## Hypotheses

- The workspace sandbox blocked binding `127.0.0.1:5173`.
- Browser validation can proceed once the dev server is started outside this
  sandbox or an existing dev server URL is provided.

## Proposed Fix

- No code fix is indicated by this error.
- Manually validate the radial send-button ring and tooltip in the already
  running local browser session, or provide a permitted non-localhost preview URL
  for automated browser validation.
- Spec files affected: none beyond the Phase 10 plan/workbench spec updates.
