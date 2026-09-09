# Plan: Thread-scoped automation authoring

## Context and objective
Production Contact Atlas setup reused Adam's Contacts automation and retained its
original destination. Separate workflows should default to separate rules in their
originating chats. See service/src/personal-data/personal-data.spec.md,
service/src/agent/agent.spec.md and web/src/components/components.spec.md.

## Approach and ownership
- Agent list defaults to `scope: thread`; optional `scope: all` remains owner-wide.
  Resolve thread/Bud from the fenced human invocation, never tool-supplied IDs.
  Reuse SQL ownership/active-target filtering and recheck authority after reads.
- Tool guidance distinguishes independent workflows from duplicate deliveries.
  Cross-thread edits require user direction; retain account-wide management.
- Reviews in web/mobile identify first activation versus replacement and prominently
  name the destination, including when it is another conversation.
- Derive additive review metadata from immutable revisions preceding the reviewed
  draft and owner-scoped thread lookup. Do not infer update from draft version:
  an unactivated draft can have multiple edits. No schema migration or new writes.
- Existing rules remain unchanged. Splitting the production rule is separate work.

## Validation and rollout
Local PostgreSQL tests: default/null/all scope, other threads/owners excluded,
first activation after draft edits versus replacement, metadata after approval.
Web render tests and build; mobile simulator build. Add owner-isolation checklist.
Service changes work with existing daemons and clients. New mobile/web clients use
neutral review wording if metadata is absent from an older service.

## Implementation and validation
Implemented service/tool discovery and web/mobile review presentation. Additive
review metadata is returned by human detail/list/decision endpoints; initial tool
and state snapshots retain their existing shape. Both clients fetch detail before
deciding. Destination titles are current display metadata, not frozen authority.
Thread scope means the saved effective execution destination (active revision if
present, otherwise draft); new-thread-per-run rules require all scope.

Validation: service build; two PostgreSQL suites covering invocation authority,
scoped discovery, proposal lifecycle and operation metadata; four web render tests;
web production build; iOS generic simulator Debug build. All passed.
Manual agent behavior and on-device review layout remain to validate after deploy.
No production rule edits, commits, deployment or phone installation performed.
