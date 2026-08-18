import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyGridFrame,
  emptyGridState,
  GRID_SCROLLBACK_CAP,
  gridColorToCss,
  gridRowText,
  seedGridScrollback,
  type TerminalGridFrame,
  type TerminalGridState,
} from './terminal-grid-state.ts'

function frame(overrides: Partial<TerminalGridFrame> = {}): TerminalGridFrame {
  return {
    generation: 1,
    full: true,
    cols: 80,
    rows: 3,
    alt_screen: false,
    cursor: { row: 0, col: 0, visible: true },
    dirty_rows: [],
    scrollback_push: [],
    scrollback_dropped: 0,
    ...overrides,
  }
}

function seeded(): TerminalGridState {
  const { state, discontinuity } = applyGridFrame(
    emptyGridState(),
    frame({
      dirty_rows: [
        { row: 0, runs: [{ t: 'prompt$ ' }] },
        { row: 1, runs: [] },
        { row: 2, runs: [] },
      ],
    }),
  )
  assert.equal(discontinuity, false)
  return state
}

test('full frame seeds the grid; contiguous deltas patch rows', () => {
  const state = seeded()
  assert.equal(state.seeded, true)
  assert.equal(state.grid.length, 3)
  assert.equal(gridRowText(state.grid[0]!), 'prompt$ ')

  const next = applyGridFrame(
    state,
    frame({
      generation: 2,
      full: false,
      cursor: { row: 0, col: 12, visible: true },
      dirty_rows: [{ row: 0, runs: [{ t: 'prompt$ ls' }] }],
    }),
  )
  assert.equal(next.discontinuity, false)
  assert.equal(gridRowText(next.state.grid[0]!), 'prompt$ ls')
  assert.equal(next.state.cursor.col, 12)
  // Untouched rows survive the delta.
  assert.equal(gridRowText(next.state.grid[1]!), '')
})

test('deltas with a generation gap or size change signal discontinuity', () => {
  const state = seeded()
  const gap = applyGridFrame(state, frame({ generation: 5, full: false }))
  assert.equal(gap.discontinuity, true)
  assert.equal(gap.state, state, 'state untouched on discontinuity')

  const resized = applyGridFrame(state, frame({ generation: 2, full: false, cols: 100 }))
  assert.equal(resized.discontinuity, true)

  const unseeded = applyGridFrame(emptyGridState(), frame({ generation: 7, full: false }))
  assert.equal(unseeded.discontinuity, true)
})

test('a full frame recovers from any generation (recording a scrollback seam)', () => {
  const state = seeded()
  const recovered = applyGridFrame(
    state,
    frame({
      generation: 9,
      full: true,
      rows: 3,
      dirty_rows: [
        { row: 0, runs: [{ t: 'fresh' }] },
        { row: 1, runs: [] },
        { row: 2, runs: [] },
      ],
    }),
  )
  assert.equal(recovered.discontinuity, false)
  assert.equal(recovered.state.generation, 9)
  assert.equal(gridRowText(recovered.state.grid[0]!), 'fresh')
  assert.equal(recovered.state.scrollbackDropped, 1, 'missed generations may have carried pushes')

  // Daemon restart resets generation to 1: also recovered by full.
  const restarted = applyGridFrame(recovered.state, frame({ generation: 1, full: true }))
  assert.equal(restarted.discontinuity, false)
  assert.equal(restarted.state.generation, 1)
})

test('row_shift splices the viewport before dirty rows apply', () => {
  const state = seeded()
  const base = applyGridFrame(state, frame({
    generation: 2,
    full: false,
    dirty_rows: [
      { row: 0, runs: [{ t: 'AAA' }] },
      { row: 1, runs: [{ t: 'BBB' }] },
      { row: 2, runs: [{ t: 'CCC' }] },
    ],
  })).state

  // Content moved up by one: old row 1 lands at row 0 BY REFERENCE (memo
  // identity preserved); the revealed bottom row arrives dirty.
  const shifted = applyGridFrame(base, frame({
    generation: 3,
    full: false,
    row_shift: 1,
    dirty_rows: [{ row: 2, runs: [{ t: 'DDD' }] }],
  }))
  assert.equal(shifted.discontinuity, false)
  assert.deepEqual(
    shifted.state.grid.map((runs) => gridRowText(runs)),
    ['BBB', 'CCC', 'DDD'],
  )
  assert.equal(shifted.state.grid[0], base.grid[1], 'shifted rows keep identity')

  // Negative shift = content moved down; holes covered by dirty rows.
  const down = applyGridFrame(shifted.state, frame({
    generation: 4,
    full: false,
    row_shift: -1,
    dirty_rows: [{ row: 0, runs: [{ t: 'TOP' }] }],
  }))
  assert.deepEqual(
    down.state.grid.map((runs) => gridRowText(runs)),
    ['TOP', 'BBB', 'CCC'],
  )

  // Shift frames obey delta contiguity (generation gaps still discontinuity).
  const gap = applyGridFrame(down.state, frame({ generation: 9, full: false, row_shift: 1 }))
  assert.equal(gap.discontinuity, true)
})

test('scrollback pushes accumulate oldest-first and cap with drop accounting', () => {
  let state = seeded()
  const pushed = applyGridFrame(
    state,
    frame({
      generation: 2,
      full: false,
      scrollback_push: [[{ t: 'old-1' }], [{ t: 'old-2' }]],
      scrollback_dropped: 0,
    }),
  )
  state = pushed.state
  assert.deepEqual(
    state.scrollback.map((runs) => gridRowText(runs)),
    ['old-1', 'old-2'],
  )

  const flooded = applyGridFrame(
    state,
    frame({
      generation: 3,
      full: false,
      scrollback_push: Array.from({ length: GRID_SCROLLBACK_CAP + 5 }, (_, i) => [
        { t: `line-${i}` },
      ]),
      scrollback_dropped: 7,
    }),
  )
  assert.equal(flooded.state.scrollback.length, GRID_SCROLLBACK_CAP)
  assert.equal(
    gridRowText(flooded.state.scrollback[flooded.state.scrollback.length - 1]!),
    `line-${GRID_SCROLLBACK_CAP + 4}`,
  )
  assert.equal(flooded.state.scrollbackDropped, 7)
})

test('snapshot history seeds scrollback as plain-text runs', () => {
  const state = seedGridScrollback(seeded(), 'alpha\n\nbeta')
  assert.deepEqual(
    state.scrollback.map((runs) => gridRowText(runs)),
    ['alpha', '', 'beta'],
  )
})

test('color resolution covers named, cube, grayscale, and truecolor', () => {
  assert.equal(gridColorToCss(undefined, '#abc'), '#abc')
  assert.equal(gridColorToCss(1, '#abc'), '#cd3131')
  assert.equal(gridColorToCss(16, '#abc'), 'rgb(0, 0, 0)')
  assert.equal(gridColorToCss(231, '#abc'), 'rgb(255, 255, 255)')
  assert.equal(gridColorToCss(232, '#abc'), 'rgb(8, 8, 8)')
  assert.equal(gridColorToCss(255, '#abc'), 'rgb(238, 238, 238)')
  assert.equal(gridColorToCss([1, 2, 3], '#abc'), 'rgb(1, 2, 3)')
})
