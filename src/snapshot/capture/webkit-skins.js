/**
 * PURE geometry and colour of the macOS WebKit form controls (the "form control refresh" look of Safari 26/27), as SVG skins the clone paints instead of the native control.
 * Module: snapshot-capture (src/snapshot/capture/*).
 *
 * Why: WebKit draws native controls inside an SVG image with the LEGACY look (the image document does not get the `formControlRefreshEnabled` setting of the page) and ignores
 * accent-color there. Every number below is ported from WebKit's own painter (Source/WebCore/rendering/cocoa/RenderThemeCocoa.mm, the *ForVectorBasedControls functions) and
 * checked against the live page pixels (G-xbrowser `controls`): sizes in css px of the control's border box, colours as [r, g, b, a] (0-255, alpha 0-1).
 */

/** @typedef {[number, number, number, number]} Rgba */

/**
 * Colours of one colour scheme that the painter takes from the system (resolved in the live page by webkit-controls.js; the two `opaque` fills are not exposed to CSS and were
 * read off the live pixels: light 230 / 235, dark 52 / 47).
 * @typedef {Object} Palette
 * @property {boolean} dark
 * @property {Rgba} canvas           `Canvas`
 * @property {Rgba} controlBg        `-webkit-control-background`
 * @property {Rgba} label            `-apple-system-label`
 * @property {Rgba} secondaryLabel   `-apple-system-secondary-label`
 * @property {Rgba} tertiaryLabel    `-apple-system-tertiary-label`
 * @property {Rgba} quaternaryLabel  `-apple-system-quaternary-label`
 * @property {Rgba} quinaryLabel     `-apple-system-quinary-label`
 * @property {Rgba} containerBorder  `-apple-system-container-border`
 * @property {Rgba} opaqueFill       AppleSystemOpaqueFill (track of range, progress, meter)
 * @property {Rgba} opaqueSecondaryFill AppleSystemOpaqueSecondaryFill (push button, select)
 * @property {Rgba} green
 * @property {Rgba} yellow
 * @property {Rgba} red
 */

const DISABLED_ALPHA = 0.4;
const LUMINANCE_THRESHOLD = 0.5;

/** @param {number} v 0-255 @returns {number} linear 0-1 */
const lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
/** @param {number} v linear @returns {number} 0-255 */
const gam = (v) => { const c = Math.min(1, Math.max(0, v)); return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055); };

/** @param {Rgba} c @returns {number} relative luminance (WebKit Color::luminance) */
export function luminance(c) { return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]); }

/**
 * WebKit colorWithTargetLuminance: scale X and Z with Y in XYZ D65 (hue kept), back to sRGB, clipped to the gamut. A black colour becomes X = Y = Z = target (not neutral: pinkish).
 * @param {Rgba} c @param {number} target @returns {Rgba}
 */
export function withLuminance(c, target) {
  const [r, g, b] = [lin(c[0]), lin(c[1]), lin(c[2])];
  let x = 0.4123908 * r + 0.3575843 * g + 0.1804808 * b;
  const y = 0.2126390 * r + 0.7151687 * g + 0.0721923 * b;
  let z = 0.0193308 * r + 0.1191948 * g + 0.9505322 * b;
  if (y > 0) { x *= target / y; z *= target / y; } else { x = target; z = target; }
  const t = target;
  return [gam(3.2409699 * x - 1.5373832 * t - 0.4986108 * z), gam(-0.9692436 * x + 1.8759675 * t + 0.0415551 * z), gam(0.0556301 * x - 0.2039770 * t + 1.0569715 * z), c[3]];
}

/**
 * controlTintColorWithContrast: an AUTHOR accent colour too light for a light scheme (luminance > 0.5) or too dark for a dark one (<= 0.5) is moved to luminance 0.5; the system
 * accent (accent-color: auto) is used as it is.
 * @param {Rgba} c @param {boolean} dark @param {boolean} authored @returns {Rgba}
 */
export function tintWithContrast(c, dark, authored) {
  if (!authored) return c;
  const l = luminance(c);
  return (dark && l <= LUMINANCE_THRESHOLD - 1e-4) || (!dark && l > LUMINANCE_THRESHOLD) ? withLuminance(c, LUMINANCE_THRESHOLD) : c;
}

