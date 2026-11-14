# Data sources UX

The plan and design for this work live in the mobile repo, and cover both repos:

- Design: `bud-mobile/design/data-sources-ux/`
- Plan: `bud-mobile/plan/data-sources-ux/` (`implementation-spec.md` and one file per phase)

Phase 1 (sources and switches) is built in this repo on `feature/data-sources`:
`service/src/personal-data/sources.ts`, migration `0067_fast_ikaris.sql`, and
`web/src/components/data-sources.tsx`. Deploy the service (with the migration) before the
phone build that reads the switches.

Phase 3 (the access log) is built on the same branch: `service/src/personal-data/access-log.ts`,
migration `0068_chief_starbolt.sql`, and the "Read in the last week" section of
`web/src/components/data-sources.tsx`. Deploy the service with the migration first.

Phase 2b (the access request as its own tool and card) is built on `feature/access-request`:
the tool `data_source_request` (`service/src/agent/source-request-tool.ts`),
`service/src/personal-data/source-requests.ts`, migration `0069_motionless_reaper.sql`, and
`web/src/components/message-renderers/tools/source-request.tsx`. It removes the
`source_access` kind from `ask_user_questions`. Deploy the service with the migration first,
then the phone build, close together: an older phone build has no card for the new tool.
