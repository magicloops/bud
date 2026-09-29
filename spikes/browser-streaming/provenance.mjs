import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrivateCapture } from './private-capture.mjs';

export function decodeMarker(row, width, height) {
  let bits = '';
  for (let i = 0; i < 40; i++) {
    const value = row[Math.floor((i + .5) * width / 40) * 4];
    if (!Number.isFinite(value) || (value > 70 && value < 185)) throw new Error('ambiguous_marker');
    bits += value >= 185 ? '1' : '0';
  }
  if (parseInt(bits.slice(0, 8), 2) !== 0xa5) throw new Error('invalid_pixel_marker');
  return { magic: 0xa5, document: parseInt(bits.slice(8, 16), 2),
    width: parseInt(bits.slice(16, 28), 2), height: parseInt(bits.slice(28), 2),
    bitmap_width: width, bitmap_height: height };
}

// Decode actual JPEG pixels in a separate synthetic target; no external codec
// dependency and no inspection of the source page's current DOM for identity.
async function decode(command, decoder, frame) {
  const result = await command.call('Runtime.evaluate', {
    awaitPromise: true, returnByValue: true,
    expression: `(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(frame.data)}), c => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: 'image/jpeg' });
      const image = await createImageBitmap(blob);
      try {
        const canvas = new OffscreenCanvas(image.width, image.height);
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
        const row = ctx.getImageData(0, 8, image.width, 1).data;
        return (${decodeMarker.toString()})(row, image.width, image.height);
      } finally { image.close(); }
    })()`
  }, decoder);
  if (result.exceptionDetails) throw new Error('pixel_decode_failed');
  assert.equal(result.result.value.magic, 0xa5, 'invalid_pixel_marker');
  return result.result.value;
}

export async function provenance({ pages, command, connect, evaluate, origin, idleId, results }) {
  const decoder = await command.attach(idleId);
  const page = pages[0];
  const geometry = (width, height) => ({ width, height, deviceScaleFactor: 1, mobile: false });
  let capture, pending = [], phase, overflow = 0;
  const start = async () => {
    pending = []; overflow = 0;
    capture = new PrivateCapture(await connect(), page.targetId, () => true, frame => {
      if (pending.length < 32 && frame.data.length <= 1_400_000) {
        pending.push({ ...frame, phase, received_ms: performance.now() });
      } else overflow++;
    });
    await capture.start();
  };
  const navigate = async (id, staticPage = false) => {
    const host = id % 2 ? origin : origin.replace('127.0.0.1', 'localhost');
    await command.call('Page.navigate', { url: `${host}/?document=oracle-${id}&marker=${id}${staticPage ? '&static=1' : ''}` }, page.session);
    for (let i = 0; i < 100; i++) {
      if (await evaluate(page.session, `Boolean(window.fixture) && location.search.includes('marker=${id}') && document.readyState === 'complete'`)) return;
      await sleep(10);
    }
    throw new Error('oracle_navigation_timeout');
  };
  const collect = async (kind, expected) => {
    await sleep(150);
    await capture.stop();
    const frames = [];
    for (const frame of pending) {
      const pixels = await decode(command, decoder, frame);
      frames.push({ phase: frame.phase, pixels, metadata: frame.metadata,
        matches_expected: pixels.document === expected.document && pixels.width === expected.width && pixels.height === expected.height });
    }
    assert.ok(frames.length, 'no_oracle_frames');
    assert.equal(overflow, 0, 'oracle_sample_overflow');
    results.push({ kind, expected, frames });
    if (kind !== 'continuous') assert.ok(frames.every(f => f.matches_expected), 'fresh_source_contains_stale_pixels');
  };
  try {
    let id = 1;
    for (let iteration = 0; iteration < 8; iteration++) {
      await command.call('Emulation.setDeviceMetricsOverride', geometry(440, 816), page.session);
      await navigate(id++);
      phase = 'old_document';
      await start();
      await sleep(100);
      phase = 'transition_in_flight';
      const document = id++;
      await navigate(document);
      await command.call('Emulation.setDeviceMetricsOverride', geometry(400, 700), page.session);
      phase = 'commands_completed';
      await collect('continuous', { document, width: 400, height: 700 });

      // New generation after a known transition, with no source-owned metrics.
      await command.call('Emulation.setDeviceMetricsOverride', geometry(440, 816), page.session);
      const freshDocument = id++;
      await navigate(freshDocument, true);
      // Static pages must also emit a valid first frame without a forced paint.
      phase = 'fresh_generation';
      await start();
      await collect('restarted_static', { document: freshDocument, width: 440, height: 816 });
      await command.call('Emulation.setDeviceMetricsOverride', geometry(380, 740), page.session);
      phase = 'fresh_after_resize';
      await start();
      await collect('restarted_resize_only', { document: freshDocument, width: 380, height: 740 });
    }
  } finally { await capture?.stop(); }
}