/** @param {Rgba} c @returns {Rgba} white or black for content drawn on `c` */
export const foregroundOn = (c) => (luminance(c) <= LUMINANCE_THRESHOLD + 1e-4 ? [255, 255, 255, 1] : [0, 0, 0, 1]);

/** @param {Rgba} top @param {Rgba} bottom @returns {Rgba} source-over */
export function over(top, bottom) {
  const a = top[3] + bottom[3] * (1 - top[3]);
  if (!a) return [0, 0, 0, 0];
  const ch = (/** @type {number} */ i) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a;
  return [ch(0), ch(1), ch(2), a];
}

/** @param {Rgba} c @param {number} k @returns {Rgba} */
export const alpha = (c, k) => [c[0], c[1], c[2], c[3] * k];

/**
 * The look of an accent-tinted part while the window is NOT key (macOS draws no accent in an inactive window), measured on Safari 27.0.1 (system and authored accent alike):
 * a checked checkbox / radio is filled with black 4.7 % (dark: white 4.4 %) over Canvas with its mark in the label colour; the range fill and the progress bar are black
 * 33 % (dark: white 32 %) over Canvas; a submit button looks like a plain push button.
 * @param {Palette} p @returns {{fill: Rgba, bar: Rgba}}
 */
export function inactiveTints(p) {
  return p.dark
    ? { fill: over([255, 255, 255, 0.044], p.canvas), bar: over([255, 255, 255, 0.32], p.canvas) }
    : { fill: over([0, 0, 0, 0.047], p.canvas), bar: over([0, 0, 0, 1 / 3], p.canvas) };
}

/**
 * The pressed shade of a filled part (measured Safari 27.0.1: a pressed push button, submit button, checkbox or radio blends every colour 20 % towards black, in the dark
 * appearance towards white: light fill 235 -> 188, accent 0,122,255 -> 1,97,204, empty box 255 -> 204 with its 50 % border at 60 %; dark fill 47 -> 88, accent -> 51,148,255).
 * @param {Rgba} c @param {boolean} dark @param {number} [k] @returns {Rgba}
 */
export const pressedShade = (c, dark, k = 0.2) => over(dark ? [255, 255, 255, k] : [0, 0, 0, k], c);

/** @param {Rgba} c @returns {string} */
export const css = (c) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${+c[3].toFixed(3)})`;

/** @param {number} n */
const n = (n) => String(+n.toFixed(3));

/** @param {number} x @param {number} y @param {number} w @param {number} h @param {number} r @param {Rgba} fill @param {string} [extra] */
const rect = (x, y, w, h, r, fill, extra = '') => (w > 0 && h > 0 ? `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(Math.min(r, w / 2, h / 2))}" fill="${css(fill)}"${extra}/>` : '');

/**
 * The SVG document of one skin. The box is the control's border box (0 0 w h) grown by `out` on each side for ink outside it (thumb shadow); `body` is drawn in box coordinates.
 * @param {number} w @param {number} h @param {string} body @param {number} [out] @returns {string}
 */
export function svgDoc(w, h, body, out = 0) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(w + 2 * out)}" height="${n(h + 2 * out)}" viewBox="${n(-out)} ${n(-out)} ${n(w + 2 * out)} ${n(h + 2 * out)}" preserveAspectRatio="none">${body}</svg>`;
}

/** @param {string} svg @returns {string} a CSS url() of the skin */
export const skinUrl = (svg) => `url("data:image/svg+xml,${encodeURIComponent(svg).replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29')}")`;

// ---------------------------------------------------------------------------------------------- checkbox and radio

const CHECK = 'M28.174 68.652C31.006 68.652 33.154 67.578 34.668 65.332L70.02 11.28C71.094 9.62 71.582 8.107 71.582 6.642C71.582 2.784 68.652 0.001 64.697 0.001C62.012 0.001 60.352 0.978 58.691 3.565L28.027 52.1L12.354 32.52C10.84 30.664 9.18 29.834 6.884 29.834C2.882 29.834 0 32.666 0 36.572C0 38.282 0.537 39.795 2.002 41.504L21.826 65.625C23.536 67.675 25.536 68.652 28.174 68.652Z';

/**
 * @typedef {Object} ToggleState
 * @property {'checkbox'|'radio'} type
 * @property {boolean} checked
 * @property {boolean} indeterminate
 * @property {boolean} disabled
 * @property {Rgba} tint  the accent after tintWithContrast (inactive window: inactiveTints().fill)
 * @property {Rgba} [ink]  the mark colour (inactive window: the label colour), else white or black for the fill
 * @property {boolean} [pressed]
 */

