/**
 * Responsive viewport utilities (design/responsive-web-layout.md).
 *
 * Breakpoints (Tailwind-native):
 * - `< md` (767px and below): phone — single-pane shell, ViewMode gains
 *   'chat', rail lives inside the thread drawer, terminal is a geometry
 *   observer.
 * - `md..lg` (768–1023px): tablet — chat + one workbench pane, thread
 *   panel as drawer, rail in-flow.
 * - `>= lg`: desktop, unchanged.
 */

import { useEffect, useState } from 'react'

export const MOBILE_QUERY = '(max-width: 767px)'
/** Thread panel renders as an overlay drawer below `lg`. */
export const COMPACT_QUERY = '(max-width: 1023px)'
export const COARSE_POINTER_QUERY = '(pointer: coarse)'

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false,
  )
  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])
  return matches
}

export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY)
}

export function useIsCompact(): boolean {
  return useMediaQuery(COMPACT_QUERY)
}

export function hasCoarsePointer(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(COARSE_POINTER_QUERY).matches
}

/**
 * Tracks the VISUAL viewport height into `--app-height` on the root
 * element. `100vh`/`100dvh` do not shrink when the iOS soft keyboard
 * opens (the layout viewport is unchanged); sizing the app shell from
 * this variable keeps the composer above the keyboard.
 */
export function useAppHeightVar(): void {
  useEffect(() => {
    const root = document.documentElement
    const vv = window.visualViewport
    let raf: number | null = null
    const apply = () => {
      const height = vv?.height ?? window.innerHeight
      root.style.setProperty('--app-height', `${Math.round(height)}px`)
      // iOS scrolls the PAGE when focusing an input near the keyboard,
      // shifting the visual viewport away from our fixed-height shell —
      // the composer ends up rendered above the visible area ("input
      // jumps to the top, typing invisible"). The shell already fits the
      // visual viewport exactly, so that scroll is never needed: pin the
      // page back after the keyboard settles.
      if (window.scrollY !== 0 || (vv && vv.offsetTop > 0)) {
        if (raf !== null) cancelAnimationFrame(raf)
        raf = requestAnimationFrame(() => {
          raf = null
          window.scrollTo(0, 0)
        })
      }
    }
    apply()
    vv?.addEventListener('resize', apply)
    vv?.addEventListener('scroll', apply)
    window.addEventListener('resize', apply)
    window.addEventListener('scroll', apply, { passive: true })
    return () => {
      vv?.removeEventListener('resize', apply)
      vv?.removeEventListener('scroll', apply)
      window.removeEventListener('resize', apply)
      window.removeEventListener('scroll', apply)
      if (raf !== null) cancelAnimationFrame(raf)
      root.style.removeProperty('--app-height')
    }
  }, [])
}
