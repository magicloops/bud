import { paneViewport, type ViewportSize } from './viewport-fit.ts'

/** Intended workspace surface, even before the browser pane exists. CSS pixels only. */
export function workspaceViewport(rowWidth: number, rowHeight: number, windowWidth: number, chatWidth: string | null): ViewportSize | null {
  if (rowWidth <= 0 || rowHeight <= 0) return null
  const fraction = chatWidth?.match(/([\d.]+)%/)
  const chat = fraction ? Math.min(rowWidth * .7, Math.max(280, rowWidth * Number(fraction[1]) / 100))
    : windowWidth >= 1024 ? 384 : 320
  return paneViewport(windowWidth < 768 ? rowWidth : rowWidth - chat, rowHeight)
}

/** Call synchronously on send, before clearing the composer or creating a thread. */
export function requestViewport(pane: HTMLElement | null, chatWidth: string | null): ViewportSize | undefined {
  const row = pane?.parentElement
  if (!row) return undefined
  // With a keyboard reducing the layout viewport, omit rather than send a short page.
  if (window.visualViewport && window.visualViewport.height < window.innerHeight * .75) return undefined
  const visible = row.querySelector<HTMLElement>('[data-browser-surface]')?.getBoundingClientRect()
  if (visible && visible.width > 0 && visible.height > 0) return paneViewport(visible.width, visible.height) ?? undefined
  const bounds = row.getBoundingClientRect()
  // On narrow web layouts the composer is absent in the browser peer pane.
  const height = window.innerWidth < 768 ? window.innerHeight - bounds.top : bounds.height
  return workspaceViewport(bounds.width, height, window.innerWidth, chatWidth) ?? undefined
}
