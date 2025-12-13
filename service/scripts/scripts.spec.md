# scripts

Standalone utility scripts for querying and debugging.

## Purpose

Command-line tools for inspecting data outside the main service. Useful for debugging and ad-hoc queries.

## Files

### `query-messages.ts`

Query messages for a thread.

**Usage**:
```bash
npx tsx scripts/query-messages.ts <thread-id>
```

**Output**: Lists messages with role, timestamp, and content preview.

### `query-terminal-output.ts`

Query terminal session output history.

**Usage**:
```bash
npx tsx scripts/query-terminal-output.ts <session-id> [options]
```

**Options**:
- `--bytes <n>` - Limit output bytes
- `--since <offset>` - Start from byte offset
- `--raw` - Output raw bytes (no formatting)

**Output**: Terminal output with byte offsets and timestamps.

## Dependencies

| Import | Purpose |
|--------|---------|
| `../src/db/client.js` | Database connection |
| `../src/db/schema.js` | Table definitions |
| `drizzle-orm` | Query helpers |

## Note

These scripts are in `service/scripts/` (top-level), separate from `service/src/scripts/` (internal utilities).

---

*Referenced by: [../service.spec.md](../service.spec.md)*
