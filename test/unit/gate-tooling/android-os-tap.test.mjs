// The mobile gate's OS-gesture geometry on Android (test/mobile/android.mjs): the display size `adb shell input` uses, the calibration taps under a display-size
// override, the css -> input mapping solved from them, and the refusal of a point outside the visual viewport.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWmSize, calibrationPoints, solveMapping, toInput, insideViewport } from '../../mobile/android.mjs';

// measured on a Huawei Mate 10 Pro (Android 10, Chrome 156) with Settings > Display size set: a 1080x2160 panel at 720x1440, 320 dpi; the page sees DPR 2, a 360 css px
// wide screen and a 600 css px viewport whose top is at input row 160 (status bar and toolbar above it, navigation bar below 1360)
const MATE = 'Physical size: 1080x2160\nOverride size: 720x1440\n';
const matePage = { sw: 360, sh: 720, ih: 600, vh: 600, vt: 0 };
/** the device: a touch at input (sx, sy) reports clientX/Y = (s - origin) / k */
const device = (origin, k) => (p) => ({ sx: p.x, sy: p.y, cx: (p.x - origin.x) / k, cy: (p.y - origin.y) / k });

test('wm size: the override when one is set, else the physical size', () => {
  assert.deepEqual(parseWmSize(MATE), { w: 720, h: 1440, override: true });
  assert.deepEqual(parseWmSize('Physical size: 1440x3120\n'), { w: 1440, h: 3120, override: false });
  assert.equal(parseWmSize('error: no devices'), null);
});

test('Mate 10 Pro: both calibration taps land inside the viewport, and the mapping puts a css point where the device reports it', () => {
  const display = parseWmSize(MATE);
  const pts = calibrationPoints(display, matePage);
  const top = 160, bottom = 160 + 600 * 2;
  for (const p of pts) assert.ok(p.y > top && p.y < bottom && p.x === 3, JSON.stringify(p));
  const tap = device({ x: 0, y: top }, 2);
  const m = solveMapping(tap(pts[0]), tap(pts[1]));
  assert.deepEqual({ ...m, k: +m.k.toFixed(6) }, { left: 0, top: 160, k: 2 });
  assert.deepEqual(toInput(m, 180, 300), { x: 360, y: 760 });
});

test('the band holds wherever the toolbar and the system bars put the viewport (its top anywhere from 0 to the display height minus its height)', () => {
  const display = parseWmSize(MATE);
  const pts = calibrationPoints(display, matePage);
  for (const top of [0, 48, 160, 240]) for (const p of pts) assert.ok(p.y >= top && p.y <= top + 1200, `top ${top}: ${JSON.stringify(p)}`);
});

test('an input space that is not css px x devicePixelRatio (a device whose input uses the physical 1080x2160 panel under the override): the scale is measured, not assumed', () => {
  const tap = device({ x: 0, y: 240 }, 3);
  // the calibration points are a guess from the reported size; the device answers in its own space
  const m = solveMapping(tap({ x: 3, y: 600 }), tap({ x: 3, y: 1500 }));
  assert.equal(+m.k.toFixed(6), 3);
  assert.deepEqual(toInput(m, 180, 300), { x: 540, y: 1140 });
  // positive control: the old assumption (scale = devicePixelRatio 2) misplaces the same point by 1/3
  const a = tap({ x: 3, y: 600 });
  const old = { left: a.sx - a.cx * 2, top: a.sy - a.cy * 2, k: 2 };
  assert.notDeepEqual(toInput(old, 180, 300), toInput(m, 180, 300));
});

test('landscape: the display is taken in the page\'s orientation', () => {
  const pts = calibrationPoints(parseWmSize(MATE), { sw: 720, sh: 360, ih: 280, vh: 280, vt: 0 });
  // 720 tall in landscape, 560 input px of viewport: the band is [160, 560]
  for (const p of pts) assert.ok(p.y >= 160 && p.y <= 560, JSON.stringify(p));
});

test('no band when the viewport covers less than half the display: refused, never a tap on the system UI', () => {
  assert.throws(() => calibrationPoints(parseWmSize(MATE), { sw: 360, sh: 720, ih: 300, vh: 300, vt: 0 }), /no calibration band/);
});

test('taps that disagree (no touch movement between them) are refused', () => {
  assert.throws(() => solveMapping({ sx: 3, sy: 400, cx: 1, cy: 120 }, { sx: 3, sy: 1000, cx: 1, cy: 120 }), /disagree/);
});

test('a css point outside the visual viewport is refused (the keyboard scenario once tapped 20 css px below a 600 css px viewport: the navigation bar)', () => {
  const vv = { x: 0, y: 0, w: 360, h: 600 };
  assert.equal(insideViewport(vv, 180, 300), true);
  assert.equal(insideViewport(vv, 180, 619.8), false);
  assert.equal(insideViewport(vv, -2, 300), false);
  assert.equal(insideViewport({ ...vv, h: 330 }, 180, 400), false); // the keyboard shrank the visual viewport
});
