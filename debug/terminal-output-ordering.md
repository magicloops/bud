# Debug: Terminal Output Ordering Issues

**Date:** 2025-12-02
**Branch:** `adam/interactive-sessions`
**Status:** 🔍 Investigating

## Symptom

After sending a message, when the terminal is refreshed, the last terminal command appears above a bunch of other commands. The output ordering appears broken.

## Hypothesis

Possible causes:
1. Rows saved without proper `byte_offset` values (NULL or 0)
2. `seq` numbers not correlating with `byte_offset`
3. UI fetching output ordered incorrectly
4. Multiple sessions/reconnects causing overlapping sequences
5. `tailOutput()` query returning wrong order

## Investigation

### Step 1: Query the Database

Run the debug script to analyze the `terminal_output` table:

```bash
cd service && npx tsx ../debug/query-terminal-output.ts
```

This will show:
- All buds with terminal output
- Recent rows and their ordering by `created_at`, `seq`, `byte_offset`
- Rows with NULL or zero `byte_offset`
- Out-of-order sequences
- Byte offset gaps
- Duplicate entries

### Step 2: Check Code Paths

#### How `byte_offset` is set

**Bud side (`bud/src/main.rs:1167-1179`):**
```rust
let seq_no = seq.fetch_add(1, Ordering::SeqCst);
let payload = json!({
    "proto": TERMINAL_PROTO_VERSION,
    "type": "terminal_output",
    "id": new_message_id(),
    "ts": now_millis(),
    "ext": {},
    "seq": seq_no,
    "data": BASE64_STANDARD.encode(&buf),
    "byte_offset": current_offset,  // <-- File offset at read time
});
// ...
offset.store(size, Ordering::SeqCst);  // Update after send
```

The `byte_offset` is the file offset at which the chunk was read. After reading, the offset is updated to the new file size.

**Service side (`service/src/runtime/terminal-manager.ts:254-258`):**
```typescript
await db.insert(terminalOutputTable).values({
  budId,
  seq: payload.seq,
  data: toStore,
  byteOffset: payload.byte_offset  // <-- From Bud
});
```

#### How `tailOutput()` queries data

**Current implementation (`service/src/runtime/terminal-manager.ts:360-438`):**

Two modes:
1. **With `sinceOffset`:** Ordered by `byte_offset ASC`
2. **Without `sinceOffset`:** Ordered by `seq DESC`, then reversed

```typescript
// With sinceOffset
.orderBy(asc(terminalOutputTable.byteOffset))

// Without sinceOffset (default)
.orderBy(desc(terminalOutputTable.seq))
// ...
buffers.reverse();  // Reverses to chronological order
```

#### How UI fetches history

**Terminal history endpoint** - Need to trace this path.

### Step 3: Check for Known Issues

#### Issue: Reconnection resets sequence numbers

When Bud reconnects after service restart, the `seq` counter starts from 0 but the log file may already have content. This could cause:
- New `seq=0` with high `byte_offset`
- Old `seq=100` with low `byte_offset`

**Check:** Look for rows where `seq` and `byte_offset` don't correlate monotonically.

#### Issue: Multiple terminals/sessions

If multiple terminal sessions exist for the same `budId`, sequences could interleave.

**Check:** Look for gaps or overlaps in `byte_offset` ranges.

#### Issue: Truncation changing stored data

When output exceeds `terminalOutputSoftCapBytes`, data is truncated:
```typescript
const toStore = remaining >= buffer.length ? buffer : buffer.subarray(0, remaining);
```

This means `length(data)` in DB may be less than the original chunk size. If queries assume `byte_offset + length(data)` equals next chunk's offset, there will be gaps.

## Findings

### Likely Root Cause: `seq` vs `byte_offset` Mismatch After Reconnection

**The Problem:**

The default `tailOutput()` query (used for UI history backfill) orders by `seq DESC`:

