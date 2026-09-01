import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  FormEvent,
  KeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  RefObject,
  SelectHTMLAttributes,
} from 'react'
import { useComposerColumnAlignment } from '@/components/workbench/chat-pane-resize'
import { hasCoarsePointer } from '@/lib/use-viewport'
import { getReasoningOptionsForModel, type ModelInfo, type ReasoningLevel } from '@/lib/models'
import type { ApiAgentEnvironment, ApiContextBudget } from '@/lib/api-types'
import type { WorkbenchStatus } from '@/components/workbench/workspace-top-bar'
import { ContextSendButton } from './context-send-button'
import { buildDescribe, shortBuildVersion } from '@/lib/build-info'

const NULL_PANE_REF: RefObject<HTMLDivElement | null> = { current: null }

const COMPOSER_MIN_HEIGHT_PX = 56

const composerMaxHeight = (): number => {
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight
  return Math.min(Math.round(viewportHeight * 0.75), 1000)
}

const autoGrowHeight = (el: HTMLTextAreaElement): number => {
  el.style.height = 'auto'
  return Math.min(el.scrollHeight, composerMaxHeight())
}

/** Focus with the caret at the END of any existing draft (programmatic
 *  focus otherwise lands at position 0 on a fresh render — typing after a
 *  tab/thread switch prepended to the draft). */
const focusAtEnd = (el: HTMLTextAreaElement) => {
  el.focus()
  const end = el.value.length
  el.setSelectionRange(end, end)
}

/** Border (2+2) + px-2 padding (8+8) + native chevron allowance, plus
 *  breathing room — measured text vs. the select's own rendering can differ
 *  by a few px, and too tight overlaps the label with the chevron. */
const SELECT_CHROME_PX = 44

/** A select whose width hugs the SELECTED option's label. Native selects
 *  size to their WIDEST option (across every optgroup), so short selections
 *  left dead space. The label is measured in a hidden span sharing the
 *  select's type styles; width = text + chrome, still capped by any max-w
 *  class. */
function FitSelect({
  label,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string; children: ReactNode }) {
  const measureRef = useRef<HTMLSpanElement | null>(null)
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = measureRef.current
    if (el) {
      setWidth(Math.ceil(el.offsetWidth) + SELECT_CHROME_PX)
    }
  }, [label])
  return (
    <>
      <span
        ref={measureRef}
        aria-hidden
        className="invisible absolute -z-10 whitespace-pre font-mono text-[11px]"
      >
        {label}
      </span>
      <select {...props} style={width !== null ? { width } : undefined}>
        {children}
      </select>
    </>
  )
}

type CommandComposerProps = {
  messageText: string
  onMessageChange: (value: string) => void
  status: WorkbenchStatus
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onCancelAgentTurn?: () => void | Promise<void>
  error: string | null
  models: ModelInfo[]
  selectedModel: string
  onModelChange: (value: string) => void
  reasoningEffort: ReasoningLevel
  onReasoningChange: (value: ReasoningLevel) => void
  disabledReason?: string | null
  environment?: ApiAgentEnvironment | null
  contextBudget?: ApiContextBudget | null
  /** Chat pane to align with: composer content indents to the transcript
   *  column's left edge and the pinned controls right-anchor to the
   *  column's text right edge (the composer spans the full workspace
   *  width; the chat pane does not). */
  alignToPaneRef?: RefObject<HTMLDivElement | null>
  /** Auto-focus the input on mount and whenever this key changes (pass
   *  the thread id, plus the view mode so viewer tab toggles hand focus
   *  back). Skipped on coarse pointers — no surprise soft keyboards. */
  autoFocusKey?: string | null
}

