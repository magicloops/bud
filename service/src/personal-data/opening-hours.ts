import OpeningHours from "opening_hours";

/**
 * Whether a place is open now, from its OpenStreetMap `opening_hours` (Phase 13), at the place's
 * local time. `opening_hours` reads a Date's local fields, and the service runs in UTC, so it's
 * given a Date whose local fields are the place's wall-clock time. Null when there are no hours or
 * the parser can't decide (unknown or unparseable values), never a guess.
 */
export function openNow(hours: unknown, timeZone: string | null, now = new Date()): { open_now: boolean | null; next_change: string | null } {
  if (typeof hours !== "string" || !hours.trim()) return { open_now: null, next_change: null };
  try {
    const wall = wallClock(now, timeZone ?? "UTC");
    const parsed = new OpeningHours(hours);
    if (parsed.getUnknown(wall)) return { open_now: null, next_change: null };
    const next = parsed.getNextChange(wall);
    // The next change is in the same wall-clock frame: shift it back onto the real timeline.
    return { open_now: parsed.getState(wall), next_change: next ? new Date(now.getTime() + (next.getTime() - wall.getTime())).toISOString() : null };
  } catch { return { open_now: null, next_change: null }; }
}

/** A Date whose local fields are `now`'s wall-clock time in `timeZone`. */
function wallClock(now: Date, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric",
    day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(now).map(part => [part.type, part.value]));
  return new Date(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
}