/**
 * paintCheckboxForVectorBasedControls / paintRadioForVectorBasedControls: a square of the smaller side, centred; checkbox corner 5.5/16 of it; empty: control background with a
 * 1.5 px inner border of secondary-label; checked: the tint (composited over Canvas) with a white or black check (0.581875 of the width, 0.24375 from the top) / dot (inner 30 %).
 * Disabled: background and border at half alpha.
 * @param {number} w @param {number} h @param {ToggleState} s @param {Palette} p @returns {string}
 */
export function toggleSkin(w, h, s, p) {
  const side = Math.min(w, h), x = (w - side) / 2, y = (h - side) / 2;
  const radio = s.type === 'radio';
  const r = radio ? side / 2 : side * 5.5 / 16;
  const on = s.checked || (!radio && s.indeterminate);
  let bg = over(on ? s.tint : p.controlBg, p.canvas);
  if (s.pressed) bg = pressedShade(bg, p.dark);
  let ink = s.ink ?? foregroundOn(bg);
  if (s.disabled) { ink = alpha(ink, 0.5); bg = over(alpha(bg, 0.5), p.canvas); }
  if (!on) {
    let border = s.disabled ? alpha(p.secondaryLabel, 0.5) : p.secondaryLabel;
    if (s.pressed) border = pressedShade(border, p.dark);
    return svgDoc(w, h, rect(x, y, side, side, r, bg) + rect(x + 0.75, y + 0.75, side - 1.5, side - 1.5, Math.max(0, r - 0.75), [0, 0, 0, 0], ` fill-opacity="0" stroke="${css(border)}" stroke-width="1.5"`));
  }
  let mark;
  if (radio) mark = `<circle cx="${n(w / 2)}" cy="${n(h / 2)}" r="${n(side * 0.15)}" fill="${css(ink)}"/>`;
  else if (s.indeterminate) { const bw = 0.40625 * side, bh = 0.15625 * side; mark = rect(w / 2 - bw / 2, h / 2 - bh / 2, bw, bh, bh / 2, ink); } else {
    const k = (0.581875 * side) / 71.582;
    mark = `<path transform="translate(${n(w / 2 - 71.582 * k / 2)} ${n(y + side * 0.24375)}) scale(${n(k)})" d="${CHECK}" fill="${css(ink)}"/>`;
  }
  return svgDoc(w, h, rect(x, y, side, side, r, bg) + mark);
}

// ---------------------------------------------------------------------------------------------- range

/** The native thumb box (adjustSliderThumbSizeForVectorBasedControls) and its shadow radius. */
export const THUMB = { w: 24, h: 16, shadow: 2 };

/**
 * paintSliderTrackForVectorBasedControls + paintSliderThumbForVectorBasedControls (horizontal): an 8 px track inset 1 px at the ends, fully rounded, ringed by 1 px of the control
 * background; the fill (tint) from the start to ratio x track width, clipped by the track; a white 24 x 16 pill thumb at ratio x (w - 24) with a 2 px black 24 % shadow. Disabled:
 * track, ring and fill at 40 % alpha (the thumb stays white).
 * @param {number} w @param {number} h @param {{ratio: number, disabled: boolean, tint: Rgba, rtl?: boolean, pressed?: boolean}} s @param {Palette} p @returns {string}
 */
export function rangeSkin(w, h, s, p) {
  const k = s.disabled ? DISABLED_ALPHA : 1;
  // pressed (measured Safari 27.0.1, light): thumb and fill 8 % darker, track 4.8 % darker
  if (s.pressed && !p.dark) { p = { ...p, opaqueFill: pressedShade(p.opaqueFill, false, 0.048) }; s = { ...s, tint: pressedShade(s.tint, false, 0.08) }; }
  const knob = s.pressed && !p.dark ? pressedShade([255, 255, 255, 1], false, 0.08) : /** @type {Rgba} */ ([255, 255, 255, 1]);
  const tx = w > 2 ? 1 : 0, tw = w > 2 ? w - 2 : w, ty = h / 2 - 4;
  const fw = tw * Math.min(1, Math.max(0, s.ratio));
  const thumbX = (s.rtl ? 1 - s.ratio : s.ratio) * (w - THUMB.w);
  const id = 'c' + Math.round(w * 100);
  const body = rect(tx - 1, ty - 1, tw + 2, 10, 5, alpha(p.controlBg, k)) + rect(tx, ty, tw, 8, 4, alpha(p.opaqueFill, k))
    + `<clipPath id="${id}">${rect(tx, ty, tw, 8, 4, [0, 0, 0, 1])}</clipPath><g clip-path="url(#${id})">${rect(s.rtl ? tx + tw - fw : tx, ty, fw, 8, 0, alpha(s.tint, k))}</g>`
    + `<filter id="f${id}" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="0" stdDeviation="1" flood-color="#000" flood-opacity="0.24"/></filter>`
    + rect(thumbX, (h - THUMB.h) / 2, THUMB.w, THUMB.h, THUMB.h / 2, knob, ` filter="url(#f${id})"`);
  return svgDoc(w, h, body, THUMB.shadow + 1);
}

