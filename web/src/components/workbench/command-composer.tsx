import type { FormEvent } from 'react'
import { Send } from 'lucide-react'
import { Button } from '@/components/ui/button'

type CommandComposerProps = {
  messageText: string
  onMessageChange: (value: string) => void
  cwd: string
  onCwdChange: (value: string) => void
  status: 'idle' | 'dispatching' | 'streaming'
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  error: string | null
}

export function CommandComposer({ messageText, onMessageChange, cwd, onCwdChange, status, onSubmit, error }: CommandComposerProps) {
  return (
    <form onSubmit={onSubmit} className="border-t-4 border-black bg-background/90 px-4 py-3">
      <div className="mb-3 flex items-center gap-3">
        <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          CWD
          <input
            className="mt-1 w-48 rounded-lg border-2 border-black bg-card px-3 py-2 font-mono text-sm"
            value={cwd}
            placeholder="~"
            onChange={(e) => onCwdChange(e.target.value)}
          />
        </label>
        <div className="text-xs text-destructive">{error}</div>
      </div>
      <div className="relative">
        <textarea
          rows={4}
          value={messageText}
          onChange={(e) => onMessageChange(e.target.value)}
          placeholder="Describe the task for Bud…"
          className="w-full resize-none rounded-2xl border-4 border-black bg-card p-4 pr-16 font-mono text-sm leading-relaxed shadow-[4px_4px_0px_rgba(0,0,0,1)] outline-none"
          disabled={status === 'dispatching'}
        />
        <Button
          type="submit"
          size="icon"
          disabled={status === 'dispatching'}
          className="absolute bottom-6 right-6 h-12 w-12 rounded-xl border-3 border-black bg-accent text-accent-foreground transition-all hover:-translate-y-0.5 disabled:opacity-60"
          style={{ boxShadow: '3px 3px 0px rgba(0,0,0,1)' }}
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </form>
  )
}
