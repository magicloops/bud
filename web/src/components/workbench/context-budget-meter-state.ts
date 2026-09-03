import type { ApiContextBreakdownKind, ApiContextBudget, ApiContextBudgetBreakdownEntry } from '@/lib/api-types'
import { BUD_ACCENT_GRAY, DEFAULT_AVATAR_COLORS } from '../../lib/theme-colors.ts'

export type ContextBudgetMeterTone = 'normal' | 'elevated' | 'near' | 'over' | 'unknown'

// Legend colors come from the bud accent palette so every category gets a
// distinct hue that is the same on every bud (not shades of the selected
// accent). Minor categories share gray.
const [PINK, ORANGE, CYAN, PURPLE, GREEN] = DEFAULT_AVATAR_COLORS as [string, string, string, string, string]

/** Category → color, shared by the context popover and the model view. */
export const CONTEXT_CATEGORY_COLORS = {
  tool_output: CYAN,
  messages: PINK,
  system_prompt: PURPLE,
  tool_calls: ORANGE,
  reasoning: GREEN,
  compaction_summary: BUD_ACCENT_GRAY,
  tool_schemas: BUD_ACCENT_GRAY,
  images: BUD_ACCENT_GRAY,
  other: BUD_ACCENT_GRAY,
} as const

export type ContextBudgetMeterRow = {
  id: string
  label: string
  tokens: number
  tokensLabel: string
  /** Share of estimated input, 0..1. */
  percent: number
  percentLabel: string
  /** CSS color for the bar segment and legend swatch. */
  color: string
}

export type ContextBudgetMeterPresentation = {
  tone: ContextBudgetMeterTone
  percent: number | null
  percentLabel: string
  compactLabel: string
  /** Screen-reader / aria summary; same text as the popover headline. */
  title: string
  headline: string
  subline: string | null
  /** Sorted largest first; drives both the segmented bar and the legend. */
  rows: ContextBudgetMeterRow[]
  /** Quiet trailing lines: basis / measured usage, compaction count, output reserve. */
  footer: string[]
  /** Policy + provenance details, only rendered behind a debug disclosure. */
  diagnostics: string[]
}

type PresentationOptions = {
  /** Catalog display name for the budget's model; falls back to the model id. */
  modelLabel?: string | null
}

type RowGroup = {
  id: string
  label: string
  kinds: ApiContextBreakdownKind[]
  color: string
}

// Display groups over the API categories. Order only matters for ties.
const ROW_GROUPS: RowGroup[] = [
  { id: 'tool_output', label: 'Tool output', kinds: ['tool_output'], color: CONTEXT_CATEGORY_COLORS.tool_output },
  { id: 'messages', label: 'Messages', kinds: ['user_messages', 'assistant_text'], color: CONTEXT_CATEGORY_COLORS.messages },
  { id: 'system_prompt', label: 'System prompt', kinds: ['system_prompt', 'runtime_instructions'], color: CONTEXT_CATEGORY_COLORS.system_prompt },
  { id: 'tool_calls', label: 'Tool calls', kinds: ['tool_calls'], color: CONTEXT_CATEGORY_COLORS.tool_calls },
  { id: 'reasoning', label: 'Reasoning', kinds: ['reasoning'], color: CONTEXT_CATEGORY_COLORS.reasoning },
  { id: 'compaction_summary', label: 'Compaction summary', kinds: ['compaction_summary'], color: CONTEXT_CATEGORY_COLORS.compaction_summary },
  { id: 'tool_schemas', label: 'Tool schemas', kinds: ['tool_schemas'], color: CONTEXT_CATEGORY_COLORS.tool_schemas },
  { id: 'images', label: 'Images', kinds: ['images'], color: CONTEXT_CATEGORY_COLORS.images },
]

/** Rows below this share collapse into "Other" so the legend stays short. */
const OTHER_ROW_THRESHOLD = 0.005

