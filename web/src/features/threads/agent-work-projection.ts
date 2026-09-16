import { isFinalAssistantMessage } from './assistant-activity-indicator-state.ts'
import type { ApiMessage } from '../../lib/api-types'
import {
  getToolName,
  getTurnId,
  isIntermediateAssistantMessage,
} from '../../lib/agent-message-metadata.ts'
import { computeAgentWorkDurationMs } from '../../lib/agent-work-duration.ts'
import {
  getMessageIdentity,
  isPendingToolMessage,
} from './thread-message-state.ts'

/**
 * Agent-work projection (design/web-agent-work-collapse.md, Option B).
 *
 * Pure presentation: raw messages are grouped, never mutated. One work group
 * per turn collects reasoning, tool calls, and intermediate assistant text;
 * user/system/final-assistant/user-question/unknown rows stay top-level and
 * flush the group. Group identity is `agent-work:<turn_id>` — stable across
 * streaming, draft→canonical reconciliation, and history prepends (the two
 * halves of a page-split turn merge under the same id). Legacy rows without
 * `turn_id` group by contiguity under a first-member-derived id.
 */

/** User-question rows keep their standalone card treatment (mobile parity). */
const QUESTION_TOOL = 'ask_user_questions'

export type TimelineWorkSection = {
  /** `intermediate`: assistant commentary separating activity; `activity`: reasoning/tool. */
  kind: 'intermediate' | 'activity'
  sectionId?: string
  message: ApiMessage
}

export type WorkRowStatus = 'ok' | 'failed' | 'canceled' | 'no_final'

export type TimelineWorkRow = {
  kind: 'work'
  id: string
  turnId: string | null
  sections: TimelineWorkSection[]
  sourceClientIds: string[]
  /** True while this turn is the thread's active run. */
  live: boolean
  /** Presentation completion is independent of execution activity. */
  canFold: boolean
  /** Live groups report 'ok'; it is meaningful only once the run ended. */
  status: WorkRowStatus
  /** Authoritative work duration; null while live or without trustworthy metadata. */
  durationMs: number | null
}

export type TimelineMessageRow = {
  kind: 'message'
  message: ApiMessage
}

export type TimelineRow = TimelineMessageRow | TimelineWorkRow

export type TurnOutcome = 'succeeded' | 'failed' | 'canceled'

export type ProjectTimelineInput = {
  /** Chronologically sorted messages (the thread store's invariant). */
  messages: ApiMessage[]
  /** `agentState.active ? agentState.turn_id : null`, cleared by `final`. */
  liveTurnId: string | null
  /** Session-local outcomes from `final` events (no persisted run status exists). */
  turnOutcomes?: ReadonlyMap<string, TurnOutcome>
}

const isWorkMessage = (message: ApiMessage): boolean => {
  if (message.role === 'reasoning') {
    return true
  }
  if (message.role === 'tool') {
    const tool = getToolName(message)
    if (tool === QUESTION_TOOL) return false
    const approval = message.metadata?.wait_kind === 'return_control' || tool === 'browser_request_handoff' || tool === 'data_request_api_key' || tool === 'automations_request_activation' || tool === 'automations_request_existing_contacts'
    // Human decisions must remain visible while pending. Once reconciled with
    // their canonical result, approvals are ordinary work in the same turn.
    return !approval || !isPendingToolMessage(message)
  }
  // Draft assistant rows never carry segment_kind, so a streaming answer
  // stays top-level; if it reconciles as intermediate it folds in then.
  return isIntermediateAssistantMessage(message)
}

const isCanonicalFinalAssistant = (message: ApiMessage): boolean =>
  isFinalAssistantMessage(message) &&
  message.metadata?.draft !== true && message.content.trim().length > 0

type GroupAccumulator = {
  turnId: string | null
  messages: ApiMessage[]
}

const sameGroup = (group: GroupAccumulator, turnId: string | null): boolean =>
  group.turnId === null ? turnId === null : group.turnId === turnId

export const projectTimeline = (input: ProjectTimelineInput): TimelineRow[] =>
  createTimelineProjector()(input)

/**
 * Stateful wrapper around one pure projection pass: reuses previous row
 * OBJECTS when a row's inputs are identical, so memoized React rows skip
 * re-rendering when an unrelated message streams. Create one per timeline.
 */
