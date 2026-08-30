import type { ApiMessage } from '../../lib/api-types'
import {
  getToolName,
  getTurnId,
  isIntermediateAssistantMessage,
} from '../../lib/agent-message-metadata.ts'
import { computeAgentWorkDurationMs } from '../../lib/agent-work-duration.ts'
import {
  getMessageIdentity,
  isDraftReasoningMessage,
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
  /** Live only: the in-progress step (streaming reasoning draft or pending
   * tool). Null between steps (the model is thinking) and once the run ends. */
  currentItem: ApiMessage | null
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
    return getToolName(message) !== QUESTION_TOOL
  }
  // Draft assistant rows never carry segment_kind, so a streaming answer
  // stays top-level; if it reconciles as intermediate it folds in then.
  return isIntermediateAssistantMessage(message)
}

const isCanonicalFinalAssistant = (message: ApiMessage): boolean =>
  message.role === 'assistant' &&
  message.metadata?.draft !== true &&
  !isIntermediateAssistantMessage(message)

const isInProgressWorkItem = (message: ApiMessage): boolean =>
  isPendingToolMessage(message) || isDraftReasoningMessage(message)

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
    const usedIds = new Map<string, number>()
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
      // A boundary interleaved mid-turn (e.g. a superseding user message)
      // splits the turn into suffixed segments; the first keeps the base id.
      const seen = usedIds.get(base) ?? 0
      usedIds.set(base, seen + 1)
      const id = seen === 0 ? base : `${base}:${seen + 1}`

      const live = accumulator.turnId !== null && accumulator.turnId === liveTurnId
      const status = resolveStatus(accumulator, live, nextBoundary)
      const last = accumulator.messages[accumulator.messages.length - 1]
      const currentItem = live && isInProgressWorkItem(last) ? last : null

      const previous = previousWorkRows.get(id)
      const sourcesUnchanged =
        previous !== undefined &&
        previous.sections.length === accumulator.messages.length &&
        previous.sections.every((section, index) => section.message === accumulator.messages[index])
      if (
        previous &&
        sourcesUnchanged &&
        previous.live === live &&
        previous.status === status &&
        previous.currentItem === currentItem
      ) {
        nextWorkRows.set(id, previous)
        rows.push(previous)
        return
      }

      const row: TimelineWorkRow = {
        kind: 'work',
        id,
        turnId: accumulator.turnId,
        sections: accumulator.messages.map((message) => ({
          kind: isIntermediateAssistantMessage(message) ? 'intermediate' : 'activity',
          message,
        })),
        sourceClientIds: accumulator.messages.map(getMessageIdentity),
        live,
        currentItem,
        status,
        durationMs: live
          ? null
          : sourcesUnchanged && previous && !previous.live
            ? previous.durationMs
            : computeAgentWorkDurationMs(accumulator.messages),
      }
      nextWorkRows.set(id, row)
      rows.push(row)
    }

    for (const message of messages) {
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
