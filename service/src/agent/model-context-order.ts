import { sql } from "drizzle-orm";
import { messageTable } from "../db/schema.js";

// Match the actual admission row, not client-supplied transcript metadata.
const isInvocationInput = sql`exists (select 1 from agent_invocation context_inv
  where context_inv.input_message_id = message.message_id
    and context_inv.thread_id = message.thread_id
    and context_inv.created_by_user_id = message.created_by_user_id)`;

export const modelContextMessageVisible = sql`(not (${isInvocationInput}) or
  ${messageTable.metadata}->>'model_context_at' is not null)`;

export const modelContextMessageCreatedAt = sql<Date>`case when ${isInvocationInput}
  then (${messageTable.metadata}->>'model_context_at')::timestamptz
  else ${messageTable.createdAt} end`.mapWith(messageTable.createdAt);
