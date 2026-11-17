# Multiple Google accounts for connected services

Build on [Google services PR 182](https://github.com/magicloops/bud/pull/182) with shared Drive write coordination and the concurrent grant handling from [PR 185](https://github.com/magicloops/bud/pull/185). A signed-in user can connect two or more Google identities independently to Gmail, Calendar and Drive and see which account each action uses.

## Ownership and contracts

Better Auth resolves the Bud viewer. Each Google connection belongs to that viewer. Pending OAuth state stays on the existing connection table and is bound to the initiating session, requested access and optional owned target connection and thread. Resolve the target in owner-filtered SQL before updating credentials, returning inventory or dispatching a tool. An Add flow starts a temporary row with no subject. Revocation cancels open choosers for that viewer so that an unidentified callback cannot restore the revoked grant. Google network calls run outside database transactions. Check the selected connection and its grant epoch before applying consent or dispatching a request. If Add selects an existing identity, retain its credentials and use its targeted consent flow for any missing access. The verified Google subject identifies the account within the owner's connections. Keep the current encrypted credential binding and existing row IDs on migration.

## Implementation

- Extend the [Google service](../service/src/google/google.spec.md) and [database](../service/src/db/db.spec.md) to support adding an account through Google's chooser and targeting an account for upgrades and reconnect. Handle duplicate account selection, concurrent attempts, cancellation and revocation without transferring credentials between identities.
- Extend [Connected Apps](../web/src/features/connected-apps/connected-apps.spec.md) in Settings and chat with account-specific actions. Tool discovery must resolve ambiguous account choices before execution.
- Update the [migration inventory](../service/drizzle/migrations/migrations.spec.md), operational documentation and [ownership checklist](init-auth/validation-checklist.md).

## Validation and rollout

Exercise two Google subjects, multiple service grants, retry and concurrency, wrong-subject callbacks, cross-owner IDs, ambiguous tool selection, and account-specific UI actions. Validate the migration from the Google services schema in a local database and build service and web. Deploy the checked-in migration before matching service and web builds. The daemon and wire protocol need no upgrade.
