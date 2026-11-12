/** One source from `GET /api/data/sources` (bud-mobile `plan/data-sources-ux`). */
export type DataSource = {
  id: 'location' | 'health' | 'contacts' | (string & {})
  label: string
  enabled: boolean
  changed_at: string | null
  stored: { first_at: string | null; last_received_at: string | null; counts: Record<string, number> }
  installations: { installation_id: string; permission: string; level: string | null; caveats: string[];
    asked_at: string | null; reported_at: string; last_received_at: string | null }[]
  agent: { allowed: boolean }
  apps: { key_id: string; label: string | null; last_used_at: string | null }[]
}
export type DataSourcesDocument = { sources: DataSource[] }

const COUNTS: Record<string, [key: string, one: string, many: string][]> = {
  location: [['visits', 'visit', 'visits'], ['points', 'point', 'points']],
  health: [['workouts', 'workout', 'workouts'], ['sleep_segments', 'sleep record', 'sleep records']],
  contacts: [['contacts', 'contact', 'contacts']],
}

/** "412 visits · 9,120 points", in a fixed order, skipping what is zero. */
export function storedSummary(source: Pick<DataSource, 'id' | 'stored'>): string {
  const parts = (COUNTS[source.id] ?? []).flatMap(([key, one, many]) => {
    const count = source.stored.counts[key] ?? 0
    return count > 0 ? [`${count.toLocaleString('en-US')} ${count === 1 ? one : many}`] : []
  })
  return parts.length ? parts.join(' · ') : 'Nothing yet'
}

/** A phone's iOS permission for a source, as that phone last reported it. */
export function phonePermission(sourceId: string, phone: DataSource['installations'][number]): string {
  switch (phone.permission) {
    case 'not_asked': return 'not asked yet'
    case 'denied': return 'denied; change it in iOS Settings on that phone'
    case 'restricted': return 'restricted on that phone'
    case 'unknowable': return 'asked; iOS does not say whether Health reading is allowed'
    case 'granted': {
      const level = sourceId !== 'location' ? (phone.caveats.includes('limited') ? 'limited access' : 'allowed')
        : phone.level === 'always' ? 'always' : 'only while using the app'
      return phone.caveats.includes('reduced_accuracy') ? `${level}, with Precise Location off` : level
    }
    default: return phone.permission.replaceAll('_', ' ')
  }
}

/** Whether a phone that is meant to collect can't, or can only do it badly. */
export function phoneNeedsAttention(phone: DataSource['installations'][number]): boolean {
  return ['not_asked', 'denied', 'restricted'].includes(phone.permission) || phone.caveats.includes('reduced_accuracy')
}

export const SOURCE_OFF_NOTE = 'Off. Bud keeps what was already sent; your agent and apps can’t read it while this is off.'

export const SOURCE_COLLECTS: Record<string, string> = {
  location: 'Places you visit and large moves, not a continuous track.',
  health: 'Workouts and sleep from the phone’s Health app, starting with the last 30 days.',
  contacts: 'Names, organizations, phone numbers and emails; postal addresses and websites if you choose that on the phone. Pictures and notes are not collected.',
}

/** Who can read a source, in one line. */
export function readersSummary(source: Pick<DataSource, 'enabled' | 'agent' | 'apps'>): string {
  const agent = source.agent.allowed ? 'Your agent' : null
  const apps = source.apps.length ? `${source.apps.length} ${source.apps.length === 1 ? 'app' : 'apps'}` : null
  const who = [agent, apps].filter(Boolean).join(' and ')
  if (!who) return 'Nothing is allowed to read this.'
  return source.enabled ? `${who} can read this.` : `${who} can read this once it is turned back on.`
}

/**
 * What is left before an agent can use a source, as far as the web can tell (plan phase 2). The
 * agent's permission and the switch can be changed here; iOS permission only on the phone, so
 * `phone` says whether some phone has reported that it can collect.
 */
export type WebAccessStep = 'allow_agent' | 'turn_on' | 'continue_on_phone'
export function webAccessSteps(source: Pick<DataSource, 'enabled' | 'agent' | 'installations'>): WebAccessStep[] {
  const steps: WebAccessStep[] = []
  if (!source.agent.allowed) steps.push('allow_agent')
  if (!source.enabled) steps.push('turn_on')
  if (!source.installations.some(phone => phone.permission === 'granted' || phone.permission === 'unknowable')) steps.push('continue_on_phone')
  return steps
}
