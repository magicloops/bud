/**
 * Pure reducer for the terminal pane's command lifecycle chip, driven by
 * typed `terminal.event` SSE payloads (no heuristic activity inference):
 *
 * - `command_started` → running
 * - `command_finished` → exit code, persists until the next command
 * - `child_exited` → chip cleared (the shell itself is gone)
 *
 * All other event kinds leave the chip unchanged.
 */

export type TerminalCommandChip =
  | { status: 'running'; commandId: string | null }
  | { status: 'finished'; commandId: string | null; exitCode: number | null }

const readCommandId = (data: Record<string, unknown>): string | null =>
  typeof data.command_id === 'string' && data.command_id.length > 0
    ? data.command_id
    : null

export const reduceTerminalCommandChip = (
  current: TerminalCommandChip | null,
  event: { event?: string; data?: unknown },
): TerminalCommandChip | null => {
  const data =
    typeof event.data === 'object' && event.data !== null
      ? (event.data as Record<string, unknown>)
      : {}

  switch (event.event) {
    case 'command_started':
      return { status: 'running', commandId: readCommandId(data) }
    case 'command_finished':
      return {
        status: 'finished',
        commandId: readCommandId(data),
        exitCode:
          typeof data.exit_code === 'number' && Number.isFinite(data.exit_code)
            ? data.exit_code
            : null,
      }
    case 'child_exited':
      return null
    default:
      return current
  }
}
