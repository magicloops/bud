# Debug: Drizzle Migrations Not Being Applied

## Environment

- drizzle-kit: 0.31.6
- drizzle-orm: 0.44.7
- PostgreSQL via local Docker
- macOS

## Repro Steps

1. Create a new migration SQL file in `drizzle/migrations/`
2. Add an entry to `drizzle/migrations/meta/_journal.json`
3. Run `pnpm db:migrate`
4. Observe output: `[✓] migrations applied successfully!`
5. Check database - migration was NOT applied

## Observed

**drizzle-kit output:**
```
$ pnpm db:migrate
[✓] migrations applied successfully!
```

**Database state:**
```
=== Migrations in DB (drizzle.__drizzle_migrations) ===
1: edd3987a... (0000)
2: 780f71d2... (0001)
3: 32ec63bb... (0002)
4: eb35b2c5... (0003)
5: e4082cd7... (0004)
6: 8390da49... (0005)
7: 82260144... (0006)
Total: 7 migrations
```

**Journal has 9 entries (0000-0008)** but only 7 are in the database.

**File hashes (sha256sum):**
```
82260144c88c52c3... 0006_terminal_sessions.sql (matches DB row 7 ✓)
4e0fe0caf6ab9717... 0007_drop_legacy_sessions.sql (NOT in DB ✗)
e13e359a05478049... 0008_drop_current_session_id.sql (NOT in DB ✗)
```

## Expected

Migrations 0007 and 0008 should be applied to the database.

## Key Observations

1. **Hash tracking works**: Database stores SHA256 hashes, matches file content
2. **Migrations 0000-0006 applied correctly**: These were created by `drizzle-kit generate`
3. **Migrations 0007-0008 not applied**: These were manually created
4. **No error output**: drizzle-kit says "success" but does nothing

## Differences: Working vs Non-Working Migrations

| Aspect | 0006 (works) | 0007/0008 (broken) |
|--------|--------------|-------------------|
| Created by | `drizzle-kit generate` | Manual |
| File permissions | 0644 | 0600 |
| Snapshot file | No | No |
| In _journal.json | Yes | Yes (added manually) |
| Journal `when` | 1733644800000 | 1733990400000 |

## Hypotheses

### 1. drizzle-kit uses `when` timestamp for ordering/comparison

The journal entries have `when` timestamps. The database stores `created_at` timestamps.

**Problem**: Our manually-added `when` values (1733990400000, 1734048000000) might be:
- Being compared incorrectly with database values
- Expected to be in a specific sequence relative to existing migrations

**Evidence**: The working migrations have `when` values that match their database `created_at`.

### 2. Hash is computed differently than simple sha256sum

drizzle-kit might:
- Normalize line endings before hashing
- Strip comments
- Include metadata beyond just file content

**Evidence**: Need to verify by comparing our computed hashes with how drizzle computes them.

### 3. File permissions prevent reading

Our new migration files have `0600` (owner read/write only) vs `0644` for others.

**Evidence**:
```
-rw-r--r--  0006_terminal_sessions.sql
-rw-------  0007_drop_legacy_sessions.sql
-rw-------  0008_drop_current_session_id.sql
```

**Test**: `chmod 644` on the new files and retry.

### 4. Journal entries must be created by drizzle-kit generate

drizzle-kit might validate that journal entries match some internal state or were created through proper generation workflow.

**Evidence**: All working migrations were created via `drizzle-kit generate`, not manually.

### 5. drizzle-kit compares journal length vs database count

If drizzle sees 9 journal entries but 7 database entries, it might:
- Assume the delta has already been applied (incorrect assumption)
- Have a bug in migration detection logic

**Test**: Check what happens with a completely fresh database.

## Investigation Results

### Tested Hypotheses

1. **File permissions** - Fixed to 0644, still doesn't work ❌
2. **Hash computation** - Verified sha256sum matches DB hashes exactly ✓

### Root Cause Found

**Drizzle-kit requires `--custom` flag for manual migrations!**

From [Drizzle Custom Migrations docs](https://orm.drizzle.team/docs/kit-custom-migrations):

```bash
drizzle-kit generate --custom --name=seed-users
```

This creates:
- Empty migration folder with timestamp
- Proper journal entry
- Correct internal metadata

**We manually created SQL files and edited _journal.json directly**, which bypasses drizzle-kit's migration tracking system.

## Solution

1. Remove manual journal entries for 0007/0008
2. Delete the manually created SQL files
3. Use `drizzle-kit generate --custom --name=drop-legacy-sessions` to create proper migration
4. Add SQL content to generated file
5. Run `drizzle-kit migrate`

Alternatively, apply manually with a script (as we did for 0007).

## Resolution

This project uses **`drizzle-kit push`** (schema-first approach), not migrations.

**Fixed by:**
1. Updated `schema.ts` to remove `currentSessionId` column
2. Ran `npx drizzle-kit push`
3. Removed manual migration files (0007, 0008)
4. Reverted `_journal.json` to original state

**Lesson learned:** Use `drizzle-kit push` for schema changes, not manual migration files.

---

*Created: 2025-12-12*
*Status: Resolved*

Sources:
- [Drizzle Kit Custom Migrations](https://orm.drizzle.team/docs/kit-custom-migrations)
- [drizzle-kit migrate](https://orm.drizzle.team/docs/drizzle-kit-migrate)
- [drizzle-kit generate](https://orm.drizzle.team/docs/drizzle-kit-generate)
