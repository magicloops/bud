import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { SettingsNavigation } from './settings-layout'
import { useAuthSession } from '@/contexts/auth-session-context'
import { useRequireAuthenticatedUser } from '@/lib/route-auth'
import { apiFetchJson } from '@/lib/transport'

type Workout = { id: string; start_at: string; duration_s: number; activity_type: string; total_energy_kcal: number | null;
  total_distance_m: number | null; source: { name: string } }
type Night = { night_of: string; asleep_minutes: number; in_bed_minutes: number; stage_minutes: Record<string, number>;
  source: { name: string }; other_sources: { name: string }[] }
type Coverage = { last_received_at: string | null }
const DAY = 86_400_000
const duration = (minutes: number) => `${Math.floor(minutes / 60)} h ${Math.round(minutes % 60)} min`
const stageLabels: Record<string, string> = { asleep_core: 'Core', asleep_deep: 'Deep', asleep_rem: 'REM', asleep_unspecified: 'Asleep', awake: 'Awake' }

/** Owner view of received HealthKit workouts and sleep. Agent and app access are separate permissions. */
export function HealthScreen() {
  const { currentUser } = useAuthSession()
  const user = useRequireAuthenticatedUser(currentUser)
  return user ? <HealthView key={user.user.id} /> : null
}

function HealthView() {
  const [workouts, setWorkouts] = useState<{ items: Workout[]; coverage: Coverage } | null>(null)
  const [sleep, setSleep] = useState<{ items: Night[]; coverage: Coverage } | null>(null)
  const [error, setError] = useState(false)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setError(false); setWorkouts(null); setSleep(null)
    const now = Date.now(), timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    const window = (days: number) => new URLSearchParams({ from: new Date(now - days * DAY).toISOString(), to: new Date(now).toISOString() })
    Promise.all([
      apiFetchJson<{ items: Workout[]; coverage: Coverage }>(`/api/data/health/workouts?${window(30)}&limit=100`, { signal: controller.signal }),
      apiFetchJson<{ items: Night[]; coverage: Coverage }>(`/api/data/health/sleep?${window(14)}&timezone=${encodeURIComponent(timezone)}`, { signal: controller.signal }),
    ]).then(([nextWorkouts, nextSleep]) => { if (!controller.signal.aborted) { setWorkouts(nextWorkouts); setSleep(nextSleep) } })
      .catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => controller.abort()
  }, [refresh])
  const received = (coverage?: Coverage) => coverage?.last_received_at ? `Last received ${new Date(coverage.last_received_at).toLocaleString()}` : 'Nothing received yet'
  return <main className="settings-surface min-h-screen bg-background p-4 sm:p-6 text-foreground">
    <div className="mx-auto max-w-5xl space-y-6">
      <SettingsNavigation />
      <header className="space-y-2"><h1 className="text-2xl font-bold">Health</h1>
        <p className="text-muted-foreground">Workouts and sleep received from your phone's Health app. The first import covers the last 30 days.</p>
        <p className="text-sm text-muted-foreground">HealthKit does not report denied access, so missing records can mean nothing was recorded, Bud cannot read it, or it has not synced yet.</p>
      </header>
      <nav aria-label="Data types" className="flex flex-wrap gap-3 text-sm"><Link to="/data/contacts">Contacts</Link><span aria-current="page" className="font-semibold">Health</span></nav>
      <button className="rounded border px-4 py-2" onClick={() => setRefresh(value => value + 1)}>Refresh received data</button>
      {error && <p role="alert">Could not load health data. Try again.</p>}
      <div className="grid gap-6 md:grid-cols-2">
        <section aria-label="Sleep" className="space-y-2">
          <h2 className="text-xl font-semibold">Sleep · last 14 nights</h2>
          <p className="text-sm text-muted-foreground">{received(sleep?.coverage)}</p>
          {!sleep ? !error && <p>Loading sleep…</p> : !sleep.items.length ? <p>No sleep records in this period.</p>
            : [...sleep.items].reverse().map(night => <div key={night.night_of} className="border-b py-2">
              <p className="font-semibold">Night of {new Date(`${night.night_of}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · {duration(night.asleep_minutes)} asleep</p>
              <p className="text-sm">{Object.entries(night.stage_minutes).filter(([stage]) => stage in stageLabels).map(([stage, minutes]) => `${stageLabels[stage]} ${duration(minutes)}`).join(' · ')}</p>
              <p className="text-xs text-muted-foreground">{night.source.name}{night.other_sources.length ? ` (also recorded by ${night.other_sources.map(source => source.name).join(', ')})` : ''}</p>
            </div>)}
        </section>
        <section aria-label="Workouts" className="space-y-2">
          <h2 className="text-xl font-semibold">Workouts · last 30 days</h2>
          <p className="text-sm text-muted-foreground">{received(workouts?.coverage)}</p>
          {!workouts ? !error && <p>Loading workouts…</p> : !workouts.items.length ? <p>No workouts in this period.</p>
            : [...workouts.items].reverse().map(workout => <div key={workout.id} className="border-b py-2">
              <p className="font-semibold">{workout.activity_type.replaceAll('_', ' ')} · {Math.round(workout.duration_s / 60)} min</p>
              <p className="text-sm">{new Date(workout.start_at).toLocaleString()}{workout.total_distance_m ? ` · ${(workout.total_distance_m / 1000).toFixed(2)} km` : ''}{workout.total_energy_kcal ? ` · ${Math.round(workout.total_energy_kcal)} kcal` : ''}</p>
              <p className="text-xs text-muted-foreground">{workout.source.name}</p>
            </div>)}
        </section>
      </div>
    </div>
  </main>
}
