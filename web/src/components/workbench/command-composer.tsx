import type { FormEvent, KeyboardEvent } from 'react'
import { hasCoarsePointer } from '@/lib/use-viewport'
import { getReasoningOptionsForModel, type ModelInfo, type ReasoningLevel } from '@/lib/models'
import type { ApiAgentEnvironment, ApiContextBudget } from '@/lib/api-types'
import type { WorkbenchStatus } from '@/components/workbench/workspace-top-bar'
import { ContextSendButton } from './context-send-button'

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
}: CommandComposerProps) {
  const reasoningOptions = getReasoningOptionsForModel(models, selectedModel)
  const showReasoningSelector = reasoningOptions.length > 1 || reasoningOptions[0]?.value !== 'none'
  const stopMode = Boolean(onCancelAgentTurn) && (status === 'dispatching' || status === 'streaming')
  const inputDisabled = status === 'dispatching' || Boolean(disabledReason)
  const showBudOfflineNotice = environment?.mode === 'bud_offline'

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Soft keyboards have no visible Shift affordance: on coarse pointers
    // Enter inserts a newline and the send button submits
    // (design/responsive-web-layout.md §3.2).
    if (event.key === 'Enter' && !event.shiftKey && !hasCoarsePointer()) {
      event.preventDefault()
      if (!status || status === 'idle' || status === 'streaming' || status === 'waiting_for_user') {
        ; (event.currentTarget.form as HTMLFormElement | null)?.requestSubmit()
      }
    }
  }

  // Mobile auto-grow: track content height between one line and ~40% of the
  // visual viewport; desktop keeps the fixed h-32 box.
  const handleTextareaInput = (event: React.FormEvent<HTMLTextAreaElement>) => {
    const el = event.currentTarget
    if (!window.matchMedia('(max-width: 767px)').matches) {
      el.style.height = ''
      return
    }
    el.style.height = 'auto'
    const max = Math.round((window.visualViewport?.height ?? window.innerHeight) * 0.4)
    el.style.height = `${Math.min(el.scrollHeight, max)}px`
  }

  return (
    <form onSubmit={onSubmit} className="relative border-t-4 border-black bg-background">
      {error && <div className="whitespace-pre-line px-4 pt-3 text-xs text-destructive">{error}</div>}
      {disabledReason && <div className="px-4 pt-3 text-xs text-muted-foreground">{disabledReason}</div>}
      {showBudOfflineNotice && (
        <div className="px-4 pt-3 font-mono text-xs text-muted-foreground">
          Bud is offline. The agent can still respond, but terminal and web-view tools are unavailable.
        </div>
      )}
      <textarea
        name="message"
        value={messageText}
        onChange={(e) => onMessageChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onInput={handleTextareaInput}
        placeholder={disabledReason ?? 'Describe the task for Bud…'}
        className="h-24 w-full resize-none bg-background p-4 pb-2 font-mono text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground md:h-32 md:pb-20"
        disabled={inputDisabled}
      />
      {/* Static row below the textarea on phones (the absolute pinning
          overlapped the text at <332px); pinned bottom-right on md+. */}
      <div className="flex items-center gap-2 px-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] md:absolute md:bottom-4 md:right-4 md:gap-3 md:p-0">
        {/* Model selector */}
        <select
          value={selectedModel}
          onChange={(event) => onModelChange(event.target.value)}
          className="min-w-0 flex-1 rounded-lg border-3 border-black bg-card px-2 py-2 font-mono text-[11px] text-muted-foreground shadow-[3px_3px_0_rgba(0,0,0,1)] focus:outline-none md:max-w-[140px] md:flex-none"
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
            className="w-[96px] shrink-0 rounded-lg border-3 border-black bg-card px-2 py-2 font-mono text-[11px] text-muted-foreground shadow-[3px_3px_0_rgba(0,0,0,1)] focus:outline-none md:w-[112px]"
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