export function CommandComposer({
  messageText,
  onMessageChange,
  status,
  onSubmit,
  onCancelAgentTurn,
  error,
  models,
  selectedModel,
  onModelChange,
  reasoningEffort,
  onReasoningChange,
  disabledReason = null,
  environment = null,
  contextBudget,
  alignToPaneRef,
  autoFocusKey = null,
}: CommandComposerProps) {
  const [showFullBuild, setShowFullBuild] = useState(false)
  const reasoningOptions = getReasoningOptionsForModel(models, selectedModel)
  // Labels of the CURRENT selections, mirroring the option text exactly —
  // FitSelect measures these so each select hugs its selection.
  const selectedModelInfo = models.find((model) => model.id === selectedModel)
  const selectedModelLabel =
    models.length === 0
      ? 'Loading...'
      : selectedModelInfo
        ? `${selectedModelInfo.display_name}${selectedModelInfo.source?.kind === 'bud_local' ? ' · Local Bud' : ''}${selectedModelInfo.experimental ? ' · experimental' : ''}`
        : selectedModel
  const selectedReasoningLabel =
    reasoningOptions.find((option) => option.value === reasoningEffort)?.label ?? reasoningEffort
  const showReasoningSelector = reasoningOptions.length > 1 || reasoningOptions[0]?.value !== 'none'
  const stopMode =
    Boolean(onCancelAgentTurn) &&
    (status === 'dispatching' || status === 'streaming' || status === 'waiting_for_terminal')
  const inputDisabled = status === 'dispatching' || Boolean(disabledReason)
  const showBudOfflineNotice = environment?.mode === 'bud_offline'

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Soft keyboards have no visible Shift affordance: on coarse pointers
    // Enter inserts a newline and the send button submits
    // (design/responsive-web-layout.md §3.2).
    if (event.key === 'Enter' && !event.shiftKey && !hasCoarsePointer()) {
      event.preventDefault()
      if (
        !status ||
        status === 'idle' ||
        status === 'streaming' ||
        status === 'waiting_for_user' ||
        status === 'waiting_for_terminal'
      ) {
        ; (event.currentTarget.form as HTMLFormElement | null)?.requestSubmit()
      }
    }
  }

  // Auto-grow (value-driven, not event-driven, so clearing after a send
  // and programmatic changes also resize): rests at one line on phones /
  // md:min-h-28 on desktop, grows with content, caps at 3/4 of the
  // visual viewport (1000px absolute) and scrolls internally beyond that.
  // Dragging the top edge sets a manual height that overrides auto-grow
  // until the next send (or a double-click on the edge).
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const formRef = useRef<HTMLFormElement | null>(null)
  const alignment = useComposerColumnAlignment(alignToPaneRef ?? NULL_PANE_REF, formRef)
  const [manualHeight, setManualHeight] = useState<number | null>(null)
  const resizeDragRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(
    null,
  )
  useEffect(() => {
    const el = textareaRef.current
    if (!el) {
      return
    }
    const height = manualHeight ?? autoGrowHeight(el)
    el.style.height = `${height}px`
    el.style.overflowY = el.scrollHeight > height ? 'auto' : 'hidden'
  }, [messageText, manualHeight])

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const el = textareaRef.current
    if (!el) {
      return
    }
    event.preventDefault()
    resizeDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: el.getBoundingClientRect().height,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handleResizePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }
    // Dragging up grows the input, down shrinks it.
    const next = Math.round(drag.startHeight + (drag.startY - event.clientY))
    setManualHeight(Math.min(Math.max(next, COMPOSER_MIN_HEIGHT_PX), composerMaxHeight()))
  }

  const endResizeDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (resizeDragRef.current?.pointerId === event.pointerId) {
      resizeDragRef.current = null
    }
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    setManualHeight(null)
    onSubmit(event)
  }

  // Focus on navigation: mount, thread switches, and viewer tab toggles
  // (the key includes the view mode) — fine pointers only. Clicking a
  // terminal/web/file tab moves focus to the tab button; the composer takes
  // it back so typing continues uninterrupted (the viewer is focused
  // manually when needed). Already-focused drafts keep their caret.
  useEffect(() => {
    if (hasCoarsePointer()) {
      return
    }
    const el = textareaRef.current
    if (el && document.activeElement !== el) {
      focusAtEnd(el)
    }
  }, [autoFocusKey])

  // Keep focus across sends: dispatching disables the textarea, which
  // ejects focus to <body>; when it re-enables, take focus back — but only
  // from <body>, never from somewhere the user deliberately moved it.
  const prevInputDisabledRef = useRef(inputDisabled)
  useEffect(() => {
    const wasDisabled = prevInputDisabledRef.current
    prevInputDisabledRef.current = inputDisabled
    if (!wasDisabled || inputDisabled || hasCoarsePointer()) {
      return
    }
    const active = document.activeElement
    if (!active || active === document.body) {
      const el = textareaRef.current
      if (el) {
        focusAtEnd(el)
      }
    }
  }, [inputDisabled])

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      className="relative border-t-2 border-black bg-background"
      // The pinned controls (md+) are absolutely positioned and ignore this.
      style={alignment ? { paddingLeft: alignment.paddingLeft } : undefined}
    >
      {/* Drag strip over the top border: resize the input by hand;
          double-click (or the next send) returns it to auto-grow. */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize message input"
        title="Drag to resize · double-click to reset"
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={endResizeDrag}
        onPointerCancel={endResizeDrag}
        onDoubleClick={() => setManualHeight(null)}
        className="absolute -top-1.5 left-0 right-0 z-10 h-3 cursor-row-resize touch-none select-none hover:bg-foreground/10 active:bg-foreground/15"
      />
      {error && <div className="whitespace-pre-line px-4 pt-3 text-xs text-destructive">{error}</div>}
      {disabledReason && <div className="px-4 pt-3 text-xs text-muted-foreground">{disabledReason}</div>}
      {showBudOfflineNotice && (
        <div className="px-4 pt-3 font-mono text-xs text-muted-foreground">
          Bud is offline. The agent can still respond, but terminal and web-view tools are unavailable.
        </div>
      )}
      <textarea
        ref={textareaRef}
        name="message"
        rows={1}
        value={messageText}
        onChange={(e) => onMessageChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={disabledReason ?? 'Describe a task for Bud…'}
        className="w-full resize-none bg-background px-4 py-3 font-mono text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground md:min-h-28 md:px-4 md:py-3 md:pb-16"
        disabled={inputDisabled}
      />
      {/* Static row below the textarea on phones (the absolute pinning
          overlapped the text at <332px); pinned bottom-right on md+. */}
      <div
        className="flex items-center justify-end gap-2 px-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] md:absolute md:bottom-3 md:right-3 md:gap-2 md:p-0"
        // Right-anchor to the transcript column's text edge on md+ (the
        // static phone row ignores `right`).
        style={alignment ? { right: alignment.controlsRight } : undefined}
      >
        {/* Build tag: short release version; click toggles the full
            git-describe string (build forensics without a settings surface). */}
        <button
          type="button"
          onClick={() => setShowFullBuild((value) => !value)}
          title={buildDescribe()}
          className="shrink-0 font-mono text-[10px] text-muted-foreground/60 transition-colors hover:text-muted-foreground"
          data-testid="web-build-tag"
        >
          {showFullBuild ? buildDescribe() : shortBuildVersion(buildDescribe())}
        </button>
        {/* Model selector */}
        <FitSelect
          label={selectedModelLabel}
          value={selectedModel}
          onChange={(event) => onModelChange(event.target.value)}
          className="min-w-0 max-w-[140px] flex-none rounded-lg border-2 border-black bg-card px-2 py-1.5 font-mono text-[11px] text-muted-foreground shadow-[2px_2px_0_rgba(0,0,0,1)] focus:outline-none"
          disabled={inputDisabled || models.length === 0}
        >
          {models.length === 0 ? (
            <option value="">Loading...</option>
          ) : (
            Object.entries(
              models.reduce<Record<string, ModelInfo[]>>((acc, model) => {
                if (!acc[model.provider]) acc[model.provider] = []
                acc[model.provider].push(model)
                return acc
              }, {})
            ).map(([provider, providerModels]) => (
              <optgroup key={provider} label={provider.toUpperCase()}>
                {providerModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.display_name}
                    {model.source?.kind === 'bud_local' ? ' · Local Bud' : ''}
                    {model.experimental ? ' · experimental' : ''}
                  </option>
                ))}
              </optgroup>
            ))
          )}
        </FitSelect>
        {/* Reasoning effort selector */}
        {showReasoningSelector && (
          <FitSelect
            label={selectedReasoningLabel}
            value={reasoningEffort}
            onChange={(event) => onReasoningChange(event.target.value as ReasoningLevel)}
            className="shrink-0 rounded-lg border-2 border-black bg-card px-2 py-1.5 font-mono text-[11px] text-muted-foreground shadow-[2px_2px_0_rgba(0,0,0,1)] focus:outline-none"
            disabled={inputDisabled}
          >
            {reasoningOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </FitSelect>
        )}
        {/* justify-end on the row right-aligns the whole cluster (build tag,
            selectors, send) on the static phone row; on md+ the pinned row is
            content-sized so it's a no-op. */}
        <div className="shrink-0">
          <ContextSendButton
            contextBudget={contextBudget}
            disabled={stopMode ? false : inputDisabled}
            dispatching={status === 'dispatching'}
            stopMode={stopMode}
            onStop={onCancelAgentTurn}
          />
        </div>
      </div>
    </form>
  )
}
