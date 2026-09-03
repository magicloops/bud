import type { ApiModelContext, ApiModelContextBlock, ApiModelContextMessage } from '../../lib/api-types.ts'
import {
  CONTEXT_CATEGORY_COLORS,
  formatRoundedTokenCount,
} from '../../components/workbench/context-budget-meter-state.ts'

/** One rendered part of a model-view block (a canonical content block). */
export type ModelViewPart =
  | { kind: 'text'; text: string; color: string; label: string | null }
  | { kind: 'tool_use'; id: string; name: string; args: string; color: string }
  | {
      kind: 'tool_result'
      toolUseId: string
      /** Raw text as sent to the model. */
      text: string
      /** Pretty-printed form when `text` parses as a JSON object/array; null otherwise. */
      json: string | null
      isError: boolean
      color: string
    }
  | { kind: 'reasoning'; text: string; color: string }
  | { kind: 'reasoning_redacted'; color: string }
  | { kind: 'image'; mediaType: string; dataUrl: string; color: string }

export type ModelViewBlock = {
  id: string
  index: number
  role: ApiModelContextMessage['role']
  /** Header label, e.g. "System prompt", "User", "Bud", "Tool result". */
  label: string
  /** Provenance badge, e.g. "default · v1a2b3c4d", "compaction summary", "provider replay". */
  badge: string | null
  tokensLabel: string
  /** Rail color: the first part's color. */
  color: string
  parts: ModelViewPart[]
  /** True for the checkpoint summary row, which gets the compaction banner. */
  isCompactionSummary: boolean
}

export type ModelViewPresentation = {
  headline: string
  subline: string
  compactionBanner: string | null
  tools: { label: string; names: string[]; tokensLabel: string }
  /** Index of the block the tools list renders after (the system prompt), or null to render it first. */
  toolsAfterIndex: number | null
  blocks: ModelViewBlock[]
}

const ROLE_LABELS: Record<ApiModelContextMessage['role'], string> = {
  system: 'System',
  user: 'User',
  assistant: 'Bud',
}