export const createTimelineProjector = () => {
  let previousWorkRows = new Map<string, TimelineWorkRow>()
  let previousMessageRows = new Map<string, TimelineMessageRow>()

  return (input: ProjectTimelineInput): TimelineRow[] => {
    const { messages, liveTurnId } = input
    const turnOutcomes = input.turnOutcomes ?? new Map<string, TurnOutcome>()

    // Turns with a canonical final answer anywhere in the loaded window.
    const finalTurnIds = new Set<string>()
    for (const message of messages) {
      if (isCanonicalFinalAssistant(message)) {
        const turnId = getTurnId(message)
        if (turnId) {
          finalTurnIds.add(turnId)
        }
      }
    }

    const rows: TimelineRow[] = []
    const nextWorkRows = new Map<string, TimelineWorkRow>()
    const nextMessageRows = new Map<string, TimelineMessageRow>()
    const usedIds = new Set<string>()
    const usedSectionIds = new Set<string>()
    const previousBySource = new Map<string, TimelineWorkRow>()
    const previousActivityIds = new Map<string, string>()
    for (const row of previousWorkRows.values()) for (const section of row.sections) {
      previousBySource.set(section.message.client_id, row)
      if (section.sectionId) previousActivityIds.set(section.message.client_id, section.sectionId)
    }
    let group: GroupAccumulator | null = null

    const messageRow = (message: ApiMessage): TimelineMessageRow => {
      const identity = getMessageIdentity(message)
      const previous = previousMessageRows.get(identity)
      const row = previous && previous.message === message ? previous : { kind: 'message' as const, message }
      nextMessageRows.set(identity, row)
      return row
    }

    const resolveStatus = (
      accumulator: GroupAccumulator,
      live: boolean,
      nextBoundary: ApiMessage | null,
    ): WorkRowStatus => {
      if (live) {
        return 'ok'
      }
      const outcome = accumulator.turnId ? turnOutcomes.get(accumulator.turnId) : undefined
      if (outcome === 'failed') {
        return 'failed'
      }
      if (outcome === 'canceled') {
        return 'canceled'
      }
      if (accumulator.turnId) {
        return finalTurnIds.has(accumulator.turnId) ? 'ok' : 'no_final'
      }
      // Legacy rows: the immediately following top-level row being a final
      // assistant is the only signal available.
      return nextBoundary && isCanonicalFinalAssistant(nextBoundary) ? 'ok' : 'no_final'
    }

    const flushGroup = (nextBoundary: ApiMessage | null) => {
      if (!group) {
        return
      }
      const accumulator = group
      group = null

      const base = accumulator.turnId
        ? `agent-work:${accumulator.turnId}`
        : `agent-work:legacy:${getMessageIdentity(accumulator.messages[0])}`
      const overlaps = new Map<TimelineWorkRow, number>()
      for (const message of accumulator.messages) {
        const previous = previousBySource.get(message.client_id)
        if (previous && !usedIds.has(previous.id)) overlaps.set(previous, (overlaps.get(previous) ?? 0) + 1)
      }
      const match = [...overlaps].sort((a, b) => b[1] - a[1])[0]?.[0]
      const id = match?.id ?? (!usedIds.has(base) && !previousWorkRows.has(base)
        ? base : `${base}:${accumulator.messages[0].client_id}`)
      usedIds.add(id)

      const live = accumulator.turnId !== null && accumulator.turnId === liveTurnId
      const status = resolveStatus(accumulator, live, nextBoundary)
      const canFold = accumulator.turnId !== null
        ? finalTurnIds.has(accumulator.turnId)
        : Boolean(nextBoundary && isCanonicalFinalAssistant(nextBoundary))
      const previous = previousWorkRows.get(id)
      const sourcesUnchanged =
        previous !== undefined &&
        previous.sections.length === accumulator.messages.length &&
        previous.sections.every((section, index) => section.message === accumulator.messages[index])
      if (
        previous &&
        sourcesUnchanged &&
        previous.live === live &&
        previous.canFold === canFold &&
        previous.status === status
      ) {
        for (const section of previous.sections) if (section.sectionId) usedSectionIds.add(section.sectionId)
        nextWorkRows.set(id, previous)
        rows.push(previous)
        return
      }

      const sections: TimelineWorkSection[] = accumulator.messages.map(message => ({
        kind: isIntermediateAssistantMessage(message) ? 'intermediate' : 'activity', message,
      }))
      for (let index = 0; index < sections.length;) {
        if (sections[index].kind !== 'activity') { index += 1; continue }
        let end = index + 1
        while (end < sections.length && sections[end].kind === 'activity') end += 1
        const segment = sections.slice(index, end)
        const sectionId = segment.map(section => previousActivityIds.get(section.message.client_id)).find(id => id && !usedSectionIds.has(id))
          ?? `activity:${sections[index].message.client_id}`
        usedSectionIds.add(sectionId)
        for (const section of segment) section.sectionId = sectionId
        index = end
      }
      const row: TimelineWorkRow = {
        kind: 'work',
        id,
        turnId: accumulator.turnId,
        sections,
        sourceClientIds: accumulator.messages.map(getMessageIdentity),
        live,
        canFold,
        status,
        durationMs: live && !canFold
          ? null
          : sourcesUnchanged && previous && !previous.live
            ? previous.durationMs
            : computeAgentWorkDurationMs(accumulator.messages),
      }
      nextWorkRows.set(id, row)
      rows.push(row)
    }

    for (const message of messages) {
      if (message.role === 'assistant' && !message.content.trim()) continue
      if (isWorkMessage(message)) {
        const turnId = getTurnId(message)
        if (group && sameGroup(group, turnId)) {
          group.messages.push(message)
        } else {
          flushGroup(null)
          group = { turnId, messages: [message] }
        }
      } else {
        flushGroup(message)
        rows.push(messageRow(message))
      }
    }
    flushGroup(null)

    previousWorkRows = nextWorkRows
    previousMessageRows = nextMessageRows
    return rows
  }
}

const segmentCache = new WeakMap<TimelineWorkRow, TimelineWorkSection[][]>()

export function workSegments(row: TimelineWorkRow): TimelineWorkSection[][] {
  const cached = segmentCache.get(row)
  if (cached) return cached
  const segments: TimelineWorkSection[][] = []
  for (const section of row.sections) {
    if (section.kind === 'intermediate' && !section.message.content.trim()) continue
    const last = segments.at(-1)
    if (section.kind === 'activity' && last?.[0].kind === 'activity') last.push(section)
    else segments.push([section])
  }
  segmentCache.set(row, segments)
  return segments
}
