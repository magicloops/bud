import type { ApiContextBudget } from '@/lib/api-types'

export type ContextBudgetMeterTone = 'normal' | 'elevated' | 'near' | 'over' | 'unknown'

export type ContextBudgetMeterPresentation = {
  tone: ContextBudgetMeterTone
  percent: number | null
  percentLabel: string
  compactLabel: string
  title: string
  detailLines: string[]
}

export function getContextBudgetMeterPresentation(
  budget: ApiContextBudget | null | undefined,
): ContextBudgetMeterPresentation {
  if (!budget || budget.status === 'unknown') {
    const model = budget?.model ?? 'Current model'
    const reason = budget?.status === 'unknown' ? formatUnknownReason(budget.reason) : 'No budget snapshot'
    return {
      tone: 'unknown',
      percent: null,
      percentLabel: '--',
      compactLabel: 'Context --',
      title: `${model}: context unavailable`,
      detailLines: [
        reason,
        ...(budget?.stale ? ['Refreshing after the current turn settles.'] : []),
      ],
    }
  }

  const percent = Math.max(0, budget.percent_of_context_budget)
  const tone = getBudgetTone(percent)
  const percentLabel = formatPercent(percent)
  const visualLimit = budget.compaction_enabled ? 'auto-compact limit' : 'usable input window'
  const remainingTarget = budget.compaction_enabled ? 'auto-compaction' : 'the usable input window'
  return {
    tone,
    percent,
    percentLabel,
    compactLabel: `Context ${percentLabel}`,
    title: `${budget.model}: ${percentLabel} of ${visualLimit}`,
    detailLines: [
      `${formatRoundedTokenCount(budget.estimated_input_tokens)} used of ${formatRoundedTokenCount(budget.effective_budget_tokens)}.`,
      `${formatRoundedTokenCount(budget.remaining_context_tokens)} remaining before ${remainingTarget}.`,
      `Bud cap ${formatRoundedTokenCount(budget.usable_context_window_tokens)}, output reserve ${formatRoundedTokenCount(budget.reserved_output_tokens)}.`,
      `Usable input window ${formatRoundedTokenCount(budget.usable_input_window_tokens)}.`,
      `Hard model window ${formatRoundedTokenCount(budget.context_window_tokens)}.`,
      `Basis ${formatEstimateBasis(budget.basis)}, ${budget.confidence} confidence.`,
      ...(budget.latest_checkpoint_id ? ['Already compacted earlier context.'] : []),
      ...(budget.stale ? ['Refreshing after the current turn settles.'] : []),
    ],
  }
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
      return 'estimated tokens'
    case 'provider_usage_plus_delta':
      return 'last provider usage plus new messages'
  }
}

function roundToSingleDecimal(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}