// ---------------------------------------------------------------------------------------------- progress and meter

/**
 * paintProgressBarForVectorBasedControls (determinate, horizontal): an 8 px track (radius 4) inset 1 px at the ends with a 1 px control-background ring; the bar is position x
 * track width, radius 4, in the tint. Indeterminate (position < 0): a quarter-width bar at the start.
 * @param {number} w @param {number} h @param {{position: number, tint: Rgba}} s @param {Palette} p @returns {string}
 */
export function progressSkin(w, h, s, p) {
  const ty = (h - 8) / 2, tw = w - 2;
  // indeterminate (position -1): the native bar is a quarter of the track sliding by a clock the page cannot read; drawn at its start position
  const bar = s.position < 0 ? 0.25 * tw : Math.min(1, Math.max(0, s.position)) * tw;
  return svgDoc(w, h, rect(0, ty - 1, w, 10, 5, p.controlBg) + rect(1, ty, tw, 8, 4, p.opaqueFill) + rect(1, ty, bar, 8, 4, s.tint));
}

/**
 * paintMeterForVectorBasedControls (horizontal): the whole box rounded (radius half the smaller side) in the control background, inset 1 px the opaque fill, the gauge (green,
 * yellow or red by region) as a box of the inner size moved left by (1 - ratio) x its width, clipped by the inner shape.
 * @param {number} w @param {number} h @param {{ratio: number, region: 'optimum'|'suboptimal'|'even-less-good'}} s @param {Palette} p @returns {string}
 */
export function meterSkin(w, h, s, p) {
  const r = Math.min(w, h) / 2, iw = w - 2, ih = h - 2, ir = Math.max(0, r - 1);
  const color = s.region === 'optimum' ? p.green : s.region === 'suboptimal' ? p.yellow : p.red;
  const id = 'm' + Math.round(w * 100);
  return svgDoc(w, h, rect(0, 0, w, h, r, p.controlBg) + rect(1, 1, iw, ih, ir, p.opaqueFill)
    + `<clipPath id="${id}">${rect(1, 1, iw, ih, ir, [0, 0, 0, 1])}</clipPath><g clip-path="url(#${id})">${rect(1 + iw * (Math.min(1, Math.max(0, s.ratio)) - 1), 1, iw, ih, ir, color)}</g>`);
}

// ---------------------------------------------------------------------------------------------- push button, select, text field

/**
 * paintButtonForVectorBasedControls (macOS): radius 6, a 1 px inner ring of the control background; the fill is the tint for a submit-style button (input type=submit, button
 * type=submit written out), else the opaque secondary fill over Canvas; disabled at 40 % alpha. A select (menu list) is the same button plus the up/down chevron glyph.
 * @param {number} w @param {number} h @param {{fill: Rgba, disabled: boolean}} s @param {Palette} p @param {string} [glyph] extra SVG drawn on top
 * @returns {string}
 */
export function buttonSkin(w, h, s, p, glyph = '') {
  const fill = s.disabled ? alpha(s.fill, DISABLED_ALPHA) : s.fill;
  return svgDoc(w, h, rect(0, 0, w, h, 6, p.controlBg) + rect(1, 1, w - 2, h - 2, 5, fill) + glyph);
}

