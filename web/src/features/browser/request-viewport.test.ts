import test from 'node:test'
import assert from 'node:assert/strict'
import { workspaceViewport, requestViewport } from './request-viewport.ts'
test('request geometry uses the intended split pane or mobile fullscreen surface', () => {
  assert.deepEqual(workspaceViewport(1200,700,1440,null),{width:816,height:700})
  assert.deepEqual(workspaceViewport(1200,700,1440,'clamp(280px, 50.00%, 70%)'),{width:600,height:700})
  assert.deepEqual(workspaceViewport(390,740,390,null),{width:390,height:740})
  assert.equal(workspaceViewport(0,700,1440,null),null)
})
test('missing or keyboard-reduced geometry is omitted', () => {
  const previous=globalThis.window
  try {
    globalThis.window={innerHeight:800,visualViewport:{height:400}} as Window & typeof globalThis
    assert.equal(requestViewport({parentElement:{}} as HTMLElement,null),undefined)
    assert.equal(requestViewport(null,null),undefined)
  } finally {globalThis.window=previous}
})
