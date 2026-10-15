import type { ApiAutomationDefinition, ApiAutomationSchedule, ApiWorkoutFilter } from '@/lib/api-types'

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

/** Common workout types, matching the health `activity_type` values. */
export const WORKOUT_ACTIVITIES = ['running', 'walking', 'cycling', 'swimming', 'hiking', 'yoga', 'traditional_strength_training',
  'functional_strength_training', 'high_intensity_interval_training', 'elliptical', 'rowing', 'dance', 'pilates', 'other']

export const activityLabel = (activity: string) => activity.replaceAll('_', ' ')

/** e.g. "After each running or cycling workout of at least 20 minutes". */
export function describeWorkoutFilter(filter: ApiWorkoutFilter) {
  const kinds = filter.activity_types.length ? `${filter.activity_types.map(activityLabel).join(' or ')} workout` : 'workout'
  return `After each ${kinds}${filter.min_duration_minutes ? ` of at least ${filter.min_duration_minutes} minutes` : ''}`
}

export function describeTrigger(definition: Pick<ApiAutomationDefinition, 'event_type'> & Partial<{ schedule: ApiAutomationSchedule; workout_filter: ApiWorkoutFilter }>) {
  if (definition.event_type === 'schedule' && definition.schedule) return describeSchedule(definition.schedule)
  if (definition.event_type === 'workout.completed' && definition.workout_filter) return describeWorkoutFilter(definition.workout_filter)
  return 'When a new contact is observed'
}
