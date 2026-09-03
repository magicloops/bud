import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { LoaderCircle, Send, Square } from 'lucide-react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import type { ApiContextBudget } from '@/lib/api-types'
import { config } from '@/lib/config'
import { cn } from '@/lib/utils'
import {
  getContextBudgetMeterPresentation,
  getContextBudgetRingProgress,
} from './context-budget-meter-state'

type ContextSendButtonProps = {
  contextBudget?: ApiContextBudget | null
  /** Catalog display name for the budget's model (falls back to the id). */
  modelLabel?: string | null
  disabled: boolean
  dispatching: boolean
  stopMode?: boolean
  onStop?: () => void | Promise<void>
}

const contextRingColors = {
  ring: '#000000',
  track: 'var(--bud-accent-muted)',
}

const HOVER_OPEN_DELAY_MS = 150
const HOVER_CLOSE_DELAY_MS = 120

export function ContextSendButton({
  contextBudget,
  modelLabel = null,
  disabled,
  dispatching,
  stopMode = false,
  onStop,
}: ContextSendButtonProps) {
  const presentation = getContextBudgetMeterPresentation(contextBudget, { modelLabel })
  const ringProgress = getContextBudgetRingProgress(presentation)
  const ringDegrees = ringProgress * 3.6
  const ringStyle: CSSProperties = {
    backgroundImage: `conic-gradient(from 0deg, ${contextRingColors.ring} 0deg ${ringDegrees}deg, ${contextRingColors.track} ${ringDegrees}deg 360deg)`,
  }
  const ariaLabel = stopMode
    ? `Stop response. ${presentation.title}`
    : dispatching
    ? `Sending message. ${presentation.title}`
    : `Send message. ${presentation.title}`

  // The popover is controlled: hover opens it on pointer devices, focus opens
  // it for keyboard users, and a tap on the ring opens it on touch when the
  // button itself is disabled (an empty composer) — when enabled, a tap is
  // the send action and must not be intercepted.
  const [open, setOpen] = useState(false)
  const hoverTimer = useRef<number | null>(null)
  const clearHoverTimer = () => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
  }
  useEffect(() => clearHoverTimer, [])
  const canHover = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(hover: hover)').matches
      : false
  const scheduleOpen = useCallback(() => {
    if (!canHover()) return
    clearHoverTimer()
    hoverTimer.current = window.setTimeout(() => setOpen(true), HOVER_OPEN_DELAY_MS)
  }, [])
  const scheduleClose = useCallback(() => {
    if (!canHover()) return
    clearHoverTimer()
    hoverTimer.current = window.setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY_MS)
  }, [])
  const cancelClose = useCallback(() => {
    clearHoverTimer()
  }, [])

  const handleClick = () => {
    if (!stopMode) {
      return
    }
    void onStop?.()
  }
  const handleWrapperClick = () => {
    if (disabled && !stopMode) {
      setOpen((value) => !value)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <span
          className="inline-flex h-10 w-10 rounded-full transition-transform hover:-translate-y-0.5 focus-within:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-black/30"
          tabIndex={disabled ? 0 : undefined}
          onPointerEnter={scheduleOpen}
          onPointerLeave={scheduleClose}
          onFocus={() => setOpen(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setOpen(false)
            }
          }}
          onClick={handleWrapperClick}
          aria-describedby={open ? 'context-budget-popover' : undefined}
        >
          <button
            type={stopMode ? 'button' : 'submit'}
            aria-label={ariaLabel}
            disabled={disabled}
            onClick={handleClick}
            className="relative flex h-10 w-10 items-center justify-center rounded-full p-[3px] text-black shadow-[2px_2px_0_rgba(0,0,0,1)] outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-black/30 disabled:cursor-not-allowed disabled:opacity-60"
            style={ringStyle}
          >
            <span
              className="flex h-full w-full items-center justify-center rounded-full"
              style={{ backgroundColor: 'var(--bud-accent-muted)' }}
            >
              {stopMode ? (
                <Square className="h-3.5 w-3.5 fill-current" />
              ) : dispatching ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </span>
          </button>
        </span>
      </PopoverAnchor>
      <PopoverContent
        id="context-budget-popover"
        side="top"
        align="end"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={cancelClose}
        onPointerLeave={scheduleClose}
        className="w-72 border-2 border-black bg-card p-3 font-mono text-xs text-card-foreground shadow-[2px_2px_0_rgba(0,0,0,1)]"
      >
        <div className="space-y-2">
          <div>
            <div className="font-semibold">{presentation.headline}</div>
            {presentation.subline && <div className="text-muted-foreground">{presentation.subline}</div>}
          </div>

          {presentation.rows.length > 0 && (
            <>
              <div
                className="flex h-2 w-full overflow-hidden rounded-full border border-black/40 bg-muted"
                role="img"
                aria-label="Context usage by category"
              >
                {presentation.rows.map((row) => (
                  <div
                    key={row.id}
                    style={{
                      // Tiny categories keep a sliver so they stay visible.
                      width: `${Math.max(row.percent * 100, 0.75)}%`,
                      backgroundColor: row.color,
                    }}
                  />
                ))}
              </div>
              <ul className="space-y-0.5">
                {presentation.rows.map((row) => (
                  <li key={row.id} className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-x-2">
                    <span
                      aria-hidden
                      className="h-2 w-2 rounded-sm border border-black/40"
                      style={{ backgroundColor: row.color }}
                    />
                    <span className="truncate">{row.label}</span>
                    <span className="tabular-nums text-muted-foreground">{row.tokensLabel}</span>
                    <span className="w-8 text-right tabular-nums text-muted-foreground">{row.percentLabel}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="space-y-0.5 text-muted-foreground">
            {presentation.footer.map((line, index) => (
              <div key={`${index}-${line}`}>{line}</div>
            ))}
          </div>

          {config.showSystemMessages && presentation.diagnostics.length > 0 && (
            <details className={cn('text-muted-foreground')}>
              <summary className="cursor-pointer select-none text-[10px] uppercase tracking-wide">Diagnostics</summary>
              <div className="mt-1 space-y-0.5">
                {presentation.diagnostics.map((line, index) => (
                  <div key={`${index}-${line}`}>{line}</div>
                ))}
              </div>
            </details>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
