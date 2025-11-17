import type { FormEvent } from 'react'
import { Send } from 'lucide-react'
import { Button } from '@/components/ui/button'

type CommandComposerProps = {
  messageText: string
  onMessageChange: (value: string) => void
  status: 'idle' | 'dispatching' | 'streaming'
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  error: string | null
}

export function CommandComposer({ messageText, onMessageChange, status, onSubmit, error }: CommandComposerProps) {
  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      if (!status || status === 'idle' || status === 'streaming') {
        ;(event.currentTarget.form as HTMLFormElement | null)?.requestSubmit()
      }
    }
  }

  return (
    <form onSubmit={onSubmit} className="relative border-t-4 border-black bg-background">
      {error && <div className="px-4 pt-3 text-xs text-destructive">{error}</div>}
      <textarea
        value={messageText}
        onChange={(e) => onMessageChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Describe the task for Bud…"
        className="h-32 w-full resize-none bg-background p-4 pr-16 font-mono text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
        disabled={status === 'dispatching'}
      />
      <Button
        type="submit"
        size="icon"
        disabled={status === 'dispatching'}
        className="absolute bottom-4 right-4 h-12 w-12 rounded-lg border-3 border-black text-black transition-all hover:-translate-y-0.5 disabled:opacity-60"
        style={{ backgroundColor: 'var(--bud-accent-muted)' }}
      >
        <Send className="h-4 w-4" />
      </Button>
    </form>
  )
}
