/**
 * PURE geometry and colour of Firefox's form controls (the non-native widget theme, widget/Theme.cpp, which Firefox uses for content on macOS too), as SVG skins.
 * Module: snapshot-capture (src/snapshot/capture/*).
 *
 * Why: Gecko does not theme widgets inside an SVG image at all (a checkbox or radio is simply absent, a text field falls back to the UA's 2 px inset border, a range shows
 * only its thumb). Every number below is ported from Theme.cpp / ThemeDrawing.cpp / ThemeColors.cpp (mozilla-central 2026-10) and checked against the live page pixels.
 * Sizes in css px of the control's border box; colours [r, g, b, a] (0-255, alpha 0-1).
 */

import { css, luminance, svgDoc } from './webkit-skins.js';

/** @typedef {import('./webkit-skins.js').Rgba} Rgba */

/**
 * Colours of one scheme (Theme.cpp System() colours resolved in the live page: ButtonBorder, ButtonFace, Field, AccentColor, AccentColorText; the -moz-* ones are not exposed to
 * content and come from nsXPLookAndFeel's stand-ins).
 * @typedef {Object} GeckoPalette
 * @property {boolean} dark
 * @property {Rgba} border          ButtonBorder
 * @property {Rgba} face            ButtonFace
 * @property {Rgba} field           Field
 * @property {Rgba} disabledFace    -moz-buttondisabledface
 * @property {Rgba} disabledField   -moz-disabledfield
 * @property {Rgba} disabledBorder  -moz-buttondisabledborder
 * @property {Rgba} hoverFace       -moz-buttonhoverface
 * @property {Rgba} activeFace      -moz-buttonactiveface
 * @property {Rgba} hoverBorder     -moz-buttonhoverborder
 * @property {Rgba} activeBorder    -moz-buttonactiveborder
 */

/** Interaction state of the live control (ElementState HOVER, ACTIVE = hover + active). @typedef {{hover?: boolean, active?: boolean}} Pointer */

const GREY10 = /** @type {Rgba} */ ([0xe9, 0xe9, 0xed, 1]);
const GREY20 = /** @type {Rgba} */ ([0xd0, 0xd0, 0xd7, 1]);
const GREY60 = /** @type {Rgba} */ ([0x48, 0x48, 0x51, 1]);
const GREY10_50 = /** @type {Rgba} */ ([0xe9, 0xe9, 0xed, 0x7f / 255]);
const GREY40 = /** @type {Rgba} */ ([0x8f, 0x8f, 0x9d, 1]);
const GREY40_50 = /** @type {Rgba} */ ([0x8f, 0x8f, 0x9d, 0x7f / 255]);
const GREY50 = /** @type {Rgba} */ ([0x67, 0x67, 0x74, 1]);
const WHITE = /** @type {Rgba} */ ([255, 255, 255, 1]);
const NONE = /** @type {Rgba} */ ([0, 0, 0, 0]);
const METER = { optimum: [[0x00, 0xab, 0x60, 1], [0x05, 0x61, 0x39, 1]], suboptimal: [[0xff, 0xbd, 0x4f, 1], [0xd2, 0x81, 0x1e, 1]], 'even-less-good': [[0xe2, 0x28, 0x50, 1], [0x81, 0x02, 0x20, 1]] };

/** ButtonBorder of Firefox 155-157 in both schemes (nsXPLookAndFeel stand-in #8f8f9d). */
const BUTTONBORDER_157 = [0x8f, 0x8f, 0x9d];

/**
 * -moz-buttondisabledborder, which content cannot read. Firefox 158 (bug 2063178, "Differentiate default and disabled checkbox/radio more") replaced it together with
 * ButtonBorder, which content can read: Firefox 155-157 ButtonBorder #8f8f9d, disabled border #8f8f9d at 0x7f alpha (light; as composited over white, #c7c7ce) and opaque
 * #8f8f9d (dark); Firefox 158+ ButtonBorder #817f84 (light) / #949297 (dark), disabled border #c7c6cb (light) / #515054 (dark), both at 0x7f alpha. The live ButtonBorder
 * therefore tells the two apart; any other ButtonBorder gets the current palette. Measured on macOS in Firefox 155.0.1, 157.0.1, 158.0 and 159.0.
 * @param {Rgba} buttonBorder the live ButtonBorder of the scheme @param {boolean} dark @returns {Rgba}
 */
