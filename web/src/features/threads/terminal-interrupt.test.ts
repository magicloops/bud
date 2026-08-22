import assert from 'node:assert/strict'
import { test } from 'node:test'

import { showTerminalInterrupt } from './terminal-interrupt.ts'

const gridAtPrompt = { seeded: true, altScreen: false, predictOk: true }
const gridBusy = { seeded: true, altScreen: false, predictOk: false }
const gridTui = { seeded: true, altScreen: true, predictOk: false }
const gridUnseeded = { seeded: false, altScreen: false, predictOk: false }

const running = { status: 'running', commandId: 'cmd_1' } as const
const finished = { status: 'finished', commandId: 'cmd_1', exitCode: 0 } as const

test('hidden while not connected, even with a running command', () => {
  assert.equal(
    showTerminalInterrupt({ connection: 'reconnecting', chip: running, mode: 'shell', grid: gridBusy }),
    false,
  )
  assert.equal(
    showTerminalInterrupt({ connection: 'disconnected', chip: running, mode: 'shell', grid: null }),
    false,
  )
})

test('an open command shows it (both renderers)', () => {
  assert.equal(
    showTerminalInterrupt({ connection: 'connected', chip: running, mode: 'shell', grid: null }),
    true,
  )
  assert.equal(
    showTerminalInterrupt({ connection: 'connected', chip: running, mode: 'shell', grid: gridAtPrompt }),
    true,
  )
})

test('alt screen wins over an open command: a TUI launched as a command hides it', () => {
  // `less foo` keeps the command open for its whole run; the alt-screen
  // fact must still suppress the affordance (Ctrl+C is a keystroke there).
  assert.equal(
    showTerminalInterrupt({ connection: 'connected', chip: running, mode: 'tui', grid: gridTui }),
    false,
  )
  // Bytes renderer: no grid facts — the `tui` mode fact suppresses instead.
  assert.equal(
    showTerminalInterrupt({ connection: 'connected', chip: running, mode: 'tui', grid: null }),
    false,
  )
  // Grid facts outrank a stale mode fact when frames are seeded.
  assert.equal(
    showTerminalInterrupt({ connection: 'connected', chip: running, mode: 'tui', grid: gridBusy }),
    true,
  )
})

test('grid busy states show it: closed predict gate on the primary screen', () => {
  // Busy REPL, unknown mode (gate never opens), password prompt — all
  // arrive as predict_ok:false on the primary screen.
  assert.equal(
    showTerminalInterrupt({ connection: 'connected', chip: null, mode: 'repl', grid: gridBusy }),
    true,
  )
  assert.equal(
    showTerminalInterrupt({ connection: 'connected', chip: finished, mode: 'shell', grid: gridBusy }),
    true,
  )
})

test('hidden at an interactive prompt', () => {
  assert.equal(
    showTerminalInterrupt({ connection: 'connected', chip: finished, mode: 'shell', grid: gridAtPrompt }),
    false,
  )
  assert.equal(
    showTerminalInterrupt({ connection: 'connected', chip: null, mode: 'shell', grid: gridAtPrompt }),
    false,
  )
})

test('hidden in the alt screen without a command (htop opened by hand)', () => {
  assert.equal(
    showTerminalInterrupt({ connection: 'connected', chip: null, mode: 'tui', grid: gridTui }),
    false,
  )
})

test('unseeded grid and bytes renderer fall back to the command chip only', () => {
  assert.equal(
    showTerminalInterrupt({ connection: 'connected', chip: null, mode: 'shell', grid: gridUnseeded }),
    false,
  )
  assert.equal(
    showTerminalInterrupt({ connection: 'connected', chip: null, mode: null, grid: null }),
    false,
  )
  assert.equal(
    showTerminalInterrupt({ connection: 'connected', chip: finished, mode: 'shell', grid: null }),
    false,
  )
})