export function buildModelViewPresentation(doc: ApiModelContext, options: { modelLabel?: string | null } = {}): ModelViewPresentation {
  const modelLabel = options.modelLabel?.trim() || doc.model
  const generatedAt = new Date(doc.generated_at)
  const budgetTokens =
    doc.context_budget?.status === 'available' ? doc.context_budget.effective_budget_tokens : null
  const headline = doc.turn_active
    ? `${modelLabel} · refreshing when the turn ends`
    : `${modelLabel} · as of ${generatedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
  const subline = `${doc.messages.length} messages · ${formatRoundedTokenCount(doc.estimated_input_tokens)}${
    budgetTokens !== null ? ` of ${formatRoundedTokenCount(budgetTokens)}` : ''
  } tokens`

  return {
    headline,
    subline,
    compactionBanner: doc.compaction
      ? 'Earlier history was replaced by this summary when the context was compacted.'
      : null,
    tools: {
      label: `Tools · ${doc.tools.length} · ${formatRoundedTokenCount(doc.tool_schema_tokens)} tokens`,
      names: doc.tools.map((tool) => tool.name),
      tokensLabel: formatRoundedTokenCount(doc.tool_schema_tokens),
    },
    // Providers render tool schemas into the prompt root right after the
    // system text, so the tools block follows the system-prompt message.
    toolsAfterIndex: doc.messages.find((message) => message.source.kind === 'system_prompt')?.index ?? null,
    blocks: doc.messages.map(buildBlock),
  }
}

function buildBlock(message: ApiModelContextMessage): ModelViewBlock {
  const parts = message.content.map((block) => buildPart(block, message))
  const isCompactionSummary = message.source.kind === 'checkpoint_summary'
  return {
    id: `model-view:${message.index}`,
    index: message.index,
    role: message.role,
    label: blockLabel(message),
    badge: sourceBadge(message),
    tokensLabel: formatRoundedTokenCount(message.estimated_tokens),
    color: parts[0]?.color ?? CONTEXT_CATEGORY_COLORS.other,
    parts,
    isCompactionSummary,
  }
}

function blockLabel(message: ApiModelContextMessage): string {
  switch (message.source.kind) {
    case 'system_prompt':
      return 'System prompt'
    case 'runtime_instruction':
      return 'Runtime instruction'
    case 'checkpoint_summary':
      return 'Compaction summary'
    case 'checkpoint_history':
      return message.role === 'user' ? 'User (kept by compaction)' : ROLE_LABELS[message.role]
    default:
      break
  }
  const onlyToolResults = message.content.length > 0 && message.content.every((block) => block.type === 'tool_result')
  if (onlyToolResults) return 'Tool result'
  const onlyToolUse = message.content.length > 0 && message.content.every((block) => block.type === 'tool_use')
  if (onlyToolUse) return 'Tool call'
  return ROLE_LABELS[message.role]
}

function sourceBadge(message: ApiModelContextMessage): string | null {
  const source = message.source
  switch (source.kind) {
    case 'system_prompt':
      return `${source.scope} · ${source.version.replace(/^sha256:/, 'v')}`
    case 'runtime_instruction':
      return 'not stored'
    case 'checkpoint_summary':
    case 'checkpoint_history':
      return 'from checkpoint'
    case 'ledger':
      return 'provider replay'
    case 'repair':
      return 'synthesized'
    case 'message':
      return null
  }
}

function buildPart(block: ApiModelContextBlock, message: ApiModelContextMessage): ModelViewPart {
  switch (block.type) {
    case 'text':
      return {
        kind: 'text',
        text: block.text,
        color: textColor(message),
        label: block.assistant_phase ? block.assistant_phase.replace('_', ' ') : null,
      }
    case 'tool_use':
      return {
        kind: 'tool_use',
        id: block.id,
        name: block.name,
        args: JSON.stringify(block.input, null, 2),
        color: CONTEXT_CATEGORY_COLORS.tool_calls,
      }
    case 'tool_result': {
      const text = flattenToolResult(block.content)
      return {
        kind: 'tool_result',
        toolUseId: block.tool_use_id,
        text,
        json: prettyJson(text),
        isError: block.is_error === true,
        color: CONTEXT_CATEGORY_COLORS.tool_output,
      }
    }
    case 'reasoning':
      return { kind: 'reasoning', text: block.text, color: CONTEXT_CATEGORY_COLORS.reasoning }
    case 'reasoning_redacted':
      return { kind: 'reasoning_redacted', color: CONTEXT_CATEGORY_COLORS.reasoning }
    case 'image':
      return {
        kind: 'image',
        mediaType: block.media_type,
        dataUrl: `data:${block.media_type};base64,${block.data}`,
        color: CONTEXT_CATEGORY_COLORS.images,
      }
  }
}

function textColor(message: ApiModelContextMessage): string {
  switch (message.source.kind) {
    case 'system_prompt':
    case 'runtime_instruction':
      return CONTEXT_CATEGORY_COLORS.system_prompt
    case 'checkpoint_summary':
      return CONTEXT_CATEGORY_COLORS.compaction_summary
    default:
      return CONTEXT_CATEGORY_COLORS.messages
  }
}

/** Pretty-print a string that is a JSON object or array; null for anything else. */
export function prettyJson(text: string): string | null {
  const trimmed = text.trim()
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed === null || typeof parsed !== 'object') return null
    return JSON.stringify(parsed, null, 2)
  } catch {
    return null
  }
}

function flattenToolResult(content: string | ApiModelContextBlock[]): string {
  if (typeof content === 'string') return content
  return content
    .map((block) => {
      switch (block.type) {
        case 'text':
          return block.text
        case 'image':
          return `[image ${block.media_type}]`
        case 'tool_result':
          return flattenToolResult(block.content)
        case 'tool_use':
          return `[tool_use ${block.name}]`
        case 'reasoning':
          return block.text
        case 'reasoning_redacted':
          return '[redacted reasoning]'
      }
    })
    .join('\n')
}