```typescript
// terminal-manager.ts:408-417
const rows = await db
  .select({ seq, data })
  .from(terminalOutputTable)
  .where(eq(terminalOutputTable.budId, budId))
  .orderBy(desc(terminalOutputTable.seq))  // <-- Problem: seq may not equal chronological order
  .limit(200);
// ...
buffers.reverse();  // Reversing doesn't fix fundamental ordering issue
```

**Why `seq` can be wrong:**

1. Bud connects, `seq` starts at 0, file offset starts at 0
2. Output flows: `seq=0,1,2...100` with `byte_offset=0,100,200...10000`
3. Service restarts or Bud reconnects
4. Bud's `seq` counter resets to 0, but log file already has content
5. New output: `seq=0,1,2...` with `byte_offset=10000,10100...`
6. **Now we have:**
   - Old data: `seq=50-100`, `byte_offset=5000-10000`
   - New data: `seq=0-10`, `byte_offset=10000-11000`

7. `ORDER BY seq DESC` returns: `seq=100,99,98...50,10,9,8...0`
8. After `reverse()`: `seq=0,1,2...10,50,51...100`
9. **But chronologically it should be:** `seq=50...100` (old) then `seq=0...10` (new)

The `seq` number is per-Bud-session, not globally monotonic. After reconnection, sequences restart but file offsets continue from where they left off.

### Verification

Run the debug script and look for:
1. Rows where low `seq` has high `byte_offset` (indicates reconnection)
2. Gaps in `byte_offset` that don't match data lengths (indicates missing data)
3. Multiple rows with same `seq` (should be prevented by primary key)

```bash
cd service && npx tsx ../debug/query-terminal-output.ts
```

### Database Analysis (2025-12-03)

```
Buds with terminal output:
┌─────────┬────────────────────────────────┬───────────┐
│ (index) │ bud_id                         │ row_count │
├─────────┼────────────────────────────────┼───────────┤
│ 0       │ 'b_01K9XX1BMTHW3WHF2D3PAWS3AP' │ '144'     │
└─────────┴────────────────────────────────┴───────────┘

Stats:
- min_seq: 0, max_seq: 143
- min_offset: 0, max_offset: 51580
- total_data_bytes stored: 38,820
- earliest: 2025-11-30, latest: 2025-11-30 (4 DAYS AGO!)

BUD TERMINAL STATE:
- output_log_bytes: 1,675 (counter)
- total_output_bytes: 1,675
- last_output_at: 2025-12-03T06:54:57 (TODAY)
```

### Key Finding: Data Not Being Stored!

**The terminal_output table has no new data since 2025-11-30, but `last_output_at` shows activity today (2025-12-03).**

This means `handleTerminalOutput()` is being called (updating `last_output_at`), but data is NOT being inserted into `terminal_output`.

**Why?** Looking at the code:

```typescript
const remaining = Math.max(config.terminalOutputSoftCapBytes - currentLogBytes, 0);
const toStore = remaining >= buffer.length ? buffer : buffer.subarray(0, remaining);
if (toStore.length > 0) {
  await db.insert(terminalOutputTable).values({...});
}
```

The `remaining` calculation depends on `currentLogBytes` from `bud_terminal.output_log_bytes`.

**The counter mismatch:**
- `bud_terminal.output_log_bytes`: 1,675 bytes
- `terminal_output` actual stored: 38,820 bytes

This is inverted! The counter should be >= actual stored. But it's much smaller.

**Root cause hypothesis:** The `output_log_bytes` counter was RESET at some point (maybe during migration, manual DB edit, or code bug), but the `terminal_output` data wasn't cleared. Now:
1. Counter says 1,675 bytes stored
2. Actually 38,820 bytes in DB
3. New data comes in, counter gets incremented to small values
4. But... wait, if counter is 1,675, remaining should be ~100MB - 1,675 = huge, so data SHOULD be stored

