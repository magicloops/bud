import { useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { hasCoarsePointer } from '@/lib/use-viewport'
import { getReasoningOptionsForModel, type ModelInfo, type ReasoningLevel } from '@/lib/models'
import type { ApiAgentEnvironment, ApiContextBudget } from '@/lib/api-types'
import type { WorkbenchStatus } from '@/components/workbench/workspace-top-bar'
import { ContextSendButton } from './context-send-button'
import { buildDescribe, shortBuildVersion } from '@/lib/build-info'

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
  /** Aligns composer content with the transcript column above (the
   *  composer spans the full workspace width; the chat pane does not). */
  contentInsetLeftPx?: number | null
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
  contentInsetLeftPx = null,
}: CommandComposerProps) {
  const [showFullBuild, setShowFullBuild] = useState(false)
  const reasoningOptions = getReasoningOptionsForModel(models, selectedModel)
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

  // Mobile auto-grow (value-driven, not event-driven, so clearing after a
  // send and programmatic changes also resize): ONE line at rest, grows
  // with content, caps at ~40% of the visual viewport and scrolls
  // internally beyond that. Desktop keeps the fixed h-32 box.
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    const el = textareaRef.current
    if (!el) {
      return
    }
    if (!window.matchMedia('(max-width: 767px)').matches) {
      el.style.height = ''
      el.style.overflowY = ''
      return
    }
    el.style.height = 'auto'
    const max = Math.round((window.visualViewport?.height ?? window.innerHeight) * 0.4)
    const next = Math.min(el.scrollHeight, max)
    el.style.height = `${next}px`
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'
  }, [messageText])

  return (
    <form
      onSubmit={onSubmit}
      className="relative border-t-2 border-black bg-background"
      // The pinned controls (md+) are absolutely positioned and ignore this.
      style={contentInsetLeftPx !== null ? { paddingLeft: contentInsetLeftPx } : undefined}
    >
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
        placeholder={disabledReason ?? 'Describe the task for Bud…'}
        className="w-full resize-none bg-background px-4 py-3 font-mono text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground md:h-28 md:px-4 md:py-3 md:pb-16"
        disabled={inputDisabled}
      />
      {/* Static row below the textarea on phones (the absolute pinning
          overlapped the text at <332px); pinned bottom-right on md+. */}
      <div className="flex items-center gap-2 px-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] md:absolute md:bottom-3 md:right-3 md:gap-2 md:p-0">
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
        <select
          value={selectedModel}
          onChange={(event) => onModelChange(event.target.value)}
          className="min-w-0 flex-1 rounded-lg border-2 border-black bg-card px-2 py-1.5 font-mono text-[11px] text-muted-foreground shadow-[2px_2px_0_rgba(0,0,0,1)] focus:outline-none md:max-w-[140px] md:flex-none"
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
        </select>
        {/* Reasoning effort selector */}
        {showReasoningSelector && (
          <select
            value={reasoningEffort}
            onChange={(event) => onReasoningChange(event.target.value as ReasoningLevel)}
            className="w-[96px] shrink-0 rounded-lg border-2 border-black bg-card px-2 py-1.5 font-mono text-[11px] text-muted-foreground shadow-[2px_2px_0_rgba(0,0,0,1)] focus:outline-none md:w-[112px]"
            disabled={inputDisabled}
          >
            {reasoningOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        )}
        <ContextSendButton
          contextBudget={contextBudget}
          disabled={stopMode ? false : inputDisabled}
          dispatching={status === 'dispatching'}
          stopMode={stopMode}
          onStop={onCancelAgentTurn}
        />
      </div>
    </form>
  )
}
