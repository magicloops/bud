import { Menu } from 'lucide-react'
import { Button } from '@/components/ui/button'

type WorkspaceTopBarProps = {
  budLabel: string
  onToggleThreads: () => void
  status: 'idle' | 'dispatching' | 'streaming'
}

export function WorkspaceTopBar({
  budLabel,
  onToggleThreads,
  status
}: WorkspaceTopBarProps) {
  return (
    <div className="flex h-16 items-center justify-between border-b-4 border-black px-6" style={{ backgroundColor: 'var(--chat-bg)' }}>
        <div className="flex items-center gap-4">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onToggleThreads}
            className="h-10 w-10 rounded-lg border-3 border-black transition-all hover:-translate-y-0.5"
            style={{ boxShadow: '3px 3px 0px rgba(0,0,0,1)' }}
          >
            <Menu className="h-5 w-5" />
          </Button>
          <div className="flex flex-col">
            <p className="font-mono text-lg font-semibold">{budLabel}</p>
          </div>
        </div>
      <div className="flex items-center gap-2">
        <span className="text-xs font-mono uppercase tracking-wide text-muted-foreground">
          {status === 'dispatching' ? 'Dispatching' : status === 'streaming' ? 'Streaming' : 'Idle'}
        </span>
      </div>
    </div>
  )
}
