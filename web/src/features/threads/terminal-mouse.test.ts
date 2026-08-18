import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyAppCursorKeys,
  encodeTerminalMouseEvent,
  encodeWheelFallbackArrows,
  wheelDeltaToLines,
} from './terminal-mouse.ts'

const ESC = String.fromCharCode(27)

test('SGR press/release/wheel encoding with 1-based coordinates', () => {
  assert.equal(
    encodeTerminalMouseEvent({ kind: 'press', button: 'left', col: 9, row: 4, sgr: true }),
    `${ESC}[<0;10;5M`,
  )
  assert.equal(
    encodeTerminalMouseEvent({ kind: 'release', button: 'left', col: 9, row: 4, sgr: true }),
    `${ESC}[<0;10;5m`,
  )
  assert.equal(
    encodeTerminalMouseEvent({ kind: 'press', button: 'right', col: 0, row: 0, sgr: true }),
    `${ESC}[<2;1;1M`,
  )
  assert.equal(
    encodeTerminalMouseEvent({ kind: 'wheel-up', button: 'none', col: 5, row: 5, sgr: true }),
    `${ESC}[<64;6;6M`,
  )
  assert.equal(
    encodeTerminalMouseEvent({ kind: 'wheel-down', button: 'none', col: 5, row: 5, sgr: true }),
    `${ESC}[<65;6;6M`,
  )
})

test('SGR motion and modifier bits', () => {
  assert.equal(
    encodeTerminalMouseEvent({ kind: 'move', button: 'left', col: 2, row: 2, sgr: true }),
    `${ESC}[<32;3;3M`,
  )
  // Motion with no button held (1003 any-motion) uses button code 3.
  assert.equal(
    encodeTerminalMouseEvent({ kind: 'move', button: 'none', col: 2, row: 2, sgr: true }),
    `${ESC}[<35;3;3M`,
  )
  assert.equal(
    encodeTerminalMouseEvent({
      kind: 'press',
      button: 'left',
      col: 0,
      row: 0,
      shift: true,
      alt: true,
      ctrl: true,
      sgr: true,
    }),
    `${ESC}[<28;1;1M`,
  )
})

test('legacy X10 encoding clamps to the 7-bit-safe range', () => {
  assert.equal(
    encodeTerminalMouseEvent({ kind: 'press', button: 'left', col: 9, row: 4, sgr: false }),
    `${ESC}[M${String.fromCharCode(32)}${String.fromCharCode(42)}${String.fromCharCode(37)}`,
  )
  // Release is always button 3 in X10.
  const release = encodeTerminalMouseEvent({
    kind: 'release',
    button: 'left',
    col: 9,
    row: 4,
    sgr: false,
  })
  assert.equal(release, `${ESC}[M${String.fromCharCode(35)}${String.fromCharCode(42)}${String.fromCharCode(37)}`)
  const far = encodeTerminalMouseEvent({ kind: 'press', button: 'left', col: 300, row: 300, sgr: false })
  assert.equal(far, `${ESC}[M${String.fromCharCode(32)}${String.fromCharCode(126)}${String.fromCharCode(126)}`)
})

test('wheel fallback arrows repeat and cap', () => {
  assert.equal(encodeWheelFallbackArrows(0), '')
  assert.equal(encodeWheelFallbackArrows(2), `${ESC}[B${ESC}[B`)
  assert.equal(encodeWheelFallbackArrows(-1), `${ESC}[A`)
  assert.equal(encodeWheelFallbackArrows(50), `${ESC}[B`.repeat(8))
})

test('app-cursor mode switches arrows to SS3', () => {
  assert.equal(encodeWheelFallbackArrows(2, true), `${ESC}OB${ESC}OB`)
  assert.equal(encodeWheelFallbackArrows(-1, true), `${ESC}OA`)
  assert.equal(applyAppCursorKeys(`${ESC}[A`, true), `${ESC}OA`)
  assert.equal(applyAppCursorKeys(`${ESC}[D`, false), `${ESC}[D`)
  assert.equal(applyAppCursorKeys(`${ESC}[H${ESC}[F`, true), `${ESC}OH${ESC}OF`)
  // Non-cursor CSI sequences are untouched.
  assert.equal(applyAppCursorKeys(`${ESC}[3~`, true), `${ESC}[3~`)
})

test('pixel deltas convert to at least one line', () => {
  assert.equal(wheelDeltaToLines(0, 17), 0)
  assert.equal(wheelDeltaToLines(5, 17), 1)
  assert.equal(wheelDeltaToLines(-5, 17), -1)
  assert.equal(wheelDeltaToLines(51, 17), 3)
})
