/**
 * Chromium's classic (non-overlay) scrollbars as the engine paints them, for the clone (scroll-emulation.js): the macOS legacy look (Blink ScrollbarThemeMac, painted
 * by ui NativeThemeMac) or the Fluent look of Linux, Windows and ChromeOS (ScrollbarThemeFluent / NativeThemeFluent: arrow buttons, the thumb between them, the colours
 * of the Fluent colour mixer). The geometry follows the engine's integer rules in DEVICE pixels (thickness, button length, thumb length and position are whole device
 * pixels; the thumb position is truncated), then it is drawn in css px (device px / devicePixelRatio).
 *
 * Which look is MEASURED, not read from the user agent: both are 15 DIP thick, but Fluent rounds 15 k and 10 k (`scrollbar-width: thin` is 2/3 of the thickness) while
 * the macOS look truncates 15 k and 11 k (k = the device scale), so the auto and thin thicknesses of an unstyled probe tell them apart at every scale
 * (1x: 15 / 10 against 15 / 11; 1.25x: 19 / 13 against 18 / 13; 1.5x: 23 / 15 against 22 / 16; 2x: 30 / 20 against 30 / 22). The platform decides only when both
 * or neither fit (a page zoom can make them ambiguous). The Windows arrows are glyphs of the Segoe Fluent Icons font where it is installed (measured with the canvas text metrics), else the triangles
 * Linux draws. Measured on Chrome 155: Linux (headless, the CI image) and macOS with classic bars (G-platform scrollers / controls); Windows by the CI job.
 * Module: snapshot-capture (src/snapshot/capture/*).
 */

/** @typedef {'mac'|'fluent'} BarTheme */
/** @typedef {{x: number, y: number, w: number, h: number}} Box */

/**
 * @typedef {Object} BarLook  how one scroller's classic bars are painted
 * @property {BarTheme} theme
 * @property {number} k  the scale of the bar's DIP lengths (the device scale factor)
 * @property {number} dpr  device px per css px
 * @property {boolean} thin  scrollbar-width: thin
 * @property {boolean} dark  the scroller's used colour scheme is dark
 * @property {{thumb: string, track: string}|null} authored  scrollbar-color
 * @property {boolean} glyphs  Fluent arrows are Segoe Fluent Icons glyphs (Windows)
 */

/** std::round (half away from zero) @param {number} v */
const stdRound = (v) => Math.sign(v) * Math.round(Math.abs(v));

/**
 * PURE. The theme whose thickness rules give the measured auto and thin thicknesses (device px) at the device pixel ratio or at the scale the auto thickness implies.
 * @param {number} auto @param {number} thin @param {number} dpr @param {boolean} macPlatform  the fallback when the measurement fits both themes or neither
 * @returns {{theme: BarTheme, k: number}}
 */
export function barThemeOf(auto, thin, dpr, macPlatform) {
  /** @type {Record<BarTheme, (k: number) => boolean>} */
  const fits = {
    fluent: (k) => stdRound(15 * k) === auto && stdRound(15 * (2 / 3) * k) === thin,
    mac: (k) => Math.trunc(15 * k) === auto && Math.trunc(11 * k) === thin,
  };
  // the device pixel ratio first; under page zoom (devicePixelRatio = device scale x zoom) the scale the auto thickness implies
  for (const k of [dpr, auto / 15]) {
    const fluent = fits.fluent(k), mac = fits.mac(k);
    if (fluent !== mac) return { theme: fluent ? 'fluent' : 'mac', k };
  }
  return { theme: macPlatform ? 'mac' : 'fluent', k: fits.fluent(dpr) || fits.mac(dpr) ? dpr : auto / 15 };
}

/**
 * PURE. The thumb of a bar, along / across its axis in device px from the bar's origin: Blink's ThumbLength (stdRound(visible / total x track), at least the minimum, at
 * most the track) and ThumbPosition (truncated), then the painted rect (NativeThemeMac insets it; Fluent centres a thinner thumb across the bar).
 * @param {BarLook} look @param {{thick: number, len: number, visible: number, total: number, offset: number}} b  device px: bar thickness and length, scrollport and
 *   content length, scroll offset
 * @returns {{buttons: number, thumb: {at: number, len: number, across: number, thick: number}|null}}
 */
