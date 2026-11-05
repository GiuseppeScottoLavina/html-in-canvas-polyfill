// Scroll compositor (snapshot/store/scroll-compose.js vetPixels): the pixel test of ScrollPlan.cover. Every port pixel must be the cover colour (nothing but the
// scroller's background paints there), or one and the same colour (what shows through a translucent scroller); the corner squares of a rounded port are left out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vetPixels } from '../../../src/snapshot/store/scroll-compose.js';

/** @param {number} w @param {number} h @param {number[]} rgba */
const fill = (w, h, rgba) => { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < d.length; i += 4) d.set(rgba, i); return d; };
/** @param {Uint8ClampedArray} d @param {number} w @param {number} x @param {number} y @param {number[]} rgba */
const put = (d, w, x, y, rgba) => { d.set(rgba, (y * w + x) * 4); return d; };
const COVER = [1, 254, 3];

test('every pixel the cover colour passes; one pixel off by one level anywhere, or not opaque, fails', () => {
  assert.equal(vetPixels(fill(7, 5, [...COVER, 255]), 7, 5, COVER, []), true);
  for (const [x, y] of [[0, 0], [6, 4], [3, 2]]) assert.equal(vetPixels(put(fill(7, 5, [...COVER, 255]), 7, x, y, [1, 254, 4, 255]), 7, 5, COVER, []), false, `pixel ${x},${y}`);
  assert.equal(vetPixels(put(fill(7, 5, [...COVER, 255]), 7, 2, 2, [...COVER, 254]), 7, 5, COVER, []), false, 'alpha');
  assert.equal(vetPixels(fill(7, 5, [255, 255, 255, 255]), 7, 5, COVER, []), false, 'one colour, not the cover colour (an opaque box over the whole port)');
});

test('a colour with its alpha: transparent all over passes, one opaque pixel fails', () => {
  assert.equal(vetPixels(fill(7, 5, [0, 0, 0, 0]), 7, 5, [0, 0, 0, 0], []), true);
  assert.equal(vetPixels(put(fill(7, 5, [0, 0, 0, 0]), 7, 4, 4, [0, 0, 0, 255]), 7, 5, [0, 0, 0, 0], []), false);
});

test('with no colour asked, every pixel the same passes, two colours fail', () => {
  assert.equal(vetPixels(fill(7, 5, [250, 250, 250, 255]), 7, 5, null, []), true);
  assert.equal(vetPixels(fill(7, 5, [0, 0, 0, 0]), 7, 5, null, []), true, 'transparent all over');
  assert.equal(vetPixels(put(fill(7, 5, [250, 250, 250, 255]), 7, 6, 4, [251, 250, 250, 255]), 7, 5, null, []), false);
});

test('the skipped rects (corner squares) are not read, also for the reference colour; a pixel just outside them is', () => {
  const skip = [{ x: 0, y: 0, width: 2, height: 2 }, { x: 5, y: 3, width: 2, height: 2 }];
  const d = put(put(fill(7, 5, [9, 9, 9, 255]), 7, 0, 0, [200, 0, 0, 255]), 7, 6, 4, [0, 200, 0, 255]);
  assert.equal(vetPixels(d, 7, 5, null, skip), true, 'the first pixel lies in a corner: the reference is the first one outside');
  assert.equal(vetPixels(put(d, 7, 2, 0, [200, 0, 0, 255]), 7, 5, null, skip), false, 'next to the corner square');
  assert.equal(vetPixels(put(fill(7, 5, [...COVER, 255]), 7, 1, 1, [0, 0, 0, 255]), 7, 5, COVER, skip), true, 'cover colour, a corner pixel off');
});

test('a view into a larger buffer (getImageData of a part) is read from its own offset', () => {
  const big = fill(7, 6, [5, 5, 5, 255]);
  const part = new Uint8ClampedArray(big.buffer, 7 * 4, 7 * 5 * 4);
  put(big, 7, 3, 0, [99, 0, 0, 255]);
  assert.equal(vetPixels(part, 7, 5, null, []), true, 'the row before the view is not read');
});
