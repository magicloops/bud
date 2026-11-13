# Plan: Google consent and write approvals

## Context
- PRs [180](https://github.com/magicloops/bud/pull/180) and [182](https://github.com/magicloops/bud/pull/182).
- Related specs: [Google](../service/src/google/google.spec.md), [agent](../service/src/agent/agent.spec.md), [connected apps](../web/src/features/connected-apps/connected-apps.spec.md).

## Objective
Allow users to choose genuine read-only Google grants or the implemented read/write capabilities in one consent flow. Require exact, one-use human approval before every Google mutation. Provide per-service Block changes controls and a global service write switch.

## Design and ownership
- Calendar implements the shared boundary in PR180; PR182 extends it to Gmail/Drive and combined service selection. Preserve whole-Drive search/edit with explicit broad consent; choosing individual files would change the product's current feature set.
- Owner-scoped Google connection rows retain encrypted credentials and per-service policies. Browser viewer comes from requireViewer; all mutations check cookie Origin. Approval lookup joins the owned invocation, thread and Bud before exposing data or recording a decision. Foreign resources return 404.
- Reuse the existing owned agent_invocation_action evidence for pending approvals and the durable invocation park/continue mechanism. Store exact arguments, original operation key, account/grant identity and ten-minute expiry. Public projections omit credential identities.
- Approval resumes the invocation with a one-use action ID. The next google_call must match the approved arguments and same invocation. Check policy, scopes, current account/grant, live lease/ownership and consume approval immediately before dispatch. Never retry uncertain mutations.
- New Google consent never executes an action. Block changes retains Google scopes; true read-only consent is separate. GOOGLE_WRITES_ENABLED=false disables all Google writes, checked at dispatch; changing the deployment environment requires a service restart.

## Spec files and contracts
- Update Google, agent, connected-apps/workbench/threads specs and ownership validation checklist.
- Document new owner-scoped consent selections, policy and approval endpoints plus pending-tool metadata in Google API documentation.
- No database schema/migration or daemon wire change; existing owner/tenant stamps and invocation evidence are reused.

## Validation
Synthetic OAuth/provider transport and isolated PostgreSQL tests cover partial/canceled consent, read-only scopes, policy changes, account identity, exact action approval, wrong owner/thread/invocation, expiry, rejected approval, duplicate decisions, single-use consumption and kill switch. Mounted UI tests cover explicit choice, approval display/actions and stale owner/thread responses. Run service and web builds in both worktrees.

## Rollout
Deploy matching service/web after existing Calendar migration 0067. Update configured Google scopes for the optional read-only grants. No daemon upgrade. Drain old agent workers before service cutover; outstanding unapproved old calls must not execute under mixed worker versions. Existing write-capable accounts default to Ask before changes; no re-consent needed unless scopes are missing. Mobile must implement approval UI or direct users to the web; no bypass for older clients.
