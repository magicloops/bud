/** Wall-clock schedule math in IANA zones using only Intl (no tz dependency). */

export type AutomationSchedule = { local_time: string; weekdays: number[]; timezone: string };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric",
      day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formatters.set(timeZone, value);
  }
  return value;
}

export function isTimeZone(value: string) {
  try { formatter(value); return true; } catch { return false; }
}

function localParts(instant: number, timeZone: string) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(instant))
    .filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}

function offsetMs(instant: number, timeZone: string) {
  const p = localParts(instant, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instant / 1000) * 1000;
}

/** A nonexistent local time (spring forward) resolves to the shifted instant;
 * an ambiguous one (fall back) resolves to its earlier occurrence. */
export function localTimeToInstant(year: number, month: number, day: number, hour: number, minute: number, timeZone: string) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const first = wall - offsetMs(wall, timeZone);
  const second = wall - offsetMs(first, timeZone);
  const earlier = Math.min(first, second);
  return new Date(localParts(earlier, timeZone).hour === hour ? earlier : Math.max(first, second));
}

function windowOn(schedule: AutomationSchedule, wall: number) {
  const date = new Date(wall);
  const weekday = date.getUTCDay() || 7;
  if (!schedule.weekdays.includes(weekday)) return null;
  const [hour, minute] = schedule.local_time.split(":").map(Number);
  return localTimeToInstant(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute, schedule.timezone);
}

/** Most recent scheduled instant at or before `now`, searching the past eight local days. */
export function latestWindowAtOrBefore(schedule: AutomationSchedule, now: Date): Date | null {
  const today = localParts(now.getTime(), schedule.timezone);
  for (let back = 0; back <= 8; back++) {
    const window = windowOn(schedule, Date.UTC(today.year, today.month - 1, today.day - back));
    if (window && window <= now) return window;
  }
  return null;
}

/** Next scheduled instant strictly after `now`, for display. */
export function nextWindowAfter(schedule: AutomationSchedule, now: Date): Date | null {
  const today = localParts(now.getTime(), schedule.timezone);
  for (let ahead = 0; ahead <= 8; ahead++) {
    const window = windowOn(schedule, Date.UTC(today.year, today.month - 1, today.day + ahead));
    if (window && window > now) return window;
  }
  return null;
}

export function describeLocalWindow(instant: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(instant);
}
