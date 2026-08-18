import test from 'node:test'
import assert from 'node:assert/strict'
import { createTerminalStreamDecoder, decodeTerminalData } from './terminal-data.ts'

const toBase64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))

test('decodeTerminalData decodes a self-contained base64 payload', () => {
  const bytes = new TextEncoder().encode('héllo — ✓')
  assert.equal(decodeTerminalData(toBase64(bytes)), 'héllo — ✓')
})

test('decodeTerminalData returns empty string on invalid base64', () => {
  assert.equal(decodeTerminalData('not$base64!'), '')
})

test('stream decoder reassembles a UTF-8 code point split across chunks', () => {
  // '✓' is E2 9C 93 in UTF-8. Split it across two chunks the way a 16 KiB
  // service chunk boundary can.
  const bytes = new TextEncoder().encode('ok✓done')
  const splitAt = 4 // inside the 3-byte '✓' sequence
  const decoder = createTerminalStreamDecoder()

  const first = decoder.decode(toBase64(bytes.slice(0, splitAt)))
  const second = decoder.decode(toBase64(bytes.slice(splitAt)))

  assert.equal(first.text + second.text, 'ok✓done')
  assert.equal(first.byteLength, splitAt)
  assert.equal(second.byteLength, bytes.byteLength - splitAt)
})

test('stream decoder reports raw byte length even when text is withheld', () => {
  const bytes = new TextEncoder().encode('✓')
  const decoder = createTerminalStreamDecoder()

  const partial = decoder.decode(toBase64(bytes.slice(0, 2)))
  assert.equal(partial.text, '')
  assert.equal(partial.byteLength, 2)

  const rest = decoder.decode(toBase64(bytes.slice(2)))
  assert.equal(rest.text, '✓')
  assert.equal(rest.byteLength, 1)
})

test('stream decoder reset discards pending partial code point state', () => {
  const bytes = new TextEncoder().encode('✓')
  const decoder = createTerminalStreamDecoder()

  decoder.decode(toBase64(bytes.slice(0, 2)))
  decoder.reset()

  const fresh = decoder.decode(toBase64(new TextEncoder().encode('abc')))
  assert.equal(fresh.text, 'abc')
})

test('stream decoder handles invalid base64 without disturbing state', () => {
  const decoder = createTerminalStreamDecoder()
  const bad = decoder.decode('%%%')
  assert.equal(bad.text, '')
  assert.equal(bad.byteLength, 0)

  const ok = decoder.decode(toBase64(new TextEncoder().encode('next')))
  assert.equal(ok.text, 'next')
})