export function barParts(look, b) {
  const { k } = look, p = look.thin ? 2 / 3 : 1;
  let buttons = 0, track = b.len, min;
  if (look.theme === 'fluent') {
    buttons = stdRound(18 * p * k);
    if (b.len < 2 * buttons) buttons = Math.floor(b.len / 2);
    track = b.len - 2 * buttons;
    min = Math.trunc(17 * p * k);
  } else {
    min = Math.trunc((look.thin ? 16 : 20) * k);
    if (b.len < (look.thin ? 20 : 24)) return { buttons, thumb: null };
  }
  const range = b.total - b.visible;
  if (!(range > 0) || track <= 0) return { buttons, thumb: null };
  const len = Math.min(track, Math.max(stdRound((b.visible / b.total) * track), min));
  const raw = (Math.max(0, b.offset) * (track - len)) / range;
  const at = buttons + (raw > 0 && raw < 1 ? 1 : Math.trunc(raw));
  if (look.theme === 'fluent') {
    const t0 = stdRound(9 * p * k), thick = t0 - ((b.thick - t0) % 2);
    return { buttons, thumb: { at, len, across: Math.trunc((b.thick - thick) / 2), thick } };
  }
  // NativeThemeMac::PaintMacScrollbarThumb: inset stdRound(3 k) on every side and the track border more towards the content, within the minimum size (6 x 18) x k
  const base = stdRound(3 * k), border = Math.floor(k);
  const across = constrain(b.thick, stdRound(6 * k), base + border, base), along = constrain(len, stdRound(18 * k), base, base);
  return { buttons, thumb: { at: at + along[0], len: len - along[0] - along[1], across: across[0], thick: b.thick - across[0] - across[1] } };
}

/** ConstrainInsets of NativeThemeMac. @param {number} size @param {number} min @param {number} a @param {number} b @returns {[number, number]} */
function constrain(size, min, a, b) {
  const total = a + b, max = size - min;
  if (total === 0 || total < max) return [a, b];
  if (max < 0) return [0, 0];
  const right = Math.trunc((b * max) / total);
  return [max - right, right];
}

/**
 * PURE. Colours of the look: track, the borders of the macOS track (inner = towards the content), thumb, arrow, corner. scrollbar-color sets the track (and the macOS
 * borders, the Fluent buttons and corner) and the thumb (and the Fluent arrows).
 * @param {BarLook} look
 */
export function barColors(look) {
  const a = look.authored, d = look.dark;
  if (look.theme === 'fluent') {
    const track = a?.track ?? (d ? '#2c2c2c' : '#fcfcfc'), thumb = a?.thumb ?? (d ? '#9f9f9f' : '#8b8b8b');
    return { track, gradient: null, inner: null, outer: null, thumb, arrow: thumb, corner: track };
  }
  if (a) return { track: a.track, gradient: null, inner: a.track, outer: a.track, thumb: a.thumb, arrow: '', corner: a.track };
  return d
    ? { track: '#2d2d2d', gradient: '#2b2b2b', inner: '#3d3d3d', outer: '#515151', thumb: '#6b6b6b', arrow: '', corner: '#2d2d2d' }
    : { track: '#fafafa', gradient: null, inner: '#e8e8e8', outer: '#ededed', thumb: 'rgba(0,0,0,0.2275)', arrow: '', corner: '#fafafa' };
}

/** @param {number} v */
const fmt = (v) => +v.toFixed(3);
/** @param {number} x @param {number} y @param {number} w @param {number} h @param {string} fill */
const svgRect = (x, y, w, h, fill) => (w > 0 && h > 0 ? `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" fill="${fill}"/>` : '');

/** Segoe Fluent Icons code points of the arrows (NativeThemeFluent kArrowCodePoints) */
const GLYPH = { up: '&#xEDDB;', down: '&#xEDDC;', left: '&#xEDD9;', right: '&#xEDDA;' };

/**
 * PURE. A Fluent arrow in its button (device px): NativeThemeFluent::GetArrowRect (9 DIP scaled by the button length / 18, centred, offset one scaled px towards the
 * start) filled with NativeThemeBase::PathForArrow, without antialiasing (crisp edges: the pixels whose centres fall inside), or the font glyph drawn on the rect's bottom.
 * @param {Box} btn @param {'up'|'down'|'left'|'right'} dir @param {string} fill @param {boolean} glyph
 * @returns {string} SVG markup
 */
export function arrowSvg(btn, dir, fill, glyph) {
  const vertical = dir === 'up' || dir === 'down';
  const sf = Math.max(btn.w, btn.h) / 18, small = Math.min(btn.w, btn.h);
  let side = Math.ceil(9 * sf);
  if (!glyph) side += (small - side) % 2;
  let x = btn.x + (btn.w - side) / 2, y = btn.y + (btn.h - side) / 2;
  if (!glyph) { x = Math.floor(x); y = Math.floor(y); }
  const off = stdRound((dir === 'up' || dir === 'left' ? -1 : 1) * sf);
  if (vertical) y += off; else x += off;
  if (glyph) return `<text x="${fmt(x)}" y="${fmt(y + side)}" font-family="Segoe Fluent Icons" font-size="${fmt(side)}" fill="${fill}">${GLYPH[dir]}</text>`;
  /** @type {Array<[number, number]>} */
  let pts;
  if (vertical) {
    const ah = Math.trunc(stdRound(side) / 2) + 1, by = y + side - Math.trunc(ah / 2) + 1;
    pts = [[x, by], [x + side, by], [x + side / 2, by - ah]];
  } else {
    const aw = Math.trunc(stdRound(side) / 2) + 1, bx = x + Math.trunc(aw / 2);
    pts = [[bx, y], [bx, y + side], [bx + aw, y + side / 2]];
  }
  const cx = x + side / 2, cy = y + side / 2;
  if (dir === 'down') pts = pts.map(([px, py]) => [px, 2 * cy - py]);
  if (dir === 'left') pts = pts.map(([px, py]) => [2 * cx - px, py]);
  return `<path d="M${pts.map(([px, py]) => `${fmt(px)} ${fmt(py)}`).join('L')}Z" fill="${fill}" shape-rendering="crispEdges"/>`;
}