export function getContextBudgetMeterPresentation(
  budget: ApiContextBudget | null | undefined,
  options: PresentationOptions = {},
): ContextBudgetMeterPresentation {
  const modelLabel = options.modelLabel?.trim() || budget?.model || 'Current model'

  if (!budget || budget.status === 'unknown') {
    const reason = budget?.status === 'unknown' ? formatUnknownReason(budget.reason) : 'No budget snapshot'
    const headline = `${modelLabel}: context unavailable`
    return {
      tone: 'unknown',
      percent: null,
      percentLabel: '--',
      compactLabel: 'Context --',
      title: headline,
      headline,
      subline: null,
      rows: [],
      footer: [reason, ...(budget?.stale ? ['Refreshing after the current turn settles.'] : [])],
      diagnostics: [],
    }
  }

  const percent = Math.max(0, budget.percent_of_context_budget)
  const tone = getBudgetTone(percent)
  const percentLabel = formatPercent(percent)
  const visualLimit = budget.compaction_enabled ? 'auto-compact limit' : 'usable input window'
  const headline = `${modelLabel} · ${percentLabel} of ${visualLimit}${budget.stale ? ' · Refreshing…' : ''}`
  const used = formatRoundedTokenCount(budget.estimated_input_tokens)
  const limit = formatRoundedTokenCount(budget.effective_budget_tokens)
  const window = formatRoundedTokenCount(budget.usable_input_window_tokens)
  const subline = budget.compaction_enabled
    ? `${used} of ${limit} · compacts at ${Math.round(budget.compaction_threshold_ratio * 100)}% of the ${window} window`
    : `${used} of ${limit} · ${window} window`

  return {
    tone,
    percent,
    percentLabel,
    compactLabel: `Context ${percentLabel}`,
    title: headline,
    headline,
    subline,
    rows: buildRows(budget),
    footer: buildFooter(budget),
    diagnostics: [
      `Bud cap ${formatRoundedTokenCount(budget.usable_context_window_tokens)}, output reserve ${formatRoundedTokenCount(budget.reserved_output_tokens)}.`,
      `Usable input window ${formatRoundedTokenCount(budget.usable_input_window_tokens)}, hard model window ${formatRoundedTokenCount(budget.context_window_tokens)}.`,
      `Messages ${formatRoundedTokenCount(budget.message_estimated_tokens)}, tool schemas ${formatRoundedTokenCount(budget.tool_schema_tokens)}.`,
      `Basis ${formatEstimateBasis(budget.basis)}, ${budget.confidence} confidence.`,
      `Source ${formatSnapshotSource(budget.source)}${budget.phase ? ` (${formatSnapshotPhase(budget.phase)})` : ''}.`,
    ],
  }
}

function buildRows(budget: Extract<ApiContextBudget, { status: 'available' }>): ContextBudgetMeterRow[] {
  const total = Math.max(0, budget.estimated_input_tokens)
  const byKind = new Map<ApiContextBreakdownKind, number>()
  const breakdown: ApiContextBudgetBreakdownEntry[] | undefined = budget.breakdown
  if (breakdown && breakdown.length > 0) {
    for (const entry of breakdown) {
      byKind.set(entry.kind, (byKind.get(entry.kind) ?? 0) + Math.max(0, entry.tokens))
    }
  } else {
    // Older service without a breakdown: the only split it reports.
    byKind.set('user_messages', Math.max(0, budget.message_estimated_tokens))
    byKind.set('tool_schemas', Math.max(0, budget.tool_schema_tokens))
  }

  const rows: ContextBudgetMeterRow[] = []
  let otherTokens = 0
  for (const group of ROW_GROUPS) {
    const tokens = group.kinds.reduce((sum, kind) => sum + (byKind.get(kind) ?? 0), 0)
    if (tokens <= 0) continue
    const share = total > 0 ? tokens / total : 0
    if (share < OTHER_ROW_THRESHOLD) {
      otherTokens += tokens
      continue
    }
    rows.push(makeRow(group.id, group.label, tokens, share, group.color))
  }
  if (otherTokens > 0) {
    rows.push(makeRow('other', 'Other', otherTokens, total > 0 ? otherTokens / total : 0, CONTEXT_CATEGORY_COLORS.other))
  }
  rows.sort((a, b) => b.tokens - a.tokens)
  return rows
}

