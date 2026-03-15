# Phase 3.5: Local Development Ownership Backfill

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Design Doc**: [../../design/authentication-and-user-ownership.md](../../design/authentication-and-user-ownership.md)

---

## Objective

Preserve useful local prototype data by assigning all existing Bud-owned rows in the local development database to the current authenticated dev user before Phase 4 authorization enforcement lands.

For this phase, the target owner is:

- `dbjb0l3yvGQzdmlFcadq9o7G9efaTcOe`

This is explicitly a local-development convenience phase. It is not a production migration strategy.

By the end of this phase:

- existing local Buds, threads, messages, runs, sessions, and input logs all point to the same known owner
- Phase 4 can be tested immediately with a second user, without recreating large amounts of prototype data
- the broader production recommendation still remains: wipe prototype data before launch

---

## Scope

### In Scope

- one-off local-development SQL backfill
- assigning ownership fields to the known current user id
- documenting a backup/rollback path
- documenting the tables/columns that must be updated together

### Out Of Scope

- production migration tooling
- generalized multi-user historical ownership inference
- automatic scripts for arbitrary environments
- changing the production rollout decision to wipe prototype data before launch

---

## Preconditions

Before running this backfill:

- Better Auth is working locally
- the target user row already exists in `auth.user`
- Phase 3 device claim flow is working well enough to confirm Bud ownership semantics going forward
- the local database contains prototype data worth preserving for authorization testing

---

## Target User

Backfill all existing local-development data to:

```text
dbjb0l3yvGQzdmlFcadq9o7G9efaTcOe
```

Treat this as a fixed input for the one-off local migration.

---

## Tables And Columns To Update

### Core Bud-owned Rows

- `bud.created_by_user_id`
- `thread.created_by_user_id`
- `message.created_by_user_id`
- `run.created_by_user_id`
- `terminal_session.created_by_user_id`

### User-action Fields

- `run.canceled_by_user_id`
- `terminal_session_input_log.user_id`

### Claim/Auth Adjacent Rows Worth Normalizing

These are not the main source of browser-visible ownership, but normalizing them keeps local data coherent:

- `device_auth_flow.approved_by_user_id`

### Rows That Do Not Need Backfill

- `run_summary`
  It derives from runs/buds and has no owner column.
- `terminal_session_output`
  It derives from the owning terminal session and has no owner column.
- Better Auth core tables such as `auth.user`, `auth.session`, and `auth.account`
  These already belong to the auth system and should not be rewritten beyond verifying the target user exists.

---

## Recommended Migration Shape

### Step 1: Verify The Target User Exists

Expected query:

```sql
select id, email
from auth."user"
where id = 'dbjb0l3yvGQzdmlFcadq9o7G9efaTcOe';
```

If this row does not exist, stop.

### Step 2: Run A Single Transactional Backfill

Recommended outline:

```sql
begin;

update bud
set created_by_user_id = 'dbjb0l3yvGQzdmlFcadq9o7G9efaTcOe'
where created_by_user_id is null
   or created_by_user_id <> 'dbjb0l3yvGQzdmlFcadq9o7G9efaTcOe';

update thread
set created_by_user_id = 'dbjb0l3yvGQzdmlFcadq9o7G9efaTcOe';

update message
set created_by_user_id = 'dbjb0l3yvGQzdmlFcadq9o7G9efaTcOe';

update run
set created_by_user_id = 'dbjb0l3yvGQzdmlFcadq9o7G9efaTcOe';

update run
set canceled_by_user_id = 'dbjb0l3yvGQzdmlFcadq9o7G9efaTcOe'
where canceled_by_user_id is not null;

update terminal_session
set created_by_user_id = 'dbjb0l3yvGQzdmlFcadq9o7G9efaTcOe';

update terminal_session_input_log
set user_id = 'dbjb0l3yvGQzdmlFcadq9o7G9efaTcOe'
where user_id is not null or user_id is null;

update device_auth_flow
set approved_by_user_id = 'dbjb0l3yvGQzdmlFcadq9o7G9efaTcOe'
where approved_by_user_id is not null;

commit;
```

### Step 3: Spot-check Counts

After the transaction, verify that owner-bearing tables no longer contain unexpected non-target values.

Examples:

```sql
select created_by_user_id, count(*) from bud group by 1;
select created_by_user_id, count(*) from thread group by 1;
select created_by_user_id, count(*) from message group by 1;
select created_by_user_id, count(*) from run group by 1;
select created_by_user_id, count(*) from terminal_session group by 1;
```

### Step 4: Use A Second User For Phase 4 Testing

Once Phase 4 is implemented:

- sign in as the backfilled owner and confirm the prototype data is visible
- sign in as a second user and confirm that the same Bud/thread/run/session ids now return `404` or filtered-empty responses

---

## Implementation Notes

- This phase should be executed after Phase 3 but before serious Phase 4 verification.
- The backfill should happen in SQL, not by manually editing rows in a GUI.
- Keep it idempotent enough that rerunning it locally is harmless.
- Prefer a one-off script or documented SQL block over adding permanent service runtime code for historical data mutation.

---

## Interaction With Phase 4

This phase exists to support Phase 4 testing, not to replace it.

Phase 4 still needs to:

- filter reads by viewer ownership
- stamp all newly created rows correctly
- reject cross-user access
- enforce ownership consistently across REST and SSE

Without Phase 4, backfilled data will still remain globally visible because the current read paths are not yet scoped.

---

## Rollback

If the backfill is not desired anymore:

1. wipe and reseed the local development database, or
2. manually reset owner-bearing fields if you explicitly want to return to anonymous prototype data

Do not treat this as a reversible production-grade migration; it is a local testing convenience.

---

## Validation Checklist

- [ ] target Better Auth user exists
- [ ] all existing Bud-owned rows now point to `dbjb0l3yvGQzdmlFcadq9o7G9efaTcOe`
- [ ] no unexpected alternate `created_by_user_id` values remain in local prototype tables
- [ ] Phase 4 can be tested with a second user without creating new fixture data

---

## Exit Criteria

This phase is complete when the local development database’s prototype Bud-owned data is coherently assigned to the known current user, making it useful for later multi-user authorization testing.

---

*Last Updated: 2026-03-14*
