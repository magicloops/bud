import test from 'node:test'
import assert from 'node:assert/strict'
import { browserReveal, browserPathSession, BrowserRevealTracker } from './pane-state.ts'
const id = 'browser_01AAAAAAAAAAAAAAAAAAAAAAAA'
test('only canonical browser results and first-party handoffs can reveal a pane', () => {
  assert.equal(browserReveal({ tool: 'browser_open', session_id: id, ok: false }), null)
  assert.equal(browserPathSession(`https://evil.test/browser/${id}`), null)
  assert.equal(browserPathSession(`/browser/${id}?ticket=secret`), null)
  assert.equal(browserReveal({ tool: 'browser_exec', session_id: id, ok: true }), null)
  assert.equal(browserReveal({ viewer_path: `/browser/${id}`, handoff_id: 'handoff' })?.id, id)
})
test('history baseline and duplicate events do not reopen a dismissed pane; new handoff does', () => {
  const tracker = new BrowserRevealTracker()
  tracker.seed(`open:${id}`)
  assert.equal(tracker.accept(`open:${id}`), false)
  assert.equal(tracker.accept('handoff:one'), true)
  assert.equal(tracker.accept('handoff:one'), false)
  assert.equal(tracker.accept('handoff:two'), true)
})