export function geckoDisabledBorder(buttonBorder, dark) {
  if (BUTTONBORDER_157.every((v, i) => buttonBorder[i] === v)) return dark ? [0x8f, 0x8f, 0x9d, 1] : [0xc7, 0xc7, 0xce, 1];
  return dark ? [0x51, 0x50, 0x54, 0x7f / 255] : [0xc7, 0xc6, 0xcb, 0x7f / 255];
}

/** @param {number} v 0-255 */
const lin =(v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
/** @param {number} v linear */
const gam = (v) => { const c = Math.min(1, Math.max(0, v)); return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055); };

/**
 * RelativeLuminanceUtils::Adjust: every linear channel c becomes (c + 0.05) x k - 0.05 with k = (target + 0.05) / (L + 0.05), clamped at 0.
 * @param {Rgba} c @param {number} target @returns {Rgba}
 */
export function adjustLuminance(c, target) {
  const k = (target + 0.05) / (luminance(c) + 0.05);
  const ch = (/** @type {number} */ v) => Math.round(gam(Math.max(0, (lin(v) + 0.05) * k - 0.05)));
  return [ch(c[0]), ch(c[1]), ch(c[2]), c[3]];
}

/** ThemeColors::ScaleLuminanceBy @param {number} l @param {number} f */
const scaleLuminance = (l, f) => (l + 0.05) * f - 0.05;

/** Measured system accent -> [accent, hover (dark), pressed (darker)] shades on macOS. @type {[number[], Rgba, Rgba][]} */
const SYSTEM_SHADES = [[[0, 122, 255], [0, 102, 222, 1], [0, 81, 190, 1]]];

/**
 * The accent palette (ThemeColors.cpp ColorPalette): an author accent gets its dark (9.338/13.693) and darker shades by luminance and a white or darkened foreground; the system
 * accent (AccentColor / AccentColorText) gets its dark shade the same way. `minContrast` / `target` are the layout.css.accent-color prefs (3 and 6 by default).
 * @param {Rgba} accent @param {Rgba} accentText @param {boolean} authored @returns {{accent: Rgba, fg: Rgba, dark: Rgba, darker: Rgba}}
 */
export function accentPalette(accent, accentText, authored) {
  const a = accent[3] === 1 ? accent : /** @type {Rgba} */ ([255 + (accent[0] - 255) * accent[3], 255 + (accent[1] - 255) * accent[3], 255 + (accent[2] - 255) * accent[3], 1]);
  const l = luminance(a);
  const fg = !authored ? accentText : 1.05 / (l + 0.05) >= 3 ? WHITE : adjustLuminance(a, (l + 0.05) / 6 - 0.05);
  // the SYSTEM accent's shades come from the OS, not from the luminance scaling (measured Firefox 157, macOS blue accent 0,122,255: hover 0,102,222, pressed 0,81,190)
  const sys = !authored && SYSTEM_SHADES.find((s) => s[0].every((v, i) => Math.abs(v - a[i]) <= 1));
  if (sys) return { accent: a, fg, dark: sys[1], darker: sys[2] };
  return { accent: a, fg, dark: adjustLuminance(a, scaleLuminance(l, 9.338 / 13.693)), darker: adjustLuminance(a, scaleLuminance(l, 5.901 / 13.693)) };
}

/**
 * Theme::ComputeBorderColor (without the focus ring, which the clone's outline draws).
 * @param {GeckoPalette} p @param {boolean} disabled @param {Pointer} ptr @returns {Rgba}
 */
const borderOf = (p, disabled, ptr) => (disabled ? p.disabledBorder : ptr.active ? p.activeBorder : ptr.hover ? p.hoverBorder : p.border);

/** @param {number} n */
const f = (n) => String(+n.toFixed(3));

/**
 * ThemeDrawing::PaintRoundedRectWithRadius: the stroke centred on the rect deflated by half the border width, radius (r - bw/2) clamped to half the smaller side.
 * @param {number} x @param {number} y @param {number} w @param {number} h @param {Rgba} bg @param {Rgba} border @param {number} bw @param {number} r @param {string} [clip]
 */
