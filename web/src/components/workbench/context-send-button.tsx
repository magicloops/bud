import type { CSSProperties } from 'react'
import { LoaderCircle, Send } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { ApiContextBudget } from '@/lib/api-types'
import {
  getContextBudgetMeterPresentation,
  getContextBudgetRingProgress,
} from './context-budget-meter-state'

type ContextSendButtonProps = {
  contextBudget?: ApiContextBudget | null
  disabled: boolean
  dispatching: boolean
}

const contextRingColors = {
  ring: '#000000',
  track: 'var(--bud-accent-muted)',
}

export function ContextSendButton({
  contextBudget,
  disabled,
  dispatching,
}: ContextSendButtonProps) {
  const presentation = getContextBudgetMeterPresentation(contextBudget)
  const ringProgress = getContextBudgetRingProgress(presentation)
  const ringDegrees = ringProgress * 3.6
  const ringStyle: CSSProperties = {
    backgroundImage: `conic-gradient(from 0deg, ${contextRingColors.ring} 0deg ${ringDegrees}deg, ${contextRingColors.track} ${ringDegrees}deg 360deg)`,
  }
  const ariaLabel = dispatching
    ? `Sending message. ${presentation.title}`
    : `Send message. ${presentation.title}`

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="inline-flex h-10 w-10 rounded-full transition-transform hover:-translate-y-0.5 focus-within:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-black/30"
            tabIndex={disabled ? 0 : undefined}
          >
            <button
              type="submit"
              aria-label={ariaLabel}
              disabled={disabled}
              className="relative flex h-10 w-10 items-center justify-center rounded-full p-[3px] text-black shadow-[3px_3px_0_rgba(0,0,0,1)] outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-black/30 disabled:cursor-not-allowed disabled:opacity-60"
              style={ringStyle}
            >
              <span
                className="flex h-full w-full items-center justify-center rounded-full"
                style={{ backgroundColor: 'var(--bud-accent-muted)' }}
              >
                {dispatching ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </span>
            </button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" align="end" className="max-w-72 border-2 border-black bg-card p-3 font-mono text-xs text-card-foreground shadow-[4px_4px_0_rgba(0,0,0,1)]">
          <div className="space-y-2">
            <div className="font-semibold">{presentation.title}</div>
            <div className="space-y-1 text-muted-foreground">
              {presentation.detailLines.map((line, index) => (
                <div key={`${index}-${line}`}>{line}</div>
              ))}
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
