# browser-agent-default

Phased implementation plan for agent-default browser ownership with an explicit,
short-lived human override. Implemented locally across service/DB/daemon/web/mobile; physical acceptance and
coordinated deployment remain pending.

## Files

| File | Purpose |
|---|---|
| [README.md](README.md) | Product contract, lifecycle policy, proposed lease defaults, ownership and phase dependencies |
| [phase-1-contract-and-db.md](phase-1-contract-and-db.md) | Authority/lease contract, schema replacement, migration and handoff semantics |
| [phase-2-daemon.md](phase-2-daemon.md) | Local expiry, input fencing, cleanup and readiness reconciliation |
| [phase-3-service-and-agent.md](phase-3-service-and-agent.md) | Coordination, authorization, agent continuation and task prompts |
| [phase-4-web-and-mobile.md](phase-4-web-and-mobile.md) | Explicit takeover, immediate exit, native lifecycle and shared presentation |
| [phase-5-validation-and-cutover.md](phase-5-validation-and-cutover.md) | Failure matrix, obsolete-path removal and coordinated upgrade |

## Dependencies and status

Depends on the current browser resource, workspace, viewer and daemon authority
contracts linked from README. Supersedes recommendations in the
[control lifecycle review](../browser-streaming/control-lifecycle-review.md).
No runtime dependencies are added. Phase work and validation evidence are tracked in the phase docs; unchecked physical
checks and deployment are not claimed complete.
