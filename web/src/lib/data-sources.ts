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
  apps: { key_id: string; label: string | null; last_used_at: string | null; reads_last_week?: number; last_read_at?: string | null }[]
  /** Who read this source in the last week, most recent first (the access log, plan phase 3). */
  recent_access?: AccessGroup[]
}
export type AccessActor = { kind: 'agent' | 'automation' | 'app' | 'processor' | (string & {}); ref: string; label: string | null; revoked?: boolean }
export type AccessThread = { id: string; turn_id?: string | null; title: string | null; bud_id: string | null; exists: boolean }
export type AccessGroup = { actor: AccessActor; thread: AccessThread | null; reads: number; refused: number; last_at: string }
/** One read, from `GET /api/data/access`. Never content: an operation, a window, a count and an outcome. */
export type AccessEntry = { id: string; at: string; source: string; operation: string; outcome: string; actor: AccessActor
  thread: AccessThread | null; window: { from: string | null; to: string | null } | null; record_count: number | null }
export type AccessPage = { items: AccessEntry[]; next_cursor: string | null }
/** One change to who may read a source, from `GET /api/data/sources/:source/changes`. */
export type SourceChange = { at: string; kind: 'switch' | 'agent' | 'agent_detail' | 'app' | 'request' | (string & {}); enabled?: boolean; by?: string
  outcome?: string; thread_id?: string
  allowed?: boolean; detail?: { history_days?: number; fields?: string[]; health_types?: string[] }; label?: string | null; action?: string }
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
export type WebAccessStep = 'turn_on' | 'continue_on_phone'
export function webAccessSteps(source: Pick<DataSource, 'enabled' | 'agent' | 'installations'>): WebAccessStep[] {
  const steps: WebAccessStep[] = []
  // One click covers both: the switch and the agent's permission (plan phase 2b).
  if (!source.agent.allowed || !source.enabled) steps.push('turn_on')
  if (!source.installations.some(phone => phone.permission === 'granted' || phone.permission === 'unknowable')) steps.push('continue_on_phone')
  return steps
}

const plural = (count: number, one: string, many: string) => `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`

/** Who read: "Your agent", an automation or app by its name, or the outside service. */
export function accessActorName(actor: AccessActor): string {
  switch (actor.kind) {
    case 'agent': return 'Your agent'
    case 'automation': return actor.label ? `${actor.label} (automation)` : 'A deleted automation'
    case 'app': return actor.label ? `${actor.label} (app${actor.revoked ? ', revoked' : ''})` : 'A removed app'
    case 'processor': return `${actor.label ?? actor.ref} (outside service)`
    default: return actor.label ?? actor.kind
  }
}

/** "Your agent · 3 reads, 1 refused · Trip planning": one actor's week. A processor is sent data, so it has lookups. */
export function accessGroupLine(group: AccessGroup): string {
  const sent = group.actor.kind === 'processor'
  const counts = [group.reads > 0 || group.refused === 0 ? plural(group.reads, sent ? 'lookup' : 'read', sent ? 'lookups' : 'reads') : null,
    group.refused > 0 ? `${group.refused.toLocaleString('en-US')} refused` : null].filter(Boolean).join(', ')
  const where = group.actor.kind === 'agent' ? group.thread?.title ?? (group.thread?.exists === false ? 'a deleted conversation' : 'a conversation') : null
  return [accessActorName(group.actor), counts, where].filter(Boolean).join(' · ')
}

const OPERATIONS: Record<string, string> = {
  location_recent: 'Latest location', location_visits: 'Visits', timeline_query: 'Location timeline', location_context: 'Location around a contact',
  places_list: 'Saved places', places_create: 'Saved a place', places_nearby: 'Nearby places', place_details: 'Details of a place',
  contacts_search: 'Contact search', contacts_get: 'One contact', contacts_history: 'A contact’s history',
  health_workouts: 'Workouts', health_sleep: 'Sleep', trigger_evidence: 'What set off a run',
  reverse_geocode: 'A visit’s coordinates, for its address', nearby_search: 'Coordinates, for nearby place names',
  place_search: 'A search near a point on the map',
}
/** What was read, in the user's words; an operation this build doesn't know is shown as it is named. */
export function accessOperation(operation: string): string {
  return OPERATIONS[operation] ?? operation.replaceAll('_', ' ')
}

const REFUSALS: Record<string, string> = {
  source_off: 'refused: the source was off', data_permission_required: 'refused: your agent wasn’t allowed',
  app_data_scope_required: 'refused: not in the app’s permission', history_outside_grant: 'refused: older than the allowed history',
  automation_data_scope: 'refused: not in the automation’s permission', grant_changed: 'withheld: permissions changed during the read',
}
/** "12 records", or why nothing was handed over. */
export function accessOutcome(entry: Pick<AccessEntry, 'outcome' | 'record_count' | 'actor'>): string {
  if (entry.outcome !== 'ok') return REFUSALS[entry.outcome] ?? `not completed (${entry.outcome.replaceAll('_', ' ')})`
  if (entry.actor.kind === 'processor') return 'sent'
  return entry.record_count === null ? 'read' : plural(entry.record_count, 'record', 'records')
}

/** One change to who may read a source, as a sentence. */
export function sourceChangeLine(change: SourceChange): string {
  switch (change.kind) {
    case 'switch': return `Turned ${change.enabled ? 'on' : 'off'}${change.by === 'ios' ? ' on the phone' : change.by === 'web' ? ' on the web'
      : change.by === 'migration' ? ' when switches were introduced' : ''}`
    case 'agent': return change.allowed ? 'Your agent was allowed to read this' : 'Your agent’s access was removed'
    case 'agent_detail': return `Your agent’s access changed${change.detail?.history_days ? `: ${plural(change.detail.history_days, 'day', 'days')} of history` : ''}`
    case 'app': return `${change.label ?? 'An app'} was ${change.action === 'revoked' ? 'revoked' : 'approved'}`
    case 'request': return change.outcome === 'granted' ? 'Your agent asked, and you turned this on'
      : change.outcome === 'declined' ? 'Your agent asked, and you chose not to share' : 'Your agent asked, but the phone doesn’t allow it'
    default: return change.kind.replaceAll('_', ' ')
  }
}

/** The agent's request for a data source (plan phase 2b), from `GET /api/data/source-requests/:id`. */
export type SourceRequest = { request_id: string; source: string; purpose: string; level: string | null
  status: 'pending' | 'granted' | 'declined' | 'unavailable' | 'superseded' | 'canceled' | (string & {})
  result?: { usable?: boolean; reading?: string } | null }

/** The agent's purpose in Bud's sentence. The agent writes only the part after "to". */
export function sourceRequestPurpose(purpose: string): string {
  const words = purpose.trim().replace(/[.!]+$/, '').replace(/^to\s+/i, '')
  return words ? `Your agent wants this to ${words}.` : 'Your agent asked for this.'
}

/** The one line left in the conversation once a request is closed. */
export function sourceRequestClosedLine(request: Pick<SourceRequest, 'status' | 'result'>, label: string): string {
  switch (request.status) {
    case 'granted': return request.result?.reading === 'received' ? `${label} shared, with a fresh reading` : `${label} turned on`
    case 'declined': return `${label} not shared`
    case 'unavailable': return `${label} isn’t available on the phone`
    default: return `${label} request closed`
  }
}
