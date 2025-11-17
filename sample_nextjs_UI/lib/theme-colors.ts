/**
 * Get the active session color from CSS variables
 */
export function getActiveSessionColor(): string {
  if (typeof window === 'undefined') return 'oklch(0.7 0.18 240)'
  const root = document.documentElement
  return getComputedStyle(root).getPropertyValue('--avatar-3').trim()
}

/**
 * Parse OKLCH color string and return components
 */
function parseOklch(color: string): { l: number; c: number; h: number } | null {
  const match = color.match(/oklch$$([\d.]+)\s+([\d.]+)\s+([\d.]+)$$/)
  if (!match) return null
  return {
    l: parseFloat(match[1]),
    c: parseFloat(match[2]),
    h: parseFloat(match[3]),
  }
}

/**
 * Create a muted variant by reducing chroma
 * @param color - OKLCH color string
 * @param muteFactor - How much to reduce chroma (0-1, where 1 = no change)
 */
export function getMutedColor(color: string, muteFactor: number = 0.6): string {
  const parsed = parseOklch(color)
  if (!parsed) return color
  
  const mutedChroma = parsed.c * muteFactor
  return `oklch(${parsed.l} ${mutedChroma} ${parsed.h})`
}

/**
 * Get theme colors derived from active session
 */
export function getThemeColors() {
  const activeColor = getActiveSessionColor()
  
  return {
    // Full vibrant color for active session
    active: activeColor,
    conversationActive: getMutedColor(activeColor, 0.35),
    systemMessage: getMutedColor(activeColor, 0.2),
  }
}
