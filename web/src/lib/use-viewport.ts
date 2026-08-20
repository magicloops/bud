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
    const apply = () => {
      const height = vv?.height ?? window.innerHeight
      root.style.setProperty('--app-height', `${Math.round(height)}px`)
    }
    apply()
    vv?.addEventListener('resize', apply)
    window.addEventListener('resize', apply)
    return () => {
      vv?.removeEventListener('resize', apply)
      window.removeEventListener('resize', apply)
      root.style.removeProperty('--app-height')
    }
  }, [])
}
