// WebKit's author-styled classic bar (src/snapshot/capture/webkit-bar-geometry.js, scroll-emulation.js webkitStyledBar) against the thumbs Safari 27.0.1 drew natively
// (macOS, DPR 2, `::-webkit-scrollbar` 10-14 px wide, a 300 px track; device rows of the plain-DOM page at each scrollTop, halved). Positive control: the geometry the
// polyfill used for every engine before (verticalBar, Chromium's: a fractional offset, a 20 px minimum) disagrees with the same measurements.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webkitThumb } from '../../../src/snapshot/capture/webkit-bar-geometry.js';
import { verticalBar, webkitStyledBar, webkitStyledMinThumb } from '../../../src/snapshot/capture/scroll-emulation.js';

/** measured: [track, clientHeight, scrollHeight, minimum, thumb length, {scrollTop: thumb start}] */
const MEASURED = /** @type {const} */ ([
  [300, 300, 2480, 17, 36, { 0: 0, 1: 1, 2: 1, 3: 1, 5: 1, 7: 1, 10: 1, 13: 1, 50: 6, 99: 11, 100: 12, 101: 12, 333: 40, 600: 72, 1000: 121, 1500: 181, 2000: 242, 2179: 263, 2180: 264 }],
  [300, 300, 2480, 60, 60, { 0: 0, 1: 1, 50: 5, 99: 10, 100: 11, 333: 36, 600: 66, 1000: 110, 1500: 165, 2000: 220, 2179: 239, 2180: 240 }],
  [300, 300, 372, 17, 242, { 0: 0, 1: 1, 2: 1, 3: 2, 7: 5, 20: 16, 40: 32, 60: 48, 61: 49, 72: 58 }],
  [300, 300, 31000, 17, 17, { 0: 0, 1: 1, 7: 1, 100: 1, 5000: 46, 10000: 92, 20000: 184, 29700: 273, 30700: 283 }],
]);

test('WebKit styled thumb (measured Safari 27.0.1): length round(visible / total x track) >= the minimum, offset truncated to whole css px, (0, 1) shown as 1', () => {
  for (const [track, client, total, min, length, at] of MEASURED) {
    for (const [top, start] of Object.entries(at)) assert.deepEqual(webkitThumb(track, client, total, Number(top), min), { start, length }, `track ${track}, total ${total}, min ${min}, scrollTop ${top}`);
    const v = webkitStyledBar(11, track, client, total, min);
    assert.equal(v.thumbH, length);
    for (const [top, start] of Object.entries(at)) assert.equal(v.thumbY(Number(top)), start);
    assert.deepEqual([v.thumbX, v.thumbW], [0, 11], 'the thumb spans the gutter');
  }
});

test('WebKit styled thumb: no thumb when nothing scrolls or the minimum does not fit the track; every offset whole and inside the track', () => {
  assert.equal(webkitThumb(300, 300, 300, 0, 17), null, 'nothing to scroll');
  assert.equal(webkitThumb(40, 40, 400, 0, 60), null, 'a 60 px minimum in a 40 px track: no thumb (WebKit shows none)');
  assert.equal(webkitStyledBar(11, 40, 40, 400, 60).thumbH, 0);
  for (let total = 301; total < 5000; total += 97) {
    for (let top = 0; top <= total - 300; top += 7) {
      const t = /** @type {{start: number, length: number}} */ (webkitThumb(300, 300, total, top, 17));
      assert.ok(Number.isInteger(t.start) && Number.isInteger(t.length) && t.start >= 0 && t.start + t.length <= 300, `total ${total} top ${top}: ${JSON.stringify(t)}`);
    }
    assert.equal(/** @type {any} */ (webkitThumb(300, 300, total, total - 300, 17)).start + /** @type {any} */ (webkitThumb(300, 300, total, 0, 17)).length, 300, 'at the end the thumb ends the track');
  }
});

test('WebKit styled thumb minimum: height auto is the native 17 px, min-height raises it, max-height caps an explicit height; percentages and fractions are not resolved', () => {
  assert.equal(webkitStyledMinThumb({ height: 'auto', minHeight: '0px', maxHeight: 'none' }), 17);
  assert.equal(webkitStyledMinThumb({ height: 'auto', minHeight: 'auto', maxHeight: 'none' }), 17);
  assert.equal(webkitStyledMinThumb({ height: 'auto', minHeight: '60px', maxHeight: 'none' }), 60);
  assert.equal(webkitStyledMinThumb({ height: '40px', minHeight: '0px', maxHeight: '30px' }), 30);
  assert.equal(webkitStyledMinThumb({ height: '10px', minHeight: '0px', maxHeight: 'none' }), 10);
  assert.equal(webkitStyledMinThumb({ height: '10%', minHeight: '0px', maxHeight: 'none' }), null);
  assert.equal(webkitStyledMinThumb({ height: '17.5px', minHeight: '0px', maxHeight: 'none' }), null);
});

test('positive control: the generic (Chromium) geometry disagrees with the WebKit measurements', () => {
  let off = 0;
  for (const [track, client, total, min, length, at] of MEASURED) {
    const v = verticalBar(11, client, total, true, false, min === 17 ? 0 : min);
    if (v.thumbH !== length) off++;
    for (const [top, start] of Object.entries(at)) if (v.thumbY(Number(top)) !== start) off++;
    void track;
  }
  assert.ok(off > 10, `the Chromium geometry matched the WebKit thumbs (${off} differences)`);
});