function makeRow(
  id: string,
  label: string,
  tokens: number,
  percent: number,
  color: string,
): ContextBudgetMeterRow {
  return {
    id,
    label,
    tokens,
    tokensLabel: formatRoundedTokenCount(tokens),
    percent,
    percentLabel: formatSharePercent(percent),
    color,
  }
}

function buildFooter(budget: Extract<ApiContextBudget, { status: 'available' }>): string[] {
  const basis =
    budget.basis === 'provider_token_count'
      ? 'Measured by provider'
      : budget.basis === 'provider_usage_trigger'
        ? 'Provider usage'
        : 'Estimated (~4 chars/token)'
  const measured = budget.provider_usage_estimate
    ? ` · last request ${formatRoundedTokenCount(budget.provider_usage_estimate.input_tokens)} in / ${formatRoundedTokenCount(budget.provider_usage_estimate.output_tokens)} out`
    : ''

  const secondLine: string[] = []
  if (typeof budget.compaction_count === 'number' && budget.compaction_count > 0) {
    secondLine.push(`Compacted ${budget.compaction_count}×`)
  } else if (budget.compaction_count == null && budget.latest_checkpoint_id) {
    secondLine.push('Compacted earlier')
  }
  secondLine.push(`${formatRoundedTokenCount(budget.reserved_output_tokens)} reserved for the reply`)

  return [`${basis}${measured}`, secondLine.join(' · ')]
}

export function formatRoundedTokenCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return '--'
  }
  if (value < 1_000) {
    return String(Math.round(value))
  }
  if (value < 10_000) {
    return `${roundToSingleDecimal(value / 1_000)}k`
  }
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000)}k`
  }
  if (value < 10_000_000) {
    return `${roundToSingleDecimal(value / 1_000_000)}m`
  }
  return `${Math.round(value / 1_000_000)}m`
}

export function getContextBudgetRingProgress(
  presentation: Pick<ContextBudgetMeterPresentation, 'percent'>,
): number {
  if (presentation.percent === null || !Number.isFinite(presentation.percent)) {
    return 0
  }
  return Math.max(0, Math.min(100, presentation.percent * 100))
}

function getBudgetTone(percent: number): ContextBudgetMeterTone {
  if (percent >= 1) {
    return 'over'
  }
  if (percent >= 0.85) {
    return 'near'
  }
  if (percent >= 0.7) {
    return 'elevated'
  }
  return 'normal'
}

function formatPercent(value: number): string {
  return `${Math.min(999, Math.round(value * 100))}%`
}

function formatSharePercent(value: number): string {
  if (value > 0 && value < 0.01) {
    return '<1%'
  }
  return `${Math.round(value * 100)}%`
}

function formatUnknownReason(reason: Extract<ApiContextBudget, { status: 'unknown' }>['reason']): string {
  switch (reason) {
    case 'unknown_model_context_window':
      return 'Context window metadata is missing for this model.'
    case 'invalid_context_policy':
      return 'Context policy metadata is invalid for this model.'
    case 'conversation_unavailable':
      return 'Conversation state is unavailable.'
    case 'count_failed':
      return 'Budget count failed.'
  }
}

function formatEstimateBasis(basis: Extract<ApiContextBudget, { status: 'available' }>['basis']): string {
  switch (basis) {
    case 'model_agnostic_estimate':
      return 'backend estimate'
    case 'provider_usage_trigger':
      return 'provider usage trigger'
    case 'provider_token_count':
      return 'provider token count'
  }
}

function formatSnapshotSource(source: Extract<ApiContextBudget, { status: 'available' }>['source']): string {
  switch (source) {
    case 'durable_reconstruction':
      return 'durable reconstruction'
    case 'active_agent_decision':
      return 'active agent decision'
    case 'compaction_event':
      return 'post-compaction snapshot'
    case 'unknown':
      return 'unknown'
  }
}

function formatSnapshotPhase(phase: NonNullable<Extract<ApiContextBudget, { status: 'available' }>['phase']>): string {
  switch (phase) {
    case 'idle':
      return 'idle'
    case 'pre_turn':
      return 'pre-turn'
    case 'mid_turn':
      return 'mid-turn'
    case 'standalone_turn':
      return 'standalone turn'
  }
}

function roundToSingleDecimal(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}
