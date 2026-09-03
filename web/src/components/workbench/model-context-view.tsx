import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { apiFetchJson, isApiError } from '@/lib/transport'
import type { ApiModelContext } from '@/lib/api-types'
import { TRANSCRIPT_COLUMN_CLASSES } from '@/components/workbench/transcript-layout'
import { MutationStatus } from '@/components/ui/mutation-status'
import { CodeBlock } from '@/components/ui/code-block'
import { MarkdownContent } from '@/components/message-renderers/roles/markdown-content'
import { CONTEXT_CATEGORY_COLORS } from '@/components/workbench/context-budget-meter-state'
import {
  buildModelViewPresentation,
  type ModelViewBlock,
  type ModelViewPart,
  type ModelViewPresentation,
} from '@/features/threads/model-context-view-state'

type ModelContextViewProps = {
  threadId: string
  /** Changes when the document should be refetched (turn ended, compaction). */
  refreshKey: string
  modelLabel?: string | null
}

/** Tool results longer than this are clamped until expanded. */
const TOOL_RESULT_CLAMP_LINES = 40

/**
 * Model view: the exact conversation the next request will carry, straight
 * from GET /api/threads/:id/model-context — no grouping, nothing collapsed
 * except long tool output. Read-only.
 */
export function ModelContextView({ threadId, refreshKey, modelLabel = null }: ModelContextViewProps) {
  const [doc, setDoc] = useState<ApiModelContext | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [toolsOpen, setToolsOpen] = useState(false)
  // Start at the bottom (the latest exchange) when a document loads, and
  // stay pinned there while lazy renderers (markdown, code highlighting)
  // grow the content — until the user scrolls up.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const next = await apiFetchJson<ApiModelContext>(`/api/threads/${threadId}/model-context`)
      setDoc(next)
    } catch (err) {
      setError(
        isApiError(err, 404)
          ? 'The model view is not available on this service yet.'
          : err instanceof Error
            ? err.message
            : 'Failed to load the model context',
      )
    } finally {
      setLoading(false)
    }
  }, [threadId])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  useEffect(() => {
    if (!doc) return
    stickToBottomRef.current = true
    const node = scrollRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            if (stickToBottomRef.current) {
              node.scrollTop = node.scrollHeight
            }
          })
    if (observer && node.firstElementChild) {
      observer.observe(node.firstElementChild)
    }
    return () => observer?.disconnect()
  }, [doc])

  const handleScroll = useCallback(() => {
    const node = scrollRef.current
    if (!node) return
    const atBottom = node.scrollHeight - (node.scrollTop + node.clientHeight) < 48
    stickToBottomRef.current = atBottom
  }, [])

  const presentation = doc ? buildModelViewPresentation(doc, { modelLabel }) : null

  return (
    <div ref={scrollRef} onScroll={handleScroll} className="@container min-h-0 flex-1 overflow-y-auto bg-background">
      <div className={cn(TRANSCRIPT_COLUMN_CLASSES, 'py-3 font-mono text-xs')}>
        <div className="flex items-start justify-between gap-3 px-4">
          <div className="min-w-0">
            <p className="font-semibold">{presentation?.headline ?? 'Model view'}</p>
            <p className="text-muted-foreground">
              {presentation?.subline ?? (loading ? 'Loading what the model sees…' : '')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            aria-label="Refresh model view"
            className="shrink-0 rounded-md border-2 border-black bg-card p-1.5 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] transition-transform hover:-translate-y-0.5 disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </button>
        </div>

        {error && (
          <div className="px-4 pt-3">
            <MutationStatus tone="error" message={error} />
          </div>
        )}

        {presentation && (
          <div className="mt-3 space-y-3">
            {/* Tools render into the prompt root right after the system
                text on every provider, so the tools block sits after the
                system-prompt block (or first, if there is none). */}
            {presentation.toolsAfterIndex === null && (
              <ToolsBlock presentation={presentation} tools={doc!.tools} open={toolsOpen} onToggle={() => setToolsOpen((value) => !value)} />
            )}
            {presentation.blocks.map((block) => (
              <Fragment key={block.id}>
                <ModelViewBlockRow
                  block={block}
                  banner={block.isCompactionSummary ? presentation.compactionBanner : null}
                />
                {presentation.toolsAfterIndex === block.index && (
                  <ToolsBlock presentation={presentation} tools={doc!.tools} open={toolsOpen} onToggle={() => setToolsOpen((value) => !value)} />
                )}
              </Fragment>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ToolsBlock({
  presentation,
  tools,
  open,
  onToggle,
}: {
  presentation: ModelViewPresentation
  tools: ApiModelContext['tools']
  open: boolean
  onToggle: () => void
}) {
  return (
    <div className="px-4">
      <div className="border-l-[3px] pl-3" style={{ borderLeftColor: CONTEXT_CATEGORY_COLORS.tool_schemas }}>
        <button
          type="button"
          onClick={onToggle}
          className="flex w-full items-center gap-1.5 text-left"
          aria-expanded={open}
        >
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <span className="text-[10px] font-semibold uppercase tracking-wide text-foreground">{presentation.tools.label}</span>
        </button>
        {open && (
          <ul className="mt-2 space-y-2">
            {tools.map((tool) => (
              <li key={tool.name}>
                <p className="font-semibold">{tool.name}</p>
                <p className="whitespace-pre-wrap text-muted-foreground">{tool.description}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function ModelViewBlockRow({ block, banner }: { block: ModelViewBlock; banner: string | null }) {
  return (
    <article className="px-4">
      {banner && (
        <div className="mb-2 flex items-center gap-3 text-[11px] uppercase tracking-wide text-muted-foreground">
          <div className="h-px flex-1 bg-black/15" />
          <span>{banner}</span>
          <div className="h-px flex-1 bg-black/15" />
        </div>
      )}
      <div className="border-l-[3px] pl-3" style={{ borderLeftColor: block.color }}>
        <header className="sticky top-0 z-10 -ml-3 mb-1 flex items-baseline justify-between gap-2 bg-background/95 pl-3 text-[10px] uppercase tracking-wide text-muted-foreground backdrop-blur">
          <span>
            <span className="font-semibold text-foreground">{block.label}</span>
            {block.badge && <span className="ml-2">{block.badge}</span>}
          </span>
          <span className="tabular-nums">{block.tokensLabel}</span>
        </header>
        <div className="space-y-2">
          {block.parts.map((part, index) => (
            <ModelViewPartBody key={`${block.id}:${index}`} part={part} />
          ))}
        </div>
      </div>
    </article>
  )
}

function ModelViewPartBody({ part }: { part: ModelViewPart }) {
  switch (part.kind) {
    case 'text':
      return (
        <div className="text-sm leading-relaxed">
          {part.label && <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{part.label}</p>}
          {/* Same renderer as the transcript; local links are inert here
              since the prompt is full of illustrative paths. */}
          <MarkdownContent content={part.text} inertLocalLinks />
        </div>
      )
    case 'reasoning':
      return (
        <div className="text-sm leading-relaxed text-muted-foreground">
          <p className="text-[10px] uppercase tracking-wide" style={{ color: part.color }}>
            Reasoning
          </p>
          <MarkdownContent content={part.text} inertLocalLinks />
        </div>
      )
    case 'reasoning_redacted':
      return (
        <p className="italic text-muted-foreground">[reasoning kept by the provider, not visible]</p>
      )
    case 'tool_use':
      return (
        <div>
          <p className="text-[10px] uppercase tracking-wide" style={{ color: part.color }}>
            Tool call · {part.name} · {part.id}
          </p>
          <CodeBlock code={part.args} language="json" />
        </div>
      )
    case 'tool_result':
      return <ClampedToolResult part={part} />
    case 'image':
      return (
        <img
          src={part.dataUrl}
          alt={`Image (${part.mediaType})`}
          className="max-h-48 rounded-md border-2 border-black"
        />
      )
  }
}

function ClampedToolResult({ part }: { part: Extract<ModelViewPart, { kind: 'tool_result' }> }) {
  const [expanded, setExpanded] = useState(false)
  // JSON results render pretty-printed; anything else as plain code.
  const body = part.json ?? part.text
  const lines = body.split('\n')
  const clamped = !expanded && lines.length > TOOL_RESULT_CLAMP_LINES
  const shown = clamped ? lines.slice(0, TOOL_RESULT_CLAMP_LINES).join('\n') : body
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide" style={{ color: part.color }}>
        Tool result · {part.toolUseId}
        {part.isError && <span className="ml-2 text-destructive">error</span>}
      </p>
      <CodeBlock code={shown} language={part.json ? 'json' : 'text'} />
      {lines.length > TOOL_RESULT_CLAMP_LINES && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
        >
          {expanded ? 'Show less' : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  )
}
