# browser-agent-default

Phased implementation plan for agent-default browser ownership with an explicit,
short-lived human override. Implementation committed in Bud PR #134 and mobile
PR #50; automated checks and qualitative user retests passed. Remaining physical
failure-matrix acceptance, review and coordinated deployment are tracked in Phase 5.

## Files

| File | Purpose |
|---|---|
| [README.md](README.md) | Product contract, implemented lease defaults, ownership, phase dependencies and PR/source revisions |
| [phase-1-contract-and-db.md](phase-1-contract-and-db.md) | Authority/lease contract, schema replacement, migration and handoff semantics |
| [phase-2-daemon.md](phase-2-daemon.md) | Local expiry, input fencing, cleanup and readiness reconciliation |
| [phase-3-service-and-agent.md](phase-3-service-and-agent.md) | Coordination, authorization, agent continuation and task prompts |
| [phase-4-web-and-mobile.md](phase-4-web-and-mobile.md) | Explicit takeover, immediate exit, native lifecycle and shared presentation |
| [phase-5-validation-and-cutover.md](phase-5-validation-and-cutover.md) | Merge readiness, validation evidence, failure matrix and migrations 0044–0047 coordinated upgrade |

## Dependencies and status

Depends on the current browser resource, workspace, viewer and daemon authority
contracts linked from README. Supersedes recommendations in the
[control lifecycle review](../browser-streaming/control-lifecycle-review.md).
No runtime dependencies are added. Phase work and validation evidence are tracked in the phase docs; unchecked physical
checks and deployment are not claimed complete.
