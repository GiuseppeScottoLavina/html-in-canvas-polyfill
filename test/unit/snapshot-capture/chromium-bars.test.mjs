// Chromium's classic scrollbars (src/snapshot/capture/chromium-bars.js) against the native pixels G-platform measured (Chrome 155, F7 at DPR 1: Linux in the CI image,
// macOS with classic bars forced), and the clone's size pin of controls whose intrinsic size includes the bar (scroll-emulation.js barBoxPin). Each group has a
// positive control: the look the polyfill painted before (the macOS legacy constants for every platform) disagrees with the same measurements.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrowSvg, barColors, barParts, barThemeOf, cornerSvg, trackSvg } from '../../../src/snapshot/capture/chromium-bars.js';
import { barBoxPin, verticalBar } from '../../../src/snapshot/capture/scroll-emulation.js';

/** @param {Partial<import('../../../src/snapshot/capture/chromium-bars.js').BarLook>} o */
const look = (o) => ({ theme: 'fluent', k: 1, dpr: 1, thin: false, dark: false, authored: null, glyphs: false, ...o });
// F7 `v-light`: a 120 px scrollport over 554 px of content (30 lines of 18.2 px and 8 px of padding), scrolled to 400 (the probe's scrolled state)
const V = { thick: 15, len: 120, visible: 120, total: 554, offset: 0 };

test('the theme is measured from the auto and thin bar thicknesses (device px), at every common scale', () => {
  // Fluent: round(15 k) and round(10 k); macOS: trunc(15 k) and trunc(11 k)
  for (const [dpr, fluent, mac] of [[1, [15, 10], [15, 11]], [1.25, [19, 13], [18, 13]], [1.5, [23, 15], [22, 16]], [2, [30, 20], [30, 22]]]) {
    assert.deepEqual(barThemeOf(fluent[0], fluent[1], dpr, true), { theme: 'fluent', k: dpr }, `Fluent at ${dpr}, even on a macOS user agent`);
    assert.deepEqual(barThemeOf(mac[0], mac[1], dpr, false), { theme: 'mac', k: dpr }, `macOS at ${dpr}, even on another user agent`);
  }
  // page zoom: devicePixelRatio 1.25 on a 1x screen keeps the bars at 15 / 10 (Fluent) or 15 / 11 (macOS) device px: their scale is the device's
  assert.deepEqual(barThemeOf(15, 10, 1.25, true), { theme: 'fluent', k: 1 });
  assert.deepEqual(barThemeOf(15, 11, 1.25, false), { theme: 'mac', k: 1 });
  // a measurement no theme explains: the platform decides
  assert.equal(barThemeOf(16, 14, 1, true).theme, 'mac');
  assert.equal(barThemeOf(16, 14, 1, false).theme, 'fluent');
});

test('Fluent geometry (Linux, measured): 18 px buttons, a 9 px thumb 3 px from each side, its length and truncated offset in the track between the buttons', () => {
  assert.deepEqual(barParts(look({}), V), { buttons: 18, thumb: { at: 18, len: 18, across: 3, thick: 9 } });
  assert.equal(barParts(look({}), { ...V, offset: 400 }).thumb?.at, 78, 'scrolled to 400: rows 78-95');
  // scrollbar-width: thin (10 px): 12 px buttons, a 6 px thumb 2 px from each side, rows 12-32
  assert.deepEqual(barParts(look({ thin: true }), { ...V, thick: 10 }), { buttons: 12, thumb: { at: 12, len: 21, across: 2, thick: 6 } });
  // nothing to scroll (overflow: scroll): buttons, no thumb
  assert.deepEqual(barParts(look({}), { ...V, total: 120 }), { buttons: 18, thumb: null });
  // positive control: the macOS legacy constants painted before put the thumb at the top of the bar, 30 px long, 4 px in
  const old = verticalBar(15, 120, 554, false, false);
  assert.notEqual(old.thumbY(0), 18); assert.notEqual(old.thumbH, 18); assert.notEqual(old.thumbX, 3);
});

test('macOS geometry (measured): no buttons, the thumb inset 3 px (and the 1 px track border on the content side), at least 20 px', () => {
  const mac = look({ theme: 'mac' });
  assert.deepEqual(barParts(mac, V), { buttons: 0, thumb: { at: 3, len: 20, across: 4, thick: 8 } }, 'rows 3-22, columns 4-11');
  assert.equal(barParts(mac, { ...V, offset: 400 }).thumb?.at, 89, 'scrolled to 400: rows 89-108');
  // thin (11 px): the insets shrink so the thumb keeps its 6 px minimum girth
  assert.deepEqual(barParts(look({ theme: 'mac', thin: true }), { ...V, thick: 11 }).thumb, { at: 3, len: 20, across: 3, thick: 6 });
  // positive control: the earlier painter's thumb started at the top of the track and was 30 px long
  const old = verticalBar(15, 120, 554, false, false);
  assert.notEqual(old.thumbY(0), 3); assert.notEqual(old.thumbH, 20);
});

/** the device pixels a crisp (non-antialiased) path fills: those whose centre is inside it. @param {string} svg @param {number} w @param {number} h */
function rasterize(svg, w, h) {
  const pts = /** @type {RegExpMatchArray} */ (svg.match(/d="M([^"]+)Z"/))[1].split('L').map((p) => p.split(' ').map(Number));
  const inside = (/** @type {number} */ x, /** @type {number} */ y) => {
    let sign = 0;
    for (let i = 0; i < 3; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % 3];
      const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
      if (c !== 0) { if (sign && Math.sign(c) !== sign) return false; sign = Math.sign(c); }
    }
    return true;
  };
  const rows = [];
  for (let y = 0; y < h; y++) {
    const cols = [];
    for (let x = 0; x < w; x++) if (inside(x + 0.5, y + 0.5)) cols.push(x);
    if (cols.length) rows.push([y, cols[0], cols.at(-1)]);
  }
  return rows;
}

