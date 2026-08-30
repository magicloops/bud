import type { ApiMessage } from './api-types'

/**
 * Typed accessors over `ApiMessage.metadata` for the fields the service
 * stamps on agent-produced rows (design/agent-message-work-duration-contract.md,
 * service transcript-writer). Metadata is an untyped JSONB bag on the wire;
 * everything here degrades to null/defaults on legacy rows — never invent
 * values the service did not write.
 */

/** The only duration source clients may treat as authoritative. */
export const AGENT_MESSAGE_DURATION_SOURCE = 'service_wall_clock'

export type AgentSegmentKind = 'intermediate' | 'final'

export type AgentMessageTiming = {
  startedAtMs: number
  finishedAtMs: number
  durationMs: number
}

const metadataOf = (message: ApiMessage): Record<string, unknown> => message.metadata ?? {}

/** Turn ULID stamped on every agent-produced row (draft and canonical). */
export const getTurnId = (message: ApiMessage): string | null => {
  const value = metadataOf(message).turn_id
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Assistant segmentation: `intermediate` = commentary emitted in a step that
 * also produced tool calls; anything else (including absent, for legacy
 * rows) is `final` — the wire-compat default shared with mobile.
 */
export const getSegmentKind = (message: ApiMessage): AgentSegmentKind =>
  metadataOf(message).segment_kind === 'intermediate' ? 'intermediate' : 'final'

export const isIntermediateAssistantMessage = (message: ApiMessage): boolean =>
  message.role === 'assistant' && getSegmentKind(message) === 'intermediate'

/**
 * Authoritative wall-clock timing for one message. Non-null only when the
 * service stamped `duration_source: "service_wall_clock"` with parseable
 * bounds (proto §SSE: clients must not estimate for legacy rows).
 */
export const getMessageTiming = (message: ApiMessage): AgentMessageTiming | null => {
  const metadata = metadataOf(message)
  if (metadata.duration_source !== AGENT_MESSAGE_DURATION_SOURCE) {
    return null
  }
  const startedAtMs = typeof metadata.started_at === 'string' ? Date.parse(metadata.started_at) : NaN
  const finishedAtMs =
    typeof metadata.finished_at === 'string' ? Date.parse(metadata.finished_at) : NaN
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(finishedAtMs)) {
    return null
  }
  const durationMs =
    typeof metadata.duration_ms === 'number' && Number.isFinite(metadata.duration_ms)
      ? Math.max(0, Math.trunc(metadata.duration_ms))
      : Math.max(0, finishedAtMs - startedAtMs)
  return { startedAtMs, finishedAtMs: Math.max(startedAtMs, finishedAtMs), durationMs }
}

/**
 * Tool name for a `role: "tool"` row: pending rows carry `metadata.tool`;
 * canonical rows carry it in the JSON content payload (and usually in the
 * spread payload metadata too).
 */
export const getToolName = (message: ApiMessage): string | null => {
  if (message.role !== 'tool') {
    return null
  }
  const fromMetadata = metadataOf(message).tool
  if (typeof fromMetadata === 'string' && fromMetadata.length > 0) {
    return fromMetadata
  }
  try {
    const payload = JSON.parse(message.content) as { tool?: unknown }
    return typeof payload.tool === 'string' && payload.tool.length > 0 ? payload.tool : null
  } catch {
    return null
  }
}
