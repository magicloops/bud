import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeMarker } from './provenance.mjs';

test('pixel oracle tolerates compression noise and scaled bitmap geometry', () => {
  // A painted row for document 37, CSS 440×816; half-resolution bitmap.
  const bits = '10100101' + '00100101' + '000110111000' + '001100110000';
  const row = new Uint8Array(220 * 4);
  for (let x = 0; x < 220; x++) row[x * 4] = bits[Math.floor(x * 40 / 220)] === '1' ? 240 : 15;
  assert.deepEqual(decodeMarker(row, 220, 408), {
    magic: 165, document: 37, width: 440, height: 816, bitmap_width: 220, bitmap_height: 408,
  });
  row[Math.floor(.5 * 220 / 40) * 4] = 128;
  assert.throws(() => decodeMarker(row, 220, 408), /ambiguous/);
});

test('missing marker and incomplete pixel data fail closed', () => {
  assert.throws(() => decodeMarker(new Uint8Array(440 * 4), 440, 816), /invalid/);
  assert.throws(() => decodeMarker([], 440, 816), /ambiguous/);
});