const POPUP = 'M7.05356 0C6.6506 0 6.31419 0.159764 5.98845 0.476187L0.449547 5.79359C0.188162 6.04876 0 6.37185 0 6.75753C0 7.5262 0.619975 8.0783 1.31101 8.0783C1.64075 8.0783 1.99003 7.97934 2.27895 7.69662L7.05356 3.02633L11.8215 7.69662C12.1171 7.97268 12.4597 8.0783 12.7895 8.0783C13.4805 8.0783 14.1005 7.5262 14.1005 6.75753C14.1005 6.37185 13.9159 6.04876 13.6509 5.79359L8.11201 0.476187C7.78627 0.159764 7.44987 0 7.05356 0ZM7.05356 20.1625C7.44987 20.1625 7.78627 19.9961 8.11201 19.6833L13.6509 14.3659C13.9159 14.1071 14.1005 13.7907 14.1005 13.3984C14.1005 12.6297 13.4805 12.0811 12.7895 12.0811C12.4597 12.0811 12.1171 12.1899 11.8215 12.4659L7.05356 17.1362L2.27895 12.4659C1.99003 12.1801 1.64075 12.0811 1.31101 12.0811C0.619975 12.0811 0 12.6297 0 13.3984C0 13.7907 0.188162 14.1071 0.449547 14.3659L5.98845 19.6833C6.31419 19.9961 6.6506 20.1625 7.05356 20.1625Z';

/**
 * paintMenuListButtonDecorationsForVectorBasedControls: the glyph is 0.55 em wide, vertically centred, its right edge `end` px left of the border box's right edge.
 * @param {number} w @param {number} h @param {number} em @param {number} end @param {Rgba} color @returns {string}
 */
export function popupGlyph(w, h, em, end, color) {
  const k = (0.55 * em) / 14.4618;
  return `<path transform="translate(${n(w - end - 14.4618 * k)} ${n(h / 2 - (20.1723 * k) / 2)}) scale(${n(k)})" d="${POPUP}" fill="${css(color)}"/>`;
}

/**
 * paintTextAreaOrTextField: the author/UA background colour in a radius-5 shape with a 0.5 px inner border of container-border; disabled: both at half alpha.
 * @param {number} w @param {number} h @param {{bg: Rgba, disabled: boolean, radius?: number}} s @param {Palette} p @param {string} [extra]
 * @returns {string}
 */
export function textFieldSkin(w, h, s, p, extra = '') {
  const k = s.disabled ? 0.5 : 1, r = s.radius ?? 5;
  return svgDoc(w, h, rect(0, 0, w, h, r, alpha(s.bg, k)) + rect(0.25, 0.25, w - 0.5, h - 0.5, Math.max(0, r - 0.25), [0, 0, 0, 0], ` fill-opacity="0" stroke="${css(alpha(p.containerBorder, k))}" stroke-width="0.5"`) + extra);
}

const CHEVRON_BOLD = { d: 'M22.6367 28.1836C23.75 28.1738 24.6582 27.7539 25.5273 26.8652L44.248 7.57812C44.9316 6.9043 45.2637 6.09375 45.2637 5.12695C45.2637 3.1543 43.6816 1.57227 41.7383 1.57227C40.7812 1.57227 39.873 1.95312 39.1504 2.68555L21.6211 20.8691L23.7012 20.8691L6.11328 2.68555C5.40039 1.97266 4.50195 1.57227 3.52539 1.57227C1.57227 1.57227 0 3.1543 0 5.12695C0 6.08398 0.351562 6.89453 1.00586 7.58789L19.7461 26.875C20.6445 27.7637 21.543 28.1836 22.6367 28.1836Z', w: 45.6348, h: 28.1836 };
const CHEVRON_SEMIBOLD = { d: 'M22.1604 27.3589C23.0746 27.3527 23.8441 26.9932 24.5391 26.2716L43.4553 6.70364C44.0252 6.14001 44.3145 5.45388 44.3145 4.63994C44.3145 2.98722 43.0027 1.67536 41.3615 1.67536C40.568 1.67536 39.8055 1.98867 39.2108 2.58246L21.0808 21.413L23.2781 21.413L5.0966 2.58246C4.51524 2.00109 3.76611 1.67536 2.95306 1.67536C1.30565 1.67536 0 2.98722 0 4.63994C0 5.44767 0.308905 6.1338 0.853002 6.71696L19.7816 26.2849C20.5094 26.9994 21.2586 27.3589 22.1604 27.3589Z', w: 44.6856, h: 27.3589 };

