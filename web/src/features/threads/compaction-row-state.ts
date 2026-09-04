import type { ApiAgentCompactionPhase, ApiMessage } from '../../lib/api-types.ts'

/** Presentation for a `role: "compaction"` transcript row (plan/durable-compaction-transcript-rows.md). */
export type CompactionRowPresentation = {
  /** Pill text, e.g. "Context compacted". */
  label: string
  /** e.g. "Mid-turn · 245k → 12k" (phase always; tokens when known). */
  detail: string
  /** The summary the model now carries; empty when the checkpoint had none. */
  summary: string
  checkpointId: string | null
  compactedThroughMessageId: string | null
}

export const isCompactionMessage = (message: Pick<ApiMessage, 'role'>): boolean =>
  message.role === 'compaction'

export function getCompactionRowPresentation(message: ApiMessage): CompactionRowPresentation {
  const metadata = (message.metadata ?? {}) as Record<string, unknown>
  const phase = typeof metadata.phase === 'string' ? formatCompactionPhase(metadata.phase) : null
  const tokensBefore = typeof metadata.tokens_before === 'number' ? metadata.tokens_before : null
  const tokensAfter = typeof metadata.tokens_after === 'number' ? metadata.tokens_after : null
  const tokens =
    tokensBefore !== null && tokensAfter !== null
      ? `${formatCompactTokens(tokensBefore)} → ${formatCompactTokens(tokensAfter)}`
      : null
  return {
    label: message.display_role || 'Context compacted',
    detail: [phase, tokens].filter((part): part is string => Boolean(part)).join(' · '),
    summary: message.content.trim(),
    checkpointId: typeof metadata.checkpoint_id === 'string' ? metadata.checkpoint_id : null,
    compactedThroughMessageId:
      typeof metadata.compacted_through_message_id === 'string' ? metadata.compacted_through_message_id : null,
  }
}

export function formatCompactionPhase(phase: ApiAgentCompactionPhase | string): string {
  switch (phase) {
    case 'pre_turn':
      return 'Pre-turn'
    case 'mid_turn':
      return 'Mid-turn'
    case 'standalone_turn':
      return 'Standalone'
    default:
      return phase
  }
}

export function formatCompactTokens(value: number): string {
  const absolute = Math.abs(value)
  if (absolute >= 1_000_000) {
    return `${Math.round(value / 100_000) / 10}m`
  }
  if (absolute >= 1_000) {
    return `${Math.round(value / 1_000)}k`
  }
  return String(Math.round(value))
}
