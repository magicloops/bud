import type { Invocation } from "./invocation-repository.js";

export function serializeInvocation(row: Invocation) {
  return { invocation_id: row.id, turn_id: row.turnId, input_message_id: row.inputMessageId,
    origin: row.origin, status: row.status, model: row.model, reasoning_effort: row.reasoningEffort,
    reserves_thread: row.reservesThread, attempt: row.attempt, outcome_code: row.outcomeCode,
    latest_start_at: row.latestStartAt, next_attempt_at: row.nextAttemptAt,
    cancel_requested_at: row.cancelRequestedAt, created_at: row.createdAt, updated_at: row.updatedAt };
}
