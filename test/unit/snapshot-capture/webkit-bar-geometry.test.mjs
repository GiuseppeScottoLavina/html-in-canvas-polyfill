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

// WebKit's SYSTEM classic bar (an unstyled scroller under "Show scroll bars: Always"; webkitSystemKnob, painted by webkit-bars.js) against the knobs Safari 27.0.1 drew
// natively (macOS, DPR 2; device rows of the plain-DOM page at the lane's middle column, halved, relative to the lane, which starts 3 css px below the client top).
// Rows near the 1/256 px threshold of the offset's rounding (5555 and 8888 px of content) are on both sides of it. Positive control: the geometry the snapshot used
// before (a fractional knob of at least 18 px at its exact share) and the author-styled one (webkitThumb) disagree with the same measurements.
import { WEBKIT_SYSTEM_MIN, webkitSystemKnob } from '../../../src/snapshot/capture/webkit-bar-geometry.js';
import { webkitBarGeometry } from '../../../src/snapshot/capture/webkit-bars.js';

/** measured: [gutter, clientHeight, scrollHeight, knob length, {scrollTop: knob start in the lane}] */
const SYSTEM = /** @type {const} */ ([
  [17, 300, 2480, 35, { 0: 0, 1: 1, 2: 1, 3: 1, 5: 1, 7: 1, 10: 2, 13: 2, 50: 6, 99: 12, 100: 12, 101: 12, 333: 40, 600: 72, 1000: 119, 1500: 178, 2000: 238, 2179: 259, 2180: 259 }],
  [17, 120, 2480, 20, { 0: 0, 1: 1, 2: 1, 3: 1, 5: 1, 7: 1, 10: 1, 13: 1, 50: 2, 99: 4, 100: 4, 101: 5, 333: 14, 600: 24, 1000: 40, 1500: 60, 2000: 80, 2179: 87, 2180: 87 }],
  [17, 300, 372, 237, { 0: 0, 1: 1, 2: 2, 3: 3, 7: 6, 13: 11, 20: 16, 40: 32, 61: 49, 72: 57 }],
  [17, 300, 31000, 20, { 0: 0, 1: 1, 7: 1, 50: 1, 100: 1, 101: 1, 1000: 9, 5000: 45, 10000: 90, 15000: 134, 20000: 179, 29600: 265, 29700: 266, 30699: 274, 30700: 274 }],
  [17, 300, 1234, 71, { 0: 0, 1: 1, 2: 1, 3: 1, 4: 1, 5: 2, 6: 2, 8: 2, 10: 3, 12: 3, 15: 4, 20: 5, 25: 6, 50: 12, 75: 18, 133: 32, 311: 75, 467: 112, 570: 136, 813: 194, 932: 223, 933: 223, 934: 223 }],
  [17, 300, 2450, 36, { 0: 0, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 8: 1, 10: 2, 12: 2, 15: 2, 20: 3, 25: 3, 50: 6, 75: 9, 307: 37, 717: 87, 1075: 129, 1312: 158, 1871: 225, 2148: 258, 2149: 258, 2150: 258 }],
  [17, 300, 4321, 20, { 0: 0, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 8: 1, 10: 1, 12: 1, 15: 2, 20: 2, 25: 2, 50: 4, 75: 6, 574: 40, 1340: 92, 2011: 137, 2453: 167, 3498: 238, 4019: 274, 4020: 274, 4021: 274 }],
  [17, 300, 613, 143, { 0: 0, 1: 1, 2: 1, 3: 2, 4: 2, 5: 3, 6: 3, 8: 4, 10: 5, 12: 6, 15: 8, 20: 10, 25: 12, 45: 22, 50: 24, 75: 36, 104: 50, 157: 76, 191: 92, 272: 131, 311: 150, 312: 150, 313: 151 }],
  [17, 300, 5555, 20, { 96: 6, 422: 22, 959: 50, 1822: 95, 2244: 118, 2781: 145, 3107: 162, 3318: 173, 4066: 213, 4392: 229, 4488: 235, 4603: 241, 5140: 268 }],
  [17, 300, 8888, 20, { 627: 21, 815: 26, 1818: 58, 2006: 64, 2100: 67, 2821: 91, 2915: 93, 3730: 120, 3918: 125, 5015: 160, 5642: 181, 6018: 193, 7115: 228, 8212: 262 }],
  [13, 300, 2480, 35, { 0: 0, 1: 1, 10: 2, 50: 6, 333: 40, 600: 72, 1000: 119, 1500: 178, 2000: 238, 2180: 259 }],
  [13, 300, 31000, 16, { 0: 0, 1: 1, 1000: 10, 15000: 136, 30700: 278 }],
]);