/**
 * paintInnerSpinButtonForVectorBasedControls: inside the content box's right end a 13:16 box fitted to it (radius 25 % of its height) in quinary-label, a 1 px divider of
 * quaternary-label (width by control size), and an up and a down chevron in label colour.
 * @param {{x: number, y: number, w: number, h: number}} content the content box in border-box coordinates @param {boolean} disabled @param {Palette} p @returns {string}
 */
export function spinGlyph(content, disabled, p) {
  const ratio = Math.min(content.w / 13, content.h / 16), bw = 13 * ratio, bh = 16 * ratio;
  const x = content.x + content.w - bw, y = content.y + content.h / 2 - bh / 2;
  const size = bh < 16 ? 0 : bh < 20 ? 1 : bh < 24 ? 2 : bh < 28 ? 3 : bh < 36 ? 4 : 5;
  const divider = [9 / 13, 9 / 13, 11 / 17, 14 / 20, 15 / 23, 20 / 30][size] * bw;
  const chevron = size <= 2 ? CHEVRON_BOLD : CHEVRON_SEMIBOLD;
  const k = ([30 / 52, 30 / 52, 36 / 68, 46 / 80, 36 / 73, 27 / 72][size] * bw) / chevron.w;
  const a = disabled ? DISABLED_ALPHA : 1;
  const cx = x + bw / 2, cw = chevron.w * k, ch = chevron.h * k;
  const down = `<path transform="translate(${n(cx - cw / 2)} ${n(y + (bh * 3) / 4 - ch / 2)}) scale(${n(k)})" d="${chevron.d}" fill="${css(alpha(p.label, a))}"/>`;
  const up = `<path transform="translate(${n(cx - cw / 2)} ${n(y + bh / 4 + ch / 2)}) scale(${n(k)} ${n(-k)})" d="${chevron.d}" fill="${css(alpha(p.label, a))}"/>`;
  return rect(x, y, bw, bh, bh / 4, alpha(p.quinaryLabel, a)) + rect(cx - divider / 2, y + bh / 2 - 0.5, divider, 1, 0.5, alpha(p.quaternaryLabel, a)) + down + up;
}

/**
 * paintColorWellForVectorBasedControls + its swatch: the box as a pill in quinary-label (half alpha when disabled), the swatch (the inner box) as a pill of the value with a 0.5 px
 * black 10 % inner stroke.
 * @param {number} w @param {number} h @param {{inset: {x: number, y: number, w: number, h: number}, value: Rgba, disabled: boolean}} s @param {Palette} p @returns {string}
 */
export function colorWellSkin(w, h, s, p) {
  const a = s.disabled ? 0.5 : 1, i = s.inset, r = Math.min(i.w, i.h) / 2;
  return svgDoc(w, h, rect(0, 0, w, h, Math.min(w, h) / 2, alpha(p.quinaryLabel, a)) + rect(i.x, i.y, i.w, i.h, r, alpha(s.value, a))
    + rect(i.x + 0.25, i.y + 0.25, i.w - 0.5, i.h - 0.5, Math.max(0, r - 0.25), [0, 0, 0, 0], ` fill-opacity="0" stroke="${css([0, 0, 0, 0.1 * a])}" stroke-width="0.5"`));
}

/**
 * paintPlatformResizerForVectorBasedControls: two rounded bars (0.75 and 0.375 of the corner, 7.5 % thick) rotated -45 degrees in secondary-label, in the bottom-right `size` square.
 * @param {number} w @param {number} h @param {number} size @param {Palette} p @returns {string}
 */
export function resizerGlyph(w, h, size, p) {
  const x = w - size, y = h - size, t = size * 0.075, wide = size * 0.75, small = wide / 2;
  const wy = y + size / 2 - t, sy = wy + 2.5 * t;
  return `<g transform="rotate(-45 ${n(x + size / 2)} ${n(y + size / 2)})">${rect(x + (size - wide) / 2, wy, wide, t, t / 2, p.secondaryLabel)}${rect(x + (size - small) / 2, sy, small, t, t / 2, p.secondaryLabel)}</g>`;
}

