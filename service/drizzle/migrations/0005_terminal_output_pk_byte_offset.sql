-- Migration: Change terminal_output primary key from (bud_id, seq) to (bud_id, byte_offset)
--
-- Rationale:
-- - seq resets to 0 when Bud reconnects, causing silent data loss via onConflictDoNothing
-- - byte_offset is the file position and is monotonically increasing, never collides
-- - This ensures output is stored correctly across Bud reconnections
--
-- See: debug/terminal-output-ordering.md for full investigation

-- Step 1: Drop the old primary key constraint
ALTER TABLE terminal_output DROP CONSTRAINT terminal_output_pkey;

-- Step 2: Add the new primary key on (bud_id, byte_offset)
ALTER TABLE terminal_output ADD CONSTRAINT terminal_output_pkey PRIMARY KEY (bud_id, byte_offset);

-- Step 3: Drop the old byte_offset index (now redundant since it's part of PK)
DROP INDEX IF EXISTS terminal_output_offset_idx;

-- Step 4: Add index on seq for backwards compatibility queries (if any)
CREATE INDEX IF NOT EXISTS terminal_output_seq_idx ON terminal_output (bud_id, seq);