test('WebKit system knob (measured Safari 27.0.1): floor(lane x visible / total) >= 20 px (16 thin), offset v x (lane - exact length) cut to 1/256 px and rounded up', () => {
  for (const [gutter, client, total, length, at] of SYSTEM) {
    for (const [top, start] of Object.entries(at)) {
      assert.deepEqual(webkitSystemKnob(client - 6, client, total, Number(top), WEBKIT_SYSTEM_MIN[gutter]), { start, length }, `gutter ${gutter}, client ${client}, total ${total}, scrollTop ${top}`);
      // the painter: an 11 (7) px lane 3 px into the gutter and from both ends, the knob in it
      const g = webkitBarGeometry(gutter, client, client, total, Number(top));
      assert.deepEqual([g.laneStart, g.laneLength, g.across, g.thickness, g.knobStart, g.knobLength], [3, client - 6, 3, gutter - 6, 3 + start, length]);
    }
  }
});

test('WebKit system knob: whole css px inside the lane, ending it at the end of the range; none when nothing scrolls or the minimum does not fit', () => {
  assert.equal(webkitSystemKnob(294, 300, 300, 0, 20), null, 'nothing to scroll');
  assert.equal(webkitSystemKnob(14, 20, 400, 0, 20), null, 'a 20 px minimum in a 14 px lane');
  assert.equal(webkitBarGeometry(17, 20, 20, 400, 0).knobLength, 0, 'the painter draws no knob then');
  for (let total = 301; total < 40000; total += 397) {
    const max = total - 300;
    for (let top = 0; top <= max; top += Math.max(1, Math.floor(max / 53))) {
      const k = /** @type {{start: number, length: number}} */ (webkitSystemKnob(294, 300, total, top, 20));
      assert.ok(Number.isInteger(k.start) && Number.isInteger(k.length) && k.start >= 0 && k.start + k.length <= 294, `total ${total} top ${top}: ${JSON.stringify(k)}`);
    }
    const end = /** @type {{start: number, length: number}} */ (webkitSystemKnob(294, 300, total, max, 20));
    assert.equal(end.start + end.length, 294, `total ${total}: at the end the knob ends the lane`);
    assert.deepEqual(webkitSystemKnob(294, 300, total, max + 50, 20), end, 'an offset past the range is the end');
  }
});

test('positive control: the snapshot\'s former system knob (fractional, >= 18 px) and the author-styled geometry disagree with the WebKit system measurements', () => {
  // the former painter: knobLength max(18, lane x visible / total), knobStart 3 + v x (lane - knobLength), both fractional
  const former = (/** @type {number} */ client, /** @type {number} */ total, /** @type {number} */ top) => {
    const lane = client - 6, length = Math.min(lane, Math.max(18, lane * (client / total)));
    return { start: (top / (total - client)) * (lane - length), length };
  };
  let off = 0, styled = 0, n = 0;
  for (const [gutter, client, total, length, at] of SYSTEM) {
    for (const [top, start] of Object.entries(at)) {
      n++;
      const f = former(client, total, Number(top));
      if (f.start !== start || f.length !== length) off++;
      const t = webkitThumb(client - 6, client, total, Number(top), WEBKIT_SYSTEM_MIN[gutter]);
      if (t?.start !== start || t?.length !== length) styled++;
    }
  }
  assert.ok(off > n * 0.9, `the former geometry matched ${n - off} of ${n} measured knobs`);
  // the 1/256 px cut: a plain round-up moves the knob a px early on the threshold rows
  let ceil = 0;
  for (const [gutter, client, total, , at] of SYSTEM) {
    const lane = client - 6, exact = Math.max(WEBKIT_SYSTEM_MIN[gutter], (lane * client) / total);
    for (const [top, start] of Object.entries(at)) if (Math.ceil((Number(top) / (total - client)) * (lane - exact)) !== start) ceil++;
  }
  assert.ok(ceil >= 10, `a plain round-up matched all but ${ceil} measured knobs`);
  assert.ok(styled > n * 0.3, `the author-styled geometry matched ${n - styled} of ${n} measured knobs`);
});
