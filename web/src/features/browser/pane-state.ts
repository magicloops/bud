export function browserSessionId(value: unknown): string | null {
  return typeof value === 'string' && /^browser_[0-9A-HJKMNP-TV-Z]{26}$/.test(value) ? value : null
}
export function browserPathSession(value: unknown): string | null {
  return typeof value === 'string' && value.startsWith('/browser/') ? browserSessionId(value.slice(9)) : null
}
export function browserReveal(payload: Record<string, unknown>): { id: string; key: string } | null {
  if (!payload || typeof payload !== 'object') return null
  const handoff = browserPathSession(payload.viewer_path)
  if (handoff && typeof payload.handoff_id === 'string')
    return { id: handoff, key: `handoff:${payload.handoff_id}` }
  return null
}
/** A visit-local baseline: neither replay nor repeated polls override dismissal. */
export class BrowserRevealTracker {
  private seen = new Set<string>()
  seed(key: string) { this.seen.add(key) }
  accept(key: string) {
    if (this.seen.has(key)) return false
    this.seen.add(key)
    return true
  }
}
