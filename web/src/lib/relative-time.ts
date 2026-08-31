/**
 * Coarse "3 hours ago" labels for transcript timestamps. Not live-ticking:
 * callers render it on demand (hover) and staleness within a re-render is
 * acceptable.
 */
export const formatRelativeTimestamp = (iso: string, nowMs = Date.now()): string => {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) {
    return ''
  }
  const diffMs = Math.max(0, nowMs - then)
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) {
    return 'just now'
  }
  if (minutes < 60) {
    return plural(minutes, 'minute')
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return plural(hours, 'hour')
  }
  const days = Math.floor(hours / 24)
  if (days < 30) {
    return plural(days, 'day')
  }
  const months = Math.floor(days / 30)
  if (months < 12) {
    return plural(months, 'month')
  }
  return plural(Math.floor(days / 365), 'year')
}

const plural = (count: number, unit: string): string =>
  `${count} ${unit}${count === 1 ? '' : 's'} ago`
