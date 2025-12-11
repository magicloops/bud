import type { ToolContentRendererProps } from '../types'

/**
 * Renders the command/input for terminal.run tool calls.
 * Shows the shell command in a styled code block.
 */
export function TerminalRunContent({ payload }: ToolContentRendererProps) {
  const input = (payload.input as string | undefined)?.trim()

  if (!input) return null

  return (
    <div className="rounded-md bg-black/90 px-3 py-2 font-mono text-[12px] leading-relaxed">
      <span className="select-none text-green-600/70">$ </span>
      <span className="whitespace-pre-wrap text-green-400">{input}</span>
    </div>
  )
}
