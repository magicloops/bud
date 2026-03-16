import { Monitor, Moon, Plus, Server, Settings, Sun } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTheme } from '@/components/theme-provider'
import { useBudStatus } from '@/contexts/bud-status-context'

export type BudCapabilities = {
  sessions?: boolean
  sessions_backends?: string[]
  tmux_version?: string
  terminal?: boolean
  terminal_backends?: string[]
}

export type BudProfile = {
  id: string
  label: string
  accentColor?: string | null
  status: string
  tags?: string[]
  capabilities?: BudCapabilities | null
  lastRun?: {
    run_id: string
    status: string
    exit_code: number | null
    started_at: string | null
    finished_at: string | null
  } | null
}

type BudRailProps = {
  buds: BudProfile[]
  activeBudId: string
  onSelectBud: (id: string) => void
  onOpenSettings: () => void
}

export function BudRail({ buds, activeBudId, onSelectBud, onOpenSettings }: BudRailProps) {
  const { theme, setTheme } = useTheme()
  const { statuses: budStatuses } = useBudStatus()

  const cycleTheme = () => {
    if (theme === 'system') {
      setTheme('light')
    } else if (theme === 'light') {
      setTheme('dark')
    } else {
      setTheme('system')
    }
  }

  return (
    <aside className="flex w-20 flex-col border-r-4 border-black" style={{ backgroundColor: 'var(--sidebar)' }}>
      <div className="flex flex-1 flex-col gap-3 p-3">
        {buds.map((bud, index) => {
          const isActive = bud.id === activeBudId
          const accent = bud.accentColor ?? 'var(--sidebar-primary)'
          // Use real-time status from context if available, otherwise fall back to loader data
          const liveStatus = budStatuses[bud.id] ?? bud.status
          const isOnline = liveStatus === 'online'
          return (
            <button
              key={bud.id}
              onClick={() => onSelectBud(bud.id)}
              className={cn(
                'group relative flex h-14 w-14 flex-col items-center justify-center rounded-xl border-3 border-black text-center transition-all',
                'hover:-translate-y-0.5 active:translate-y-0',
                isActive ? 'translate-y-0 border-black shadow-none' : 'shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]'
              )}
              style={{
                backgroundColor: accent,
                opacity: isActive ? 1 : 0.55,
              }}
            >
              <Server className="h-4 w-4 text-black" />
              <span className="mt-1 font-mono text-[11px] font-bold text-black">{index + 1}</span>
              <span
                className="absolute bottom-2 right-2 h-3 w-3 rounded-full border border-black"
                style={{ backgroundColor: isOnline ? '#16a34a' : '#f97316' }}
              />
            </button>
          )
        })}
        <button
          className="flex h-14 w-14 items-center justify-center rounded-xl border-3 border-dashed border-black bg-muted/60 text-muted-foreground transition-all hover:-translate-y-0.5"
          style={{ boxShadow: '4px 4px 0px 0px rgba(0,0,0,1)' }}
        >
          <Plus className="h-5 w-5" />
        </button>
      </div>
      <div className="flex flex-col gap-2 p-2">
        <button
          onClick={cycleTheme}
          className="flex h-14 w-14 items-center justify-center rounded-xl border-3 border-black text-black transition-all hover:-translate-y-0.5"
          style={{ boxShadow: '4px 4px 0px 0px rgba(0,0,0,1)', backgroundColor: 'var(--bud-accent-muted)' }}
          title={`Theme: ${theme}`}
        >
          {theme === 'light' ? <Sun className="h-6 w-6" /> : theme === 'dark' ? <Moon className="h-6 w-6" /> : <Monitor className="h-6 w-6" />}
        </button>
        <button
          onClick={onOpenSettings}
          className="flex h-14 w-14 items-center justify-center rounded-xl border-3 border-black text-black transition-all hover:-translate-y-0.5"
          style={{ boxShadow: '4px 4px 0px 0px rgba(0,0,0,1)', backgroundColor: 'var(--bud-accent-muted)' }}
          title="Account settings"
        >
          <Settings className="h-6 w-6" />
        </button>
      </div>
    </aside>
  )
}
