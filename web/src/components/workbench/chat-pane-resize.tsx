import { useEffect, useRef, useState } from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react'

/**
 * Drag-to-resize for the chat pane ↔ terminal/web/file divider.
 *
 * The pane keeps its responsive default widths (`md:w-[var(--chat-pane-width,
 * 20rem)] lg:w-[var(--chat-pane-width,24rem)]`); a custom width only sets the
 * CSS variable, so mobile (`max-md:w-full`) is untouched. The width persists
 * per browser in localStorage and is shared by the thread and new-thread
 * routes so the divider does not jump between them.
 */

const STORAGE_KEY = 'bud:chat-pane-width'
const MIN_WIDTH_PX = 280
const MAX_WIDTH_FRACTION = 0.7
const KEYBOARD_STEP_PX = 24

const clampWidth = (width: number): number => {
  const max = Math.max(MIN_WIDTH_PX, Math.round(window.innerWidth * MAX_WIDTH_FRACTION))
  return Math.min(Math.max(Math.round(width), MIN_WIDTH_PX), max)
}

export function useChatPaneWidth() {
  const [width, setWidth] = useState<number | null>(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY)
      const parsed = stored === null ? NaN : Number.parseInt(stored, 10)
      return Number.isFinite(parsed) ? clampWidth(parsed) : null
    } catch {
      return null
    }
  })

  useEffect(() => {
    try {
      if (width === null) {
        window.localStorage.removeItem(STORAGE_KEY)
      } else {
        window.localStorage.setItem(STORAGE_KEY, String(width))
      }
    } catch {
      // Per-viewer convenience only; losing it is fine.
    }
  }, [width])

  return { width, setWidth }
}

/**
 * Left inset that aligns the full-width composer's content with the
 * transcript column inside the chat pane. Mirrors ChatTimeline's wrapper
 * geometry — `mx-auto max-w-[1024px]`, `p-2` base / 30px gutters from the
 * @md (28rem) container query, plus the rows' 3px rail; the rows' `px-4`
 * and the textarea's `px-4` cancel out. Keep in sync with chat-timeline.
 */
const TRANSCRIPT_MAX_WIDTH_PX = 1024
const TRANSCRIPT_GUTTER_WIDE_PX = 30
const TRANSCRIPT_GUTTER_NARROW_PX = 8
const TRANSCRIPT_GUTTER_BREAKPOINT_PX = 448
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
        width >= TRANSCRIPT_GUTTER_BREAKPOINT_PX
          ? TRANSCRIPT_GUTTER_WIDE_PX
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
  onWidthChange: (width: number | null) => void
}

/**
 * The draggable strip over the pane's right border. Renders inside the
 * (relative) chat pane, md+ only. Pointer capture keeps the drag alive over
 * the terminal/iframe; double-click resets to the responsive defaults;
 * arrow keys nudge when focused.
 */
export function ChatPaneResizeHandle({ paneRef, onWidthChange }: ChatPaneResizeHandleProps) {
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
    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }
    onWidthChange(clampWidth(drag.startWidth + (event.clientX - drag.startX)))
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
    onWidthChange(clampWidth(pane.getBoundingClientRect().width + delta))
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
      onDoubleClick={() => onWidthChange(null)}
      onKeyDown={handleKeyDown}
      className="absolute inset-y-0 -right-1.5 z-30 hidden w-3 cursor-col-resize touch-none select-none hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:outline-none active:bg-foreground/15 md:block"
    />
  )
}
