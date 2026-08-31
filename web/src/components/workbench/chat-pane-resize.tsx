import { useEffect, useRef, useState } from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react'

/**
 * Drag-to-resize for the chat pane ↔ terminal/web/file divider.
 *
 * The dragged position is stored as a FRACTION of the pane row, not
 * pixels, so opening the thread panel or resizing the window shrinks both
 * sides proportionally (a 50/50 split stays 50/50). The pane keeps its
 * responsive default widths (`md:w-[var(--chat-pane-width,20rem)]
 * lg:w-[var(--chat-pane-width,24rem)]`); a custom split only sets the CSS
 * variable — to a `clamp(280px, N%, 70%)` value — so mobile
 * (`max-md:w-full`) is untouched. Persists per browser in localStorage,
 * shared by the thread and new-thread routes.
 */

const STORAGE_KEY = 'bud:chat-pane-fraction'
const MIN_WIDTH_PX = 280
const MIN_FRACTION = 0.1
const MAX_FRACTION = 0.7
const KEYBOARD_STEP_PX = 24

const clampFraction = (fraction: number): number =>
  Math.min(Math.max(fraction, MIN_FRACTION), MAX_FRACTION)

const fractionToCssWidth = (fraction: number): string =>
  `clamp(${MIN_WIDTH_PX}px, ${(fraction * 100).toFixed(2)}%, ${MAX_FRACTION * 100}%)`

/** The pane's share of its flex row, from a proposed pixel width. */
const fractionForWidth = (pane: HTMLElement, widthPx: number): number | null => {
  const rowWidth = pane.parentElement?.getBoundingClientRect().width ?? 0
  if (rowWidth <= 0) {
    return null
  }
  return clampFraction(widthPx / rowWidth)
}

export function useChatPaneWidth() {
  const [fraction, setFraction] = useState<number | null>(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY)
      const parsed = stored === null ? NaN : Number.parseFloat(stored)
      return Number.isFinite(parsed) ? clampFraction(parsed) : null
    } catch {
      return null
    }
  })

  useEffect(() => {
    try {
      if (fraction === null) {
        window.localStorage.removeItem(STORAGE_KEY)
      } else {
        window.localStorage.setItem(STORAGE_KEY, fraction.toFixed(4))
      }
    } catch {
      // Per-viewer convenience only; losing it is fine.
    }
  }, [fraction])

  return { width: fraction === null ? null : fractionToCssWidth(fraction), setFraction }
}

/**
 * Left inset that aligns the full-width composer's content with the
 * transcript column inside the chat pane. Mirrors ChatTimeline's wrapper
 * geometry — `mx-auto max-w-[820px]`, gutters of 8px base / 15px from the
 * @md (28rem) container query / 30px from @3xl (48rem), plus the rows'
 * 3px rail; the rows' `px-4` and the textarea's `px-4` cancel out. Keep
 * in sync with chat-timeline.
 */
const TRANSCRIPT_MAX_WIDTH_PX = 820
const TRANSCRIPT_GUTTER_WIDE_PX = 30
const TRANSCRIPT_GUTTER_MID_PX = 15
const TRANSCRIPT_GUTTER_NARROW_PX = 8
const TRANSCRIPT_GUTTER_WIDE_BREAKPOINT_PX = 768
const TRANSCRIPT_GUTTER_MID_BREAKPOINT_PX = 448
const TRANSCRIPT_RAIL_PX = 3

export function useComposerContentInset(paneRef: RefObject<HTMLDivElement | null>): number | null {
  const [inset, setInset] = useState<number | null>(null)

  useEffect(() => {
    const node = paneRef.current
    if (!node || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0
      if (width <= 0) {
        return // hidden pane (mobile non-chat view) — keep the last inset
      }
      const centering = Math.max(0, (width - TRANSCRIPT_MAX_WIDTH_PX) / 2)
      const gutter =
        width >= TRANSCRIPT_GUTTER_WIDE_BREAKPOINT_PX
          ? TRANSCRIPT_GUTTER_WIDE_PX
          : width >= TRANSCRIPT_GUTTER_MID_BREAKPOINT_PX
            ? TRANSCRIPT_GUTTER_MID_PX
            : TRANSCRIPT_GUTTER_NARROW_PX
      setInset(Math.round(centering + gutter + TRANSCRIPT_RAIL_PX))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [paneRef])

  return inset
}

type ChatPaneResizeHandleProps = {
  paneRef: RefObject<HTMLDivElement | null>
  onFractionChange: (fraction: number | null) => void
}

/**
 * The draggable strip over the pane's right border. Renders inside the
 * (relative) chat pane, md+ only. Pointer capture keeps the drag alive over
 * the terminal/iframe; double-click resets to the responsive defaults;
 * arrow keys nudge when focused.
 */
export function ChatPaneResizeHandle({ paneRef, onFractionChange }: ChatPaneResizeHandleProps) {
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pane = paneRef.current
    if (!pane) {
      return
    }
    event.preventDefault()
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: pane.getBoundingClientRect().width,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    const pane = paneRef.current
    if (!drag || !pane || drag.pointerId !== event.pointerId) {
      return
    }
    const fraction = fractionForWidth(pane, drag.startWidth + (event.clientX - drag.startX))
    if (fraction !== null) {
      onFractionChange(fraction)
    }
  }

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null
    }
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return
    }
    const pane = paneRef.current
    if (!pane) {
      return
    }
    event.preventDefault()
    const delta = event.key === 'ArrowLeft' ? -KEYBOARD_STEP_PX : KEYBOARD_STEP_PX
    const fraction = fractionForWidth(pane, pane.getBoundingClientRect().width + delta)
    if (fraction !== null) {
      onFractionChange(fraction)
    }
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize chat pane"
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => onFractionChange(null)}
      onKeyDown={handleKeyDown}
      className="absolute inset-y-0 -right-1.5 z-30 hidden w-3 cursor-col-resize touch-none select-none hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:outline-none active:bg-foreground/15 md:block"
    />
  )
}