const CANCEL = 'M19.9219 9.96094C19.9219 15.4004 15.4102 19.9219 9.96094 19.9219C4.52148 19.9219 0 15.4004 0 9.96094C0 4.51172 4.51172 0 9.95117 0C15.4004 0 19.9219 4.51172 19.9219 9.96094ZM12.7051 6.11328L9.96094 8.83789L7.23633 6.12305C7.08008 5.97656 6.9043 5.89844 6.67969 5.89844C6.23047 5.89844 5.87891 6.24023 5.87891 6.69922C5.87891 6.91406 5.95703 7.10938 6.11328 7.26562L8.81836 9.9707L6.11328 12.6855C5.95703 12.832 5.87891 13.0371 5.87891 13.252C5.87891 13.7012 6.23047 14.0625 6.67969 14.0625C6.9043 14.0625 7.10938 13.9844 7.26562 13.8281L9.96094 11.1133L12.666 13.8281C12.8125 13.9844 13.0176 14.0625 13.2422 14.0625C13.7012 14.0625 14.0625 13.7012 14.0625 13.252C14.0625 13.0273 13.9844 12.8223 13.8184 12.6758L11.1133 9.9707L13.8281 7.25586C14.0039 7.08008 14.0723 6.9043 14.0723 6.67969C14.0723 6.23047 13.7109 5.87891 13.2617 5.87891C13.0469 5.87891 12.8711 5.94727 12.7051 6.11328Z';

/**
 * paintSearchFieldCancelButtonForVectorBasedControls: the circled x, 1 em square, light #4c4c4c at 85 %, dark #a1a1a1, half alpha when disabled.
 * @param {{x: number, y: number, size: number}} box @param {boolean} dark @param {boolean} disabled @returns {string}
 */
export function cancelGlyph(box, dark, disabled) {
  const k = box.size / 20.2832;
  const color = alpha(dark ? [161, 161, 161, 1] : [76, 76, 76, 216 / 255], disabled ? 0.5 : 1);
  return `<path fill-rule="evenodd" transform="translate(${n(box.x + box.size / 2 - (20.2832 * k) / 2)} ${n(box.y + box.size / 2 - (19.9316 * k) / 2)}) scale(${n(k)})" d="${CANCEL}" fill="${css(color)}"/>`;
}

const MAGNIFIER = 'M29.6875 59.375C35.9863 59.375 41.7969 57.422 46.6309 54.0528L63.9649 71.3868C64.8926 72.3145 66.1133 72.754 67.3829 72.754C70.1172 72.754 72.1191 70.6544 72.1191 67.9688C72.1191 66.6993 71.6797 65.4786 70.7519 64.5508L53.5644 47.3145C57.2266 42.3829 59.375 36.2793 59.375 29.6875C59.375 13.3301 46.045 0 29.6875 0C13.3301 0 0 13.3301 0 29.6875C0 46.045 13.33 59.375 29.6875 59.375ZM29.6875 52.0997C17.4316 52.0997 7.2754 41.9434 7.2754 29.6875C7.2754 17.3829 17.4316 7.2754 29.6875 7.2754C41.9922 7.2754 52.1 17.3829 52.1 29.6875C52.1 41.9435 41.9922 52.0997 29.6875 52.0997Z';

/**
 * paintSearchFieldForVectorBasedControls (macOS): a capsule when it fits (inline length >= 3 x radius and the 1.91 em text gap >= radius), else radius 15 % of the smaller side;
 * a 1 px rim of quinary-label (none in dark mode) around the background colour; disabled at half alpha. `magnifier`: the decoration part (Safari 27) as a 1 em glyph at `x`,
 * #4c4c4c (dark: white), half alpha when disabled.
 * @param {number} w @param {number} h @param {{bg: Rgba, disabled: boolean, em: number, dark: boolean, magnifier?: {x: number, y: number}}} s @param {Palette} p @param {string} [extra]
 * @returns {string}
 */
export function searchSkin(w, h, s, p, extra = '') {
  const capsule = w >= (h / 2) * 3 && 1.91 * s.em >= h / 2;
  const r = capsule ? h / 2 : Math.min(w, h) * 0.15;
  const k = s.disabled ? 0.5 : 1;
  let body = (s.dark ? '' : rect(0, 0, w, h, r, alpha(p.quinaryLabel, k))) + rect(1, 1, w - 2, h - 2, Math.max(0, r - 1), alpha(s.bg, k));
  if (s.magnifier) {
    const sc = s.em / 73;
    body += `<path transform="translate(${n(s.magnifier.x + s.em / 2 - (73 * sc) / 2)} ${n(s.magnifier.y)}) scale(${n(sc)})" d="${MAGNIFIER}" fill="${css(alpha(s.dark ? [255, 255, 255, 1] : [76, 76, 76, 1], k))}"/>`;
  }
  return svgDoc(w, h, body + extra);
}
