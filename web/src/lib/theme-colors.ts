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

// Bud accent palette. MUST stay identical (colors AND order) to
// BUD_ACCENT_PALETTE in service/src/bud-accent.ts, which also implements the
// same first-free-in-creation-order rule below: the service persists a palette
// color at claim time and resolves legacy NULL rows the same way, so client
// and server always agree.
export const DEFAULT_AVATAR_COLORS = [
  'oklch(0.70 0.25 330)',
  'oklch(0.65 0.24 50)',
  'oklch(0.68 0.22 190)',
  'oklch(0.72 0.23 280)',
  'oklch(0.66 0.21 140)'
]

/**
 * The next color to hand out given the colors already in use: the first
 * palette color (in palette order) with the fewest uses. Unknown / null
 * entries are ignored. Mirrors the service's pickNextAccentColor.
 */
export function pickNextAccentColor(takenColors: Iterable<string | null | undefined>): string {
  const counts = new Map<string, number>(DEFAULT_AVATAR_COLORS.map((color) => [color, 0]))
  for (const color of takenColors) {
    if (color && counts.has(color)) {
      counts.set(color, (counts.get(color) ?? 0) + 1)
    }
  }
  let best = DEFAULT_AVATAR_COLORS[0] ?? 'var(--accent)'
  let bestCount = Number.POSITIVE_INFINITY
  for (const color of DEFAULT_AVATAR_COLORS) {
    const count = counts.get(color) ?? 0
    if (count < bestCount) {
      best = color
      bestCount = count
    }
  }
  return best
}

type AccentBud = {
  bud_id: string
  accent_color?: string | null
  created_at?: string | null
}

function creationOrder(a: AccentBud, b: AccentBud): number {
  const at = a.created_at ? new Date(a.created_at).getTime() : 0
  const bt = b.created_at ? new Date(b.created_at).getTime() : 0
  if (at !== bt) return at - bt
  return a.bud_id < b.bud_id ? -1 : a.bud_id > b.bud_id ? 1 : 0
}

/**
 * Fallback accents for buds the API returned without one (older services):
 * assigned positionally by creation order (oldest first: pink, orange, …),
 * skipping colors already taken by persisted accents. Never keyed on the
 * list's own order, which follows last_seen_at and moves with every
 * heartbeat (debug/bud-accent-color-flips-between-chats.md). Input order is
 * preserved.
 */
export function withFallbackAccentColors<T extends AccentBud>(buds: readonly T[]): T[] {
  const taken: string[] = buds.map((bud) => bud.accent_color).filter((color): color is string => Boolean(color))
  const assigned = new Map<string, string>()
  for (const bud of [...buds].sort(creationOrder)) {
    if (bud.accent_color) continue
    const color = pickNextAccentColor(taken)
    taken.push(color)
    assigned.set(bud.bud_id, color)
  }
  return buds.map((bud) => {
    const color = assigned.get(bud.bud_id)
    return color ? { ...bud, accent_color: color } : bud
  })
}