/**
 * PURE. The track of a bar and its buttons (no thumb) as SVG markup in device px, the bar at (0, 0). Vertical bars have their content on the left, horizontal ones above.
 * @param {BarLook} look @param {boolean} vertical @param {number} thick @param {number} len @param {number} buttons  button length (Fluent), 0 for none
 * @returns {string}
 */
export function trackSvg(look, vertical, thick, len, buttons) {
  const c = barColors(look);
  const W = vertical ? thick : len, H = vertical ? len : thick;
  /** along / across -> x, y, w, h */
  const r = (/** @type {number} */ at, /** @type {number} */ l, /** @type {number} */ across, /** @type {number} */ t, /** @type {string} */ fill) => (vertical ? svgRect(across, at, t, l, fill) : svgRect(at, across, l, t, fill));
  let body = '';
  if (c.gradient) {
    body += `<defs><linearGradient id="g" x1="0" y1="0" x2="${vertical ? 0 : 1}" y2="${vertical ? 1 : 0}"><stop offset="0" stop-color="${c.track}"/><stop offset="1" stop-color="${c.gradient}"/></linearGradient></defs>`;
    body += svgRect(0, 0, W, H, 'url(#g)');
  } else body += svgRect(0, 0, W, H, c.track);
  if (look.theme === 'mac' && c.inner && c.outer) {
    const bw = Math.floor(look.k);
    body += r(0, len, 0, bw, c.inner) + r(0, len, thick - bw, bw, c.outer);
  }
  if (look.theme === 'fluent' && buttons > 0) {
    const first = vertical ? { x: 0, y: 0, w: W, h: buttons } : { x: 0, y: 0, w: buttons, h: H };
    const last = vertical ? { x: 0, y: len - buttons, w: W, h: buttons } : { x: len - buttons, y: 0, w: buttons, h: H };
    body += arrowSvg(first, vertical ? 'up' : 'left', c.arrow, look.glyphs) + arrowSvg(last, vertical ? 'down' : 'right', c.arrow, look.glyphs);
  }
  return body;
}

/**
 * PURE. The corner between two bars (device px): the Fluent corner colour, or the macOS track with its inner border as a square at the content corner and its outer
 * border along the bottom and the right.
 * @param {BarLook} look @param {number} w @param {number} h @returns {string}
 */
export function cornerSvg(look, w, h) {
  const c = barColors(look);
  if (look.theme === 'fluent' || !c.inner || !c.outer) return svgRect(0, 0, w, h, c.corner);
  const bw = Math.floor(look.k);
  return svgRect(0, 0, w, h, c.corner) + svgRect(0, 0, bw, bw, c.inner) + svgRect(0, h - bw, w, bw, c.outer) + svgRect(w - bw, 0, bw, h, c.outer);
}

/**
 * The markup as a css background image of `cssW` x `cssH` px whose user units are device px.
 * @param {string} body @param {number} cssW @param {number} cssH @param {number} dpr @returns {string} a url() value
 */
export function svgUrl(body, cssW, cssH, dpr) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(cssW)}" height="${fmt(cssH)}" viewBox="0 0 ${fmt(cssW * dpr)} ${fmt(cssH * dpr)}" preserveAspectRatio="none">${body}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg).replace(/\(/g, '%28').replace(/\)/g, '%29')}")`;
}

/** Per document: Segoe Fluent Icons is installed (its arrow glyph is not the fallback's). @type {WeakMap<Document, boolean>} */
const glyphFonts = new WeakMap();

/** @param {Document} doc @returns {boolean} */
export function hasArrowGlyphs(doc) {
  let v = glyphFonts.get(doc);
  if (v !== undefined) return v;
  v = false;
  try {
    const ctx = doc.createElement('canvas').getContext('2d');
    if (ctx) {
      const w = (/** @type {string} */ font) => { ctx.font = font; return ctx.measureText('').width; };
      v = w('20px "Segoe Fluent Icons", monospace') !== w('20px monospace') || w('20px "Segoe Fluent Icons", serif') !== w('20px serif');
    }
  } catch { v = false; }
  glyphFonts.set(doc, v);
  return v;
}
