import type { FormEvent, KeyboardEvent } from 'react'
import { LoaderCircle, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getReasoningOptionsForModel, type ModelInfo, type ReasoningLevel } from '@/lib/models'

type CommandComposerProps = {
  messageText: string
  onMessageChange: (value: string) => void
  status: 'idle' | 'dispatching' | 'streaming'
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  error: string | null
  models: ModelInfo[]
  selectedModel: string
  onModelChange: (value: string) => void
  reasoningEffort: ReasoningLevel
  onReasoningChange: (value: ReasoningLevel) => void
  disabledReason?: string | null
}

export function CommandComposer({
  messageText,
  onMessageChange,
  status,
  onSubmit,
  error,
  models,
  selectedModel,
  onModelChange,
  reasoningEffort,
  onReasoningChange,
  disabledReason = null
}: CommandComposerProps) {
  const reasoningOptions = getReasoningOptionsForModel(models, selectedModel)
  const showReasoningSelector = reasoningOptions.length > 1 || reasoningOptions[0]?.value !== 'none'
  const inputDisabled = status === 'dispatching' || Boolean(disabledReason)

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      if (!status || status === 'idle' || status === 'streaming') {
        ; (event.currentTarget.form as HTMLFormElement | null)?.requestSubmit()
      }
    }
  }

  return (
    <form onSubmit={onSubmit} className="relative border-t-4 border-black bg-background">
      {error && <div className="px-4 pt-3 text-xs text-destructive">{error}</div>}
      {disabledReason && <div className="px-4 pt-3 text-xs text-muted-foreground">{disabledReason}</div>}
      <textarea
        name="message"
        value={messageText}
        onChange={(e) => onMessageChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={disabledReason ?? 'Describe the task for Bud…'}
        className="h-32 w-full resize-none bg-background p-4 pr-16 font-mono text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
        disabled={inputDisabled}
      />
      <div className="absolute bottom-4 right-4 flex items-center gap-3">
        {/* Model selector */}
        <select
          value={selectedModel}
          onChange={(event) => onModelChange(event.target.value)}
          className="rounded-lg border-3 border-black bg-card max-w-[140px] px-2 py-2 font-mono text-[11px] text-muted-foreground shadow-[3px_3px_0_rgba(0,0,0,1)] focus:outline-none"
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
            className="w-[112px] rounded-lg border-3 border-black bg-card px-2 py-2 font-mono text-[11px] text-muted-foreground shadow-[3px_3px_0_rgba(0,0,0,1)] focus:outline-none"
            disabled={inputDisabled}
          >
            {reasoningOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        )}
        <Button
          type="submit"
          size="icon"
          disabled={inputDisabled}
          className="h-12 w-12 rounded-lg border-3 border-black text-black transition-all hover:-translate-y-0.5 disabled:opacity-60"
          style={{ backgroundColor: 'var(--bud-accent-muted)' }}
        >
          {status !== 'idle' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>
    </form>
  )
}
