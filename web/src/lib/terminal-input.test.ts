import assert from 'node:assert/strict'
import test from 'node:test'
import { translateTerminalKeydown } from './terminal-input.ts'

const keydown = (key: string, mods: Partial<KeyboardEvent> = {}) =>
  ({
    type: 'keydown',
    key,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...mods,
  }) as KeyboardEvent

const opts = { hasSelection: false, platform: 'mac' as const }

test('tab translates to a consumed byte intent (never browser focus traversal)', () => {
  const intent = translateTerminalKeydown(keydown('Tab'), opts)
  assert.deepEqual(intent, { kind: 'bytes', text: '\t' })
})

test('shift+tab translates to backtab CSI Z', () => {
  const intent = translateTerminalKeydown(keydown('Tab', { shiftKey: true }), opts)
  assert.deepEqual(intent, { kind: 'bytes', text: '\x1b[Z' })
})

test('enter translates to CR for raw-mode TUIs', () => {
  const intent = translateTerminalKeydown(keydown('Enter'), opts)
  assert.deepEqual(intent, { kind: 'bytes', text: '\r' })
})

test('ctrl+tab stays unsupported (browser tab switching not hijacked)', () => {
  const intent = translateTerminalKeydown(keydown('Tab', { ctrlKey: true }), opts)
  assert.equal(intent.kind, 'unsupported')
})
