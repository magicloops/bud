type ParsedOklch = {
  l: number
  c: number
  h: number
}

const OKLCH_RE = /oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/

function parseOklch(color: string): ParsedOklch | null {
  const match = color.match(OKLCH_RE)
  if (!match) return null
  return {
    l: Number(match[1]),
    c: Number(match[2]),
    h: Number(match[3]),
  }
}

export function getMutedColor(color: string, muteFactor = 0.6): string {
  const parsed = parseOklch(color)
  if (!parsed) return color
  return `oklch(${parsed.l} ${parsed.c * muteFactor} ${parsed.h})`
}

export function resolveCssVar(variable: string): string {
  if (typeof window === 'undefined') return variable
  const root = document.documentElement
  const name = variable.replace('var(', '').replace(')', '')
  const value = getComputedStyle(root).getPropertyValue(name).trim()
  return value || variable
}

// Bud accent palette. MUST stay identical to BUD_ACCENT_PALETTE in
// service/src/bud-accent.ts (same colors, same order, same hash below): the
// service persists a palette color at claim time and derives the same
// fallback for legacy rows, so client and server always agree.
export const DEFAULT_AVATAR_COLORS = [
  'oklch(0.70 0.25 330)',
  'oklch(0.65 0.24 50)',
  'oklch(0.68 0.22 190)',
  'oklch(0.72 0.23 280)',
  'oklch(0.66 0.21 140)'
]

/** 32-bit FNV-1a over UTF-16 code units (mirrors the service's fnv1a32). */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * Order-independent fallback accent for a Bud with no persisted
 * `accent_color`: a pure function of the id, never of its position in the
 * bud list (that list is ordered by last_seen_at, which moves with every
 * heartbeat — see debug/bud-accent-color-flips-between-chats.md).
 */
export function budAccentColorFor(budId: string): string {
  return DEFAULT_AVATAR_COLORS[fnv1a32(budId) % DEFAULT_AVATAR_COLORS.length] ?? 'var(--accent)'
}

export function deriveBudPalette(color: string) {
  const resolved = resolveCssVar(color) || resolveCssVar('var(--accent)')
  return {
    vibrant: resolved,
    muted: getMutedColor(resolved, 0.85),
    soft: getMutedColor(resolved, 0.7)
  }
}
