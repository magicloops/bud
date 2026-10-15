import type { ApiAutomationDefinition, ApiAutomationSchedule } from '@/lib/api-types'

export const WEEKDAYS = [
  { value: 1, short: 'Mon' }, { value: 2, short: 'Tue' }, { value: 3, short: 'Wed' }, { value: 4, short: 'Thu' },
  { value: 5, short: 'Fri' }, { value: 6, short: 'Sat' }, { value: 7, short: 'Sun' },
]

export function deviceTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

export function defaultSchedule(): ApiAutomationSchedule {
  return { local_time: '09:00', weekdays: [1, 2, 3, 4, 5, 6, 7], timezone: deviceTimeZone() }
}

function describeDays(weekdays: number[]) {
  const days = [...weekdays].sort((a, b) => a - b)
  if (days.length === 7) return 'Every day'
  if (days.join() === '1,2,3,4,5') return 'Weekdays'
  if (days.join() === '6,7') return 'Weekends'
  return days.map(day => WEEKDAYS.find(entry => entry.value === day)?.short ?? String(day)).join(', ')
}

/** e.g. "Weekdays at 08:30 (America/Los_Angeles)". */
export function describeSchedule(schedule: ApiAutomationSchedule) {
  return `${describeDays(schedule.weekdays)} at ${schedule.local_time} (${schedule.timezone})`
}

export function describeTrigger(definition: Pick<ApiAutomationDefinition, 'event_type'> & Partial<{ schedule: ApiAutomationSchedule }>) {
  return definition.event_type === 'schedule' && definition.schedule ? describeSchedule(definition.schedule) : 'When a new contact is observed'
}
