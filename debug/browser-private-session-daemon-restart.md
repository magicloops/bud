# Debug: private browser blocks reopening after daemon restart

## Reproduction and cause
Take private control, restart the daemon (destroying its ephemeral Chrome), then
ask the agent to open a browser. BrowserRepository.prepare checks private state
before boot reconciliation and returns browser_private_or_paused forever.

## Fix and boundaries
After validating owner/thread/Bud, the live invocation and dispatch receipt,
reconcile a different authenticated daemon boot before checking private control.
Retire the dead session without clearing its private-content latch or returning
its handoff. Explicit open creates a fresh identity/profile; other actions report
browser_interrupted_reopen_required. Same-boot private sessions remain blocked,
including service restarts. No automatic action replay or handoff continuation.
The boot comes from the authenticated carrier, never model arguments.

## Validation and rollout
Extend the isolated PostgreSQL repository test for paused/private/resume-pending
same-boot protection and new-boot replacement, preserving old privacy metadata.
No schema or wire change; service-only fix uses existing daemon boot capability.
