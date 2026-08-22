import type { TerminalCommandChip } from '@/features/threads/terminal-command-state'
import type { TerminalGridState } from '@/features/threads/terminal-grid-state'

/**
 * Fact-gated interrupt affordance (post-stem contextual UI): decide whether
 * an Interrupt (Ctrl+C) control should be visible, from the typed facts the
 * stream already carries — never from elapsed time.
 *
 * Signals, in order:
 * - Full-screen apps suppress it first: in the alt screen (grid fact) or
 *   `tui` mode (event fact), Ctrl+C is just a keystroke — often not "stop"
 *   (vim) — so no interrupt affordance, even while the launching command is
 *   still open.
 * - An open command (`command_started` without `command_finished`) shows it:
 *   this is "stop the running command".
 * - With grid frames available, the daemon-computed predictive-echo gate is
 *   the busy bit: `predict_ok` is true exactly at an interactive prompt
 *   (mode ∈ shell/repl, no open command, primary screen, not a silent
 *   password read), so `!predict_ok` also covers busy REPLs, `unknown` mode
 *   (honest fallback: gate never opens there), and password prompts.
 * - Bytes renderer (no grid frames): only the command chip gates it, so
 *   behavior degrades to the pre-grid contract without inventing a busy
 *   signal.
 */
export function showTerminalInterrupt(inputs: {
  connection: 'connected' | 'reconnecting' | 'offline' | 'disconnected'
  chip: TerminalCommandChip | null
  /** `mode` from `terminal.event` facts (null before the first fact). */
  mode: 'shell' | 'tui' | 'repl' | 'unknown' | null
  /** Pass null when the bytes renderer is active (no grid frames flow). */
  grid: Pick<TerminalGridState, 'seeded' | 'altScreen' | 'predictOk'> | null
}): boolean {
  if (inputs.connection !== 'connected') {
    return false
  }
  if (inputs.grid?.seeded ? inputs.grid.altScreen : inputs.mode === 'tui') {
    return false
  }
  if (inputs.chip?.status === 'running') {
    return true
  }
  if (inputs.grid?.seeded) {
    return !inputs.grid.predictOk
  }
  return false
}
