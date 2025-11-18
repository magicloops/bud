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

export const DEFAULT_AVATAR_COLORS = [
  'oklch(0.70 0.25 330)',
  'oklch(0.65 0.24 50)',
  'oklch(0.68 0.22 190)',
  'oklch(0.72 0.23 280)',
  'oklch(0.66 0.21 140)'
]

export function deriveBudPalette(color: string) {
  const resolved = resolveCssVar(color) || resolveCssVar('var(--accent)')
  return {
    vibrant: resolved,
    muted: getMutedColor(resolved, 0.6),
    soft: getMutedColor(resolved, 0.35)
  }
}
