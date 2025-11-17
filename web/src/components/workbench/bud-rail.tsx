import { Monitor, Moon, Plus, Server, Sun } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTheme } from '@/components/theme-provider'

export type BudProfile = {
  id: string
  label: string
  accentColor?: string | null
  status: string
  tags?: string[]
  capabilities?: string[]
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
  collapsed: boolean
  onToggleCollapsed: (collapsed: boolean) => void
}

export function BudRail({ buds, activeBudId, onSelectBud, collapsed, onToggleCollapsed }: BudRailProps) {
  const { theme, setTheme } = useTheme()

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
    <aside
      className={cn(
        'flex flex-col border-r-4 border-black transition-all duration-200',
        collapsed ? 'w-20' : 'w-24'
      )}
      style={{ backgroundColor: 'var(--sidebar)' }}
    >
      <div className="flex flex-1 flex-col gap-3 p-3">
        {buds.map((bud, index) => {
          const isActive = bud.id === activeBudId
          const accent = bud.accentColor ?? 'var(--sidebar-primary)'
          return (
            <button
              key={bud.id}
              onClick={() => onSelectBud(bud.id)}
              className={cn(
                'group relative flex h-16 w-16 flex-col items-center justify-center rounded-xl border-3 border-black text-center transition-all',
                'hover:-translate-y-0.5 active:translate-y-0',
                isActive ? 'translate-y-0 border-black shadow-none' : 'shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]'
              )}
              style={{
                backgroundColor: accent,
                opacity: isActive ? 1 : 0.55,
              }}
            >
              <Server className="h-5 w-5 text-black" />
              <span className="mt-1 font-mono text-xs font-bold text-black">{index + 1}</span>
              <span
                className="absolute bottom-2 right-2 h-3 w-3 rounded-full border border-black"
                style={{ backgroundColor: bud.status === 'online' ? '#16a34a' : '#f97316' }}
              />
            </button>
          )
        })}
        <button
          className="flex h-16 w-16 items-center justify-center rounded-xl border-3 border-dashed border-black bg-muted/60 text-muted-foreground transition-all hover:-translate-y-0.5"
          style={{ boxShadow: '4px 4px 0px 0px rgba(0,0,0,1)' }}
          onClick={() => onToggleCollapsed(!collapsed)}
        >
          {collapsed ? <Monitor className="h-5 w-5" /> : <Plus className="h-5 w-5" />}
        </button>
      </div>
      <div className="p-3">
        <button
          onClick={cycleTheme}
          className="flex h-16 w-16 items-center justify-center rounded-xl border-3 border-black bg-accent text-accent-foreground transition-all hover:-translate-y-0.5"
          style={{ boxShadow: '4px 4px 0px 0px rgba(0,0,0,1)' }}
          title={`Theme: ${theme}`}
        >
          {theme === 'light' ? <Sun className="h-6 w-6" /> : theme === 'dark' ? <Moon className="h-6 w-6" /> : <Monitor className="h-6 w-6" />}
        </button>
      </div>
    </aside>
  )
}