function rrect(x, y, w, h, bg, border, bw, r, clip = '') {
  const rx = x + bw / 2, ry = y + bw / 2, rw = w - bw, rh = h - bw;
  if (rw <= 0 || rh <= 0) return '';
  const rad = Math.max(0, Math.min(r - bw / 2, Math.min(rw, rh) / 2));
  const stroke = bw && border[3] ? ` stroke="${css(border)}" stroke-width="${f(bw)}"` : '';
  return `<rect x="${f(rx)}" y="${f(ry)}" width="${f(rw)}" height="${f(rh)}" rx="${f(rad)}" fill="${bg[3] ? css(bg) : 'none'}"${stroke}${clip}/>`;
}

/**
 * Theme::PaintCheckboxControl / PaintRadioControl on CheckBoxRadioRect (a square of the smaller side, centred). Checkbox: radius 4, 1 px border, check = the polyline
 * (3.5,-3.1) (-1.3,2.6) (-3.9,0) x side/14 stroked 2 x side/14 with round caps; indeterminate: a bar 1 x side/14 tall. Radio: a circle of the check colour with a 1 px border,
 * checked: the accent ring then the inner disc (inset 1 + 3 px) in the accent; disabled checked: border colour fill with a white (80 % / dark 40 %) mark.
 * @param {number} w @param {number} h @param {{type: 'checkbox'|'radio', checked: boolean, indeterminate: boolean, disabled: boolean, accent: {accent: Rgba, fg: Rgba, dark: Rgba, darker: Rgba}} & Pointer} s
 * @param {GeckoPalette} p @returns {string}
 */