Let me re-examine: Actually the issue might be the **seq conflict**. Look at line 263-265:
```typescript
.onConflictDoNothing({
  target: [terminalOutputTable.budId, terminalOutputTable.seq]
});
```

After Bud reconnects, `seq` starts at 0 again. If `seq=0` already exists in DB, the insert is silently dropped!

**This is the bug!** The primary key is `(bud_id, seq)`, and `onConflictDoNothing` silently drops new data when seq collides with existing data from a previous session.

## Root Cause: Dual Bug

### Bug 1: `seq` collision after reconnection

When Bud reconnects:
1. Bud's `seq` counter resets to 0
2. Old data in DB has `seq` 0-143
3. New data tries to insert with `seq` 0, 1, 2...
4. `onConflictDoNothing` silently drops ALL new data
5. No terminal output is stored after reconnection

### Bug 2: Ordering by `seq` instead of `byte_offset`

Even if data was stored, ordering by `seq` would be wrong after reconnection (see earlier analysis).

## Recommended Fix

### Fix 1: Use `byte_offset` as part of primary key (or as unique key)

Change from `(bud_id, seq)` to `(bud_id, byte_offset)` since byte_offset is truly unique and monotonic.

Or: Use upsert with `byte_offset` check instead of `onConflictDoNothing`.

### Fix 2: Change the default ordering from `seq` to `byte_offset`:

```typescript
// terminal-manager.ts - tailOutput default behavior
const rows = await db
  .select({
    seq: terminalOutputTable.seq,
    data: terminalOutputTable.data,
    byteOffset: terminalOutputTable.byteOffset
  })
  .from(terminalOutputTable)
  .where(eq(terminalOutputTable.budId, budId))
  .orderBy(desc(terminalOutputTable.byteOffset))  // <-- Use byte_offset, not seq
  .limit(200);
```

**Why `byte_offset` is correct:**
- `byte_offset` comes from the actual file position in Bud
- It's monotonically increasing (file only grows)
- Even after reconnection, new data has higher offset than old
- It represents true chronological order

**Alternative fix - use `created_at`:**
```typescript
.orderBy(desc(terminalOutputTable.createdAt))
```

But `byte_offset` is more reliable since it's set by Bud based on actual file position, while `created_at` is set by the service and could have clock skew issues.

## Implementation

**Status: ✅ FIXED (2025-12-03)**

### Changes Made

1. **Schema change** (`service/src/db/schema.ts`):
   - Changed primary key from `(bud_id, seq)` to `(bud_id, byte_offset)`
   - Added index on `(bud_id, seq)` for backwards compatibility

2. **Terminal manager** (`service/src/runtime/terminal-manager.ts`):
   - `handleTerminalOutput()`: Changed `onConflictDoNothing` target from `seq` to `byte_offset`
   - `tailOutput()`: Changed ordering from `seq DESC` to `byte_offset DESC`

3. **Migration** (`service/drizzle/migrations/0005_terminal_output_pk_byte_offset.sql`):
   - Drops old PK constraint on `(bud_id, seq)`
   - Adds new PK constraint on `(bud_id, byte_offset)`
   - Adds index on `(bud_id, seq)` for backwards compat

### To Apply

```bash
cd service && npx drizzle-kit migrate
```

Or manually run the SQL in `0005_terminal_output_pk_byte_offset.sql`.

## Related Files

| File | Purpose |
|------|---------|
| `bud/src/main.rs:1142-1203` | Bud output watcher, sends `terminal_output` frames |
| `service/src/runtime/terminal-manager.ts:233-280` | Handles `terminal_output`, stores in DB |
| `service/src/runtime/terminal-manager.ts:360-438` | `tailOutput()` query |
| `service/src/routes/terminals.ts` | REST endpoints for terminal |
| `service/src/db/schema.ts:276-292` | `terminal_output` table schema |
| `debug/query-terminal-output.ts` | Debug query script |
