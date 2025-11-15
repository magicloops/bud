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