test('Fluent arrows (Linux, measured): crisp triangles of 9 px bases, one px towards the start of their 18 x 15 buttons', () => {
  const grey = '#8b8b8b';
  // up, button rows 0-17: rows 6-10, one more pixel each side per row, centred on column 7
  assert.deepEqual(rasterize(arrowSvg({ x: 0, y: 0, w: 15, h: 18 }, 'up', grey, false), 15, 18), [[6, 7, 7], [7, 6, 8], [8, 5, 9], [9, 4, 10], [10, 3, 11]]);
  // down, button rows 102-119 of a 120 px bar: rows 108-112
  assert.deepEqual(rasterize(arrowSvg({ x: 0, y: 102, w: 15, h: 18 }, 'down', grey, false), 15, 120), [[108, 3, 11], [109, 4, 10], [110, 5, 9], [111, 6, 8], [112, 7, 7]]);
  // left, button columns 0-17 of a horizontal bar: apex at column 5, base at column 9 (rows 3-11)
  const left = rasterize(arrowSvg({ x: 0, y: 0, w: 18, h: 15 }, 'left', grey, false), 18, 15);
  assert.deepEqual([left[0], left.at(-1)], [[3, 9, 9], [11, 9, 9]]);
  assert.deepEqual(left.find(([y]) => y === 7), [7, 5, 9]);
  // thin (10 x 12 button): rows 4-6 with 2, 4 and 6 px
  assert.deepEqual(rasterize(arrowSvg({ x: 0, y: 0, w: 10, h: 12 }, 'up', grey, false), 10, 12), [[4, 4, 5], [5, 3, 6], [6, 2, 7]]);
  // Windows: the Segoe Fluent Icons glyph on the rect's baseline
  assert.match(arrowSvg({ x: 0, y: 0, w: 15, h: 18 }, 'up', grey, true), /<text x="3" y="12.5" font-family="Segoe Fluent Icons" font-size="9"[^>]*>&#xEDDB;<\/text>/);
  // positive control: the rasterizer sees a misplaced arrow
  assert.notDeepEqual(rasterize(arrowSvg({ x: 0, y: 1, w: 15, h: 18 }, 'up', grey, false), 15, 18)[0], [6, 7, 7]);
});

test('colours (measured): Fluent track / thumb / arrows, the macOS track, borders and translucent thumb, scrollbar-color', () => {
  assert.deepEqual([barColors(look({})).track, barColors(look({})).thumb, barColors(look({})).arrow], ['#fcfcfc', '#8b8b8b', '#8b8b8b'], 'Fluent light: 252, 139');
  assert.deepEqual([barColors(look({ dark: true })).track, barColors(look({ dark: true })).thumb], ['#2c2c2c', '#9f9f9f'], 'Fluent dark: 44, 159');
  const mac = barColors(look({ theme: 'mac' }));
  assert.deepEqual([mac.track, mac.inner, mac.outer], ['#fafafa', '#e8e8e8', '#ededed'], 'macOS light: 250, inner 232, outer 237');
  const a = Number(/** @type {RegExpMatchArray} */ (mac.thumb.match(/[\d.]+\)$/))[0].slice(0, -1));
  assert.equal(Math.round(250 * (1 - a)), 193, 'the translucent thumb over the track is 193, as measured');
  assert.deepEqual([barColors(look({ theme: 'mac', dark: true })).thumb, barColors(look({ theme: 'mac', dark: true })).inner], ['#6b6b6b', '#3d3d3d'], 'macOS dark: 107, 61');
  const authored = { thumb: 'rgb(194, 65, 12)', track: 'rgb(253, 232, 216)' };
  assert.deepEqual(barColors(look({ theme: 'mac', authored })), { track: authored.track, gradient: null, inner: authored.track, outer: authored.track, thumb: authored.thumb, arrow: '', corner: authored.track });
  assert.equal(barColors(look({ authored })).arrow, authored.thumb, 'Fluent arrows in the thumb colour');
  // the track markup carries what the look says: Fluent buttons, the macOS borders
  assert.equal((trackSvg(look({}), true, 15, 120, 18).match(/<path/g) ?? []).length, 2);
  assert.ok(trackSvg(look({ theme: 'mac' }), true, 15, 120, 0).includes('fill="#e8e8e8"') && !trackSvg(look({ theme: 'mac' }), true, 15, 120, 0).includes('<path'));
  assert.ok(cornerSvg(look({}), 15, 15).includes('#fcfcfc'));
});

test('a textarea or listbox select is pinned at its live border box (its intrinsic size counts the bar, overlay bars included; the clone has none)', () => {
  const decl = barBoxPin({ width: 182.5, height: 41.25 });
  assert.ok(decl.includes('width:182.5px!important') && decl.includes('height:41.25px!important') && decl.includes('box-sizing:border-box!important'), decl);
  assert.ok(decl.includes('min-width:0!important') && decl.includes('max-width:none!important'), 'author min / max sizes cannot move it');
  assert.equal(barBoxPin({ width: 0, height: 20 }), '', 'no box: nothing pinned');
});
