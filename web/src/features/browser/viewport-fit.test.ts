import test from 'node:test'
import assert from 'node:assert/strict'
import { paneViewport, ViewportFitter, type ViewportSize } from './viewport-fit.ts'
const wait = () => new Promise(resolve => setTimeout(resolve, 15))
test('hidden/invalid geometry is ignored and CSS viewport dimensions are bounded', () => {
  assert.equal(paneViewport(0, 700), null)
  assert.equal(paneViewport(NaN, 700), null)
  assert.deepEqual(paneViewport(405.7, 600.3), { width: 406, height: 600 })
  assert.deepEqual(paneViewport(100, 5000), { width: 240, height: 2560 })
})
test('resize burst coalesces; in-flight mutation keeps only latest desired size', async () => {
  const calls: ViewportSize[] = []
  let release = () => {}
  const fitter = new ViewportFitter(async size => {
    calls.push(size)
    if (calls.length === 1) await new Promise<void>(resolve => { release = resolve })
  }, () => assert.fail('unexpected failure'), 1)
  fitter.measure(500, 400); fitter.measure(600, 400)
  await wait()
  assert.deepEqual(calls, [{ width: 600, height: 400 }])
  fitter.measure(700, 400); fitter.measure(800, 400)
  await wait()
  assert.equal(calls.length, 1)
  release(); await wait()
  assert.deepEqual(calls[1], { width: 800, height: 400 })
  fitter.measure(800, 400); await wait()
  assert.equal(calls.length, 2)
  fitter.measure(900, 400); fitter.stop(); await wait()
  assert.equal(calls.length, 2)
})
test('uncertain resize is not retried and pending sizes are discarded', async () => {
  let calls = 0, failures = 0
  const fitter = new ViewportFitter(async () => { calls++; throw Error('unknown') }, () => { failures++ }, 1)
  fitter.measure(500, 400); await wait()
  fitter.measure(600, 400); await wait()
  assert.equal(calls, 1); assert.equal(failures, 1)
  fitter.stop()
})
