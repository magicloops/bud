/**
 * Terminal renderer selection (plan/terminal-grid-sync phase 2 §8).
 *
 * `grid` = server-authoritative grid deltas (default since the phase 0–3
 * rollout completed browser validation + human dogfooding).
 * `bytes` = xterm.js over the raw output stream (legacy fallback).
 * Resolution order: `?renderer=` URL override, then the persisted per-user
 * preference, then `grid`. Resolved once per mount — switching reconnects
 * the terminal.
 */

export type TerminalRendererMode = 'bytes' | 'grid'

export const TERMINAL_RENDERER_STORAGE_KEY = 'bud.terminal.renderer'

export function resolveTerminalRendererMode(
  search: string,
  storage: Pick<Storage, 'getItem'> | null,
): TerminalRendererMode {
  const override = new URLSearchParams(search).get('renderer')
  if (override === 'grid' || override === 'bytes') {
    return override
  }
  try {
    const stored = storage?.getItem(TERMINAL_RENDERER_STORAGE_KEY)
    if (stored === 'grid' || stored === 'bytes') {
      return stored
    }
  } catch {
    // Storage unavailable (private mode) — fall through to the default.
  }
  return 'grid'
}
