import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrivateCapture } from './private-capture.mjs';

// Synthetic authority only. No live Bud workspace or user profile is admitted.
export async function lifecycle({ pages, command, connect, evaluate, origin, results = [] }) {
  const geometry = { width: 440, height: 816, deviceScaleFactor: 1, mobile: false };
  const until = async predicate => {
    for (let i = 0; i < 100; i++) { if (await predicate()) return; await sleep(25); }
    throw new Error('lifecycle_condition_timeout');
  };
  for (const [index, page] of pages.entries()) {
    let admitted = true, frames = 0;
    const source = await connect();
    await command.call('Emulation.setDeviceMetricsOverride', geometry, page.session);
    const capture = new PrivateCapture(source, page.targetId, () => admitted, () => frames++);
    try {
      await capture.start();
      await until(() => frames > 2);
      const windowBefore = (await command.call('Browser.getWindowForTarget', { targetId: page.targetId })).bounds;
      assert.equal(windowBefore.windowState, 'minimized');
      const other = pages[1 - index];
      const otherBefore = await evaluate(other.session, 'fixture.snapshot()');
      // Find the fixture input, but deliver the click and text through CDP Input.
      const point = await evaluate(page.session, `(() => { const r = document.querySelector('input').getBoundingClientRect(); return { x: r.x + 12, y: r.y + r.height / 2 }; })()`);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await command.call('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 }, page.session);
      }
      await command.call('Input.insertText', { text: 'private fixture' }, page.session);
      assert.equal(await evaluate(page.session, "document.querySelector('input').value"), 'private fixture');
      for (const type of ['keyDown', 'keyUp']) {
        await command.call('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: type === 'keyDown' ? '\r' : '' }, page.session);
      }
      await until(async () => (await evaluate(page.session, 'fixture.snapshot()')).submissions === 1);
      const inputEffects = await evaluate(page.session, 'fixture.snapshot()');
      assert.equal(inputEffects.keys, 1);
      assert.ok(inputEffects.clicks >= 1);
      assert.equal(await evaluate(other.session, "document.querySelector('input').value"), '');
      const otherAfter = await evaluate(other.session, 'fixture.snapshot()');
      assert.equal(otherAfter.ticks, otherBefore.ticks, 'other target animated');
      // Model a simultaneous automation attachment without changing its viewport.
      const sibling = await connect();
      try {
        const siblingSession = await sibling.attach(page.targetId);
        await sibling.call('Runtime.evaluate', { expression: 'document.title' }, siblingSession);
      } finally { sibling.close(); }
      await sleep(100);
      const afterSiblingDetach = await evaluate(page.session, 'fixture.snapshot()');
      assert.equal(afterSiblingDetach.width, 440);
      assert.equal(afterSiblingDetach.height, 816);
      assert.equal(afterSiblingDetach.visibility, 'visible');
      const beforeNavigation = frames;
      await command.call('Page.navigate', { url: `${origin}/?document=next-${index}#fragment` }, page.session);
      await until(async () => await evaluate(page.session, `window.fixture?.snapshot().label === 'next-${index}'`));
      await until(() => frames > beforeNavigation + 2);
      await command.call('Emulation.setDeviceMetricsOverride', { ...geometry, width: 400, height: 700 }, page.session);
      const resized = await evaluate(page.session, 'fixture.snapshot()');
      assert.equal(resized.width, 400);
      assert.equal(resized.height, 700);
      admitted = false;
      const deliveredAtRevocation = frames;
      await capture.stop('return');
      await sleep(200);
      assert.equal(frames, deliveredAtRevocation, 'frame delivered after revocation');
      const detached = await evaluate(page.session, 'fixture.snapshot()');
      const windowAfter = (await command.call('Browser.getWindowForTarget', { targetId: page.targetId })).bounds;
      assert.equal(windowAfter.windowState, 'minimized');
      assert.equal(detached.visibility, 'hidden');
      await command.call('Emulation.setDeviceMetricsOverride', geometry, page.session);
      const reapplied = await evaluate(page.session, 'fixture.snapshot()');
      assert.equal(reapplied.width, 440);
      assert.equal(reapplied.height, 816);
      results.push({ target: index, frames, native_click_text: true, input_effects: inputEffects, sibling_detach: afterSiblingDetach, other_target_suspended: true,
        navigation_frames: true, window_before: windowBefore, window_after: windowAfter, resized, detached, reapplied, cleanup_failure: capture.failure,
        pixel_provenance: 'not_proven_by_dom_or_event_metadata' });
    } finally { await capture.stop(); }
  }
  // Kill just the source connection; Chrome and the command owner remain alive.
  const page = pages[0];
  const source = await connect();
  const capture = new PrivateCapture(source, page.targetId, () => true, () => {});
  try {
    await capture.start();
    source.close('simulated_source_loss');
    await capture.stop();
    await sleep(200);
    const detached = await evaluate(page.session, 'fixture.snapshot()');
    assert.equal(detached.visibility, 'hidden');
    results.push({ case: 'source_loss', detached, cleanup_failure: capture.failure });
  } finally { await capture.stop(); }
  return results;
}
