# Data sources UX

The plan and design for this work live in the mobile repo, and cover both repos:

- Design: `bud-mobile/design/data-sources-ux/`
- Plan: `bud-mobile/plan/data-sources-ux/` (`implementation-spec.md` and one file per phase)

Phase 1 (sources and switches) is built in this repo on `feature/data-sources`:
`service/src/personal-data/sources.ts`, migration `0067_fast_ikaris.sql`, and
`web/src/components/data-sources.tsx`. Deploy the service (with the migration) before the
phone build that reads the switches.