export function geckoToggleSkin(w, h, s, p) {
  const side = Math.floor(Math.min(w, h) * 2) / 2, x = (w - side) / 2, y = (h - side) / 2, k = side / 14;
  const on = s.checked || (s.type === 'checkbox' && s.indeterminate);
  let bg, border, mark;
  if (on) {
    if (s.disabled) { bg = border = p.disabledBorder; mark = /** @type {Rgba} */ ([255, 255, 255, p.dark ? 0.4 : 0.8]); } else { bg = border = s.active ? s.accent.darker : s.hover ? s.accent.dark : s.accent.accent; mark = s.accent.fg; }
  } else { bg = s.disabled ? p.disabledField : p.field; border = borderOf(p, s.disabled, s); mark = NONE; }
  if (s.type === 'radio') {
    const fill = s.checked ? mark : bg;
    const ring = rrect(x, y, side, side, fill, border, fill === border ? 0 : 1, side);
    return svgDoc(w, h, ring + (s.checked ? rrect(x + 4, y + 4, side - 8, side - 8, bg, NONE, 0, side) : ''));
  }
  let body = rrect(x, y, side, side, bg, border, bg === border ? 0 : 1, 4);
  const cx = w / 2, cy = h / 2;
  if (on && s.indeterminate) {
    const inset = 1 * k + k / 8;
    body += `<rect x="${f(x + inset)}" y="${f(cy - k / 2)}" width="${f(side - 2 * inset)}" height="${f(k)}" fill="${css(mark)}"/>`;
  } else if (on) {
    const pt = (/** @type {number} */ px, /** @type {number} */ py) => `${f(cx + px * k)} ${f(cy + py * k)}`;
    body += `<path d="M${pt(3.5, -3.1)}L${pt(-1.3, 2.6)}L${pt(-3.9, 0)}" fill="none" stroke="${css(mark)}" stroke-width="${f(2 * k)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  return svgDoc(w, h, body);
}

/** nsITheme::GetMinimumRangeThumbSize */
const GECKO_THUMB = 20;

/**
 * Theme::PaintRange (horizontal): a 6 px bar centred vertically, radius 3, 1 px border; left of the thumb centre the progress colours (accent / accent dark; disabled grey40 50 %),
 * right of it the track (grey10 / grey40; disabled grey10 50 % / grey40 50 %; hovered: accent dark / darker and grey20 / grey50); a 20 px thumb (grey50, hovered grey60,
 * pressed the accent, disabled grey40) with a 2 px white border and, when enabled, a black 30 %
 * shadow offset (0, 2) blurred by a 2 px std deviation.
 * `out`: the skin covers the box grown by that much on every side (the shadow's room).
 * @param {number} w @param {number} h @param {{ratio: number, disabled: boolean, rtl?: boolean, accent: {accent: Rgba, dark: Rgba, darker: Rgba}} & Pointer} s @param {number} [out] @returns {string}
 */
export function geckoRangeSkin(w, h, s, out = 0) {
  const t = GECKO_THUMB, ty = (h - 6) / 2, tx = (s.rtl ? 1 - s.ratio : s.ratio) * (w - t), mid = tx + t / 2;
  const on = s.hover || s.active;
  const [pc, pb] = s.disabled ? [GREY40_50, GREY40_50] : on ? [s.accent.dark, s.accent.darker] : [s.accent.accent, s.accent.dark];
  const [tc, tb] = s.disabled ? [GREY10_50, GREY40_50] : on ? [GREY20, GREY50] : [GREY10, GREY40];
  const thumb = s.disabled ? GREY40 : s.active ? s.accent.accent : s.hover ? GREY60 : GREY50;
  const id = 'g' + Math.round(w * 100);
  const leftC = s.rtl ? tc : pc, leftB = s.rtl ? tb : pb, rightC = s.rtl ? pc : tc, rightB = s.rtl ? pb : tb;
  let body = `<clipPath id="l${id}"><rect x="-1" y="-1" width="${f(mid + 1)}" height="${f(h + 2)}"/></clipPath><clipPath id="r${id}"><rect x="${f(mid)}" y="-1" width="${f(w - mid + 1)}" height="${f(h + 2)}"/></clipPath>`
    + rrect(0, ty, w, 6, leftC, leftB, 1, 3, ` clip-path="url(#l${id})"`) + rrect(0, ty, w, 6, rightC, rightB, 1, 3, ` clip-path="url(#r${id})"`);
  const cy = (h - t) / 2;
  if (!s.disabled) body += `<filter id="f${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2"/></filter><circle cx="${f(mid)}" cy="${f(cy + t / 2 + 2)}" r="${f(t / 2)}" fill="rgba(0,0,0,0.3)" filter="url(#f${id})"/>`;
  body += rrect(tx, cy, t, t, thumb, WHITE, 2, t);
  return svgDoc(w, h, body, out);
}

/**
 * Theme::PaintProgress: a bar 6 px (meter 12 px) tall centred vertically, radius 3 (meter 6), 1 px border, track grey10 / grey40; the value part (accent / accent dark, or the meter
 * region's chunk / border colours) is the same rounded bar clipped to position x width. Indeterminate: a third of the width at the start (its animation clock is internal).
 * @param {number} w @param {number} h @param {{meter: boolean, position: number, region?: 'optimum'|'suboptimal'|'even-less-good', rtl?: boolean, accent: {accent: Rgba, dark: Rgba}}} s
 * @returns {string}
 */
export function geckoProgressSkin(w, h, s) {
  const th = s.meter ? 12 : 6, r = s.meter ? 6 : 3, y = (h - th) / 2;
  const [c, b] = s.meter ? /** @type {[Rgba, Rgba]} */ (METER[s.region ?? 'optimum']) : [s.accent.accent, s.accent.dark];
  const id = 'p' + Math.round(w * 100);
  let bx = 0, bw = w, cw = w * Math.min(1, Math.max(0, s.position));
  if (s.position < 0) { bw = w * 0.3333; cw = bw; }
  const cx = s.position >= 0 && s.rtl ? w - cw : 0;
  return svgDoc(w, h, rrect(0, y, w, th, GREY10, GREY40, 1, r)
    + `<clipPath id="${id}"><rect x="${f(cx)}" y="${f(y - 1)}" width="${f(cw)}" height="${f(th + 2)}"/></clipPath>` + rrect(bx, y, bw, th, c, b, 1, r, ` clip-path="url(#${id})"`));
}

/**
 * Theme::PaintButton / PaintMenulist (radius 4, 1 px border; face / border, disabled: -moz-buttondisabledface / -moz-buttondisabledborder) and PaintTextField / PaintListbox
 * (radius 4, 1 px border; Field / border, disabled: -moz-disabledfield / -moz-buttondisabledborder). `extra` is drawn on top (menulist arrow, spinner); `ring` (the accent)
 * adds the focus ring and makes the skin 2 px larger on every side.
 * @param {number} w @param {number} h @param {{field: boolean, disabled: boolean, bg?: Rgba} & Pointer} s @param {GeckoPalette} p @param {string} [extra] @param {Rgba|null} [ring]
 * @returns {string}
 */
export function geckoBoxSkin(w, h, s, p, extra = '', ring = null) {
  const face = s.active ? p.activeFace : s.hover ? p.hoverFace : p.face;
  const bg = s.disabled ? (s.field ? p.disabledField : p.disabledFace) : s.field ? s.bg ?? p.field : face;
  const body = rrect(0, 0, w, h, bg, borderOf(p, s.disabled, s), 1, 4) + extra;
  // the focus ring (measured Firefox 157, text field): 2 px of the accent centred on the border-box edge and 1 px of white outside it, so the skin covers the box grown by
  // 2 px on every side
  if (ring) return svgDoc(w, h, body + `<rect x="-1.5" y="-1.5" width="${f(w + 3)}" height="${f(h + 3)}" rx="5.5" fill="none" stroke="#fff" stroke-width="1"/><rect x="0" y="0" width="${f(w)}" height="${f(h)}" rx="4" fill="none" stroke="${css(ring)}" stroke-width="2"/>`, 2);
  return svgDoc(w, h, body);
}

/**
 * Theme::PaintMenulistArrow: the polygon scaled by min(side)/18 around the centre of the 18 px drop-down button at the inline end of the content box, in the text colour.
 * @param {{x: number, y: number, w: number, h: number}} box the arrow button rect @param {Rgba} color @returns {string}
 */
export function geckoArrow(box, color) {
  const xs = [-4, -0.5, 0.5, 4, 4, 3, 0, 0, -3, -4], ys = [-1, 3, 3, -1, -2, -2, 1.5, 1.5, -2, -2];
  const k = Math.min(box.w, box.h) / 18, cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  return `<path d="M${xs.map((x, i) => `${f(cx + x * k)} ${f(cy + ys[i] * k)}`).join('L')}Z" fill="${css(color)}"/>`;
}

/**
 * Firefox's macOS classic scrollbar of a listbox select (ScrollbarDrawingMac; the listbox is `overflow-y: scroll` with `scrollbar-width: thin`, so the 11 px gutter shows even
 * when nothing scrolls), measured on Firefox 157.0.1: the gutter's inner edge line (light 231, dark 51), a second line (248 / 46), the track (250 / 46) and the outer edge line
 * (237 / 49); a fully rounded thumb (194 / 117) 6 px thick (8 px in a 15 px gutter) ending 2 px (3 px) before the outer edge. Its frame length is (L - 6) x client / scroll
 * height, at least 27 px, travelling along the whole track L; the drawn thumb is the frame deflated by 1.5 px at both ends.
 * @param {{track: number, client: number, scroll: number, offset: number}} s track length (= clientHeight), client and scroll height, scrollTop
 * @returns {{start: number, length: number}|null} the drawn thumb along the track, null when nothing scrolls
 */
export function geckoListboxThumb(s) {
  if (!(s.scroll > s.client + 0.5)) return null;
  const frame = Math.min(s.track, Math.max(27, ((s.track - 6) * s.client) / s.scroll));
  const ratio = Math.min(1, Math.max(0, s.offset / (s.scroll - s.client)));
  return { start: 1.5 + ratio * (s.track - frame), length: frame - 3 };
}

/**
 * The listbox gutter + thumb as SVG in border-box coordinates.
 * @param {{x: number, y: number, w: number, h: number}} g the vertical gutter rect @param {{start: number, length: number}|null} thumb @param {boolean} dark @param {boolean} [rtl]
 * @returns {string}
 */
export function geckoListboxBar(g, thumb, dark, rtl = false) {
  const [inner, second, track, outer, knob] = dark ? [51, 46, 46, 49, 117] : [231, 248, 250, 237, 194];
  const grey = (/** @type {number} */ v) => css([v, v, v, 1]);
  const col = (/** @type {number} */ x, /** @type {number} */ w, /** @type {number} */ v) => `<rect x="${f(rtl ? g.x + g.w - x - w : g.x + x)}" y="${f(g.y)}" width="${f(w)}" height="${f(g.h)}" fill="${grey(v)}"/>`;
  let body = col(0, g.w, track) + col(0, 1, inner) + col(1, 1, second) + col(g.w - 1, 1, outer);
  if (thumb) {
    const thick = g.w <= 11 ? 6 : 8, end = g.w <= 11 ? 2 : 3, x = g.w - end - thick;
    body += `<rect x="${f(rtl ? g.x + g.w - x - thick : g.x + x)}" y="${f(g.y + thumb.start)}" width="${thick}" height="${f(Math.max(0, thumb.length))}" rx="${thick / 2}" fill="${grey(knob)}"/>`;
  }
  return body;
}
