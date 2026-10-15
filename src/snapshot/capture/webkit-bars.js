/**
 * WebKit (Safari) classic scrollbars of a clone scroller, measured on Safari 27 (engines bundle, src/engines.js).
 * Module: snapshot-capture (src/snapshot/capture/*).
 */

import { appendInlineStyle } from './inline-style.js';

/** @typedef {import('./scroll-emulation.js').ScrollFacts} ScrollFacts */

/** @param {string} v @returns {number} */
const px = (v) => parseFloat(v) || 0;

/**
 * WebKit draws an unstyled classic bar in its dark look when the scroller uses the dark appearance (its used color-scheme, `<meta name=color-scheme>` included); a dark page
 * background alone keeps the light look (measured Safari 27: on the dark F2 page the knob is black 52 %, in a color-scheme:dark scroller white 57 %).
 * @param {Window} win @param {Element} src @returns {boolean}
 */
export function webkitDarkBars(win, src) {
  let scheme = win.getComputedStyle(src).colorScheme;
  if (!scheme || scheme === 'normal') scheme = src.ownerDocument.querySelector('meta[name="color-scheme" i]')?.getAttribute('content') ?? '';
  return /\bdark\b/.test(scheme) && (!/\blight\b/.test(scheme) || win.matchMedia('(prefers-color-scheme: dark)').matches);
}

/**
 * PURE. Geometry of a WebKit (macOS, non-overlay) scroller bar in a gutter of `gutter` css px along a track of `len` px (measured Safari 27: a 17 px gutter shows an 11 px
 * lane 3 px from each side, inset 3 px at both ends; the knob is a pill of at least 18 px).
 * @param {number} gutter @param {number} len @param {number} client @param {number} scrollSize @param {number} offset
 * @returns {{laneStart: number, laneLength: number, across: number, thickness: number, knobStart: number, knobLength: number}}
 */
export function webkitBarGeometry(gutter, len, client, scrollSize, offset) {
  const laneStart = 3, laneLength = Math.max(0, len - 6);
  const knobLength = Math.min(laneLength, Math.max(18, laneLength * (client / scrollSize)));
  const max = scrollSize - client;
  const knobStart = laneStart + (max > 0 ? Math.min(1, Math.max(0, offset / max)) : 0) * (laneLength - knobLength);
  return { laneStart, laneLength, across: 3, thickness: Math.max(0, gutter - 6), knobStart, knobLength };
}

/** @param {number} x @param {number} y @param {number} w @param {number} h @param {string} fill */
const pill = (x, y, w, h, fill) => `<rect x="${+x.toFixed(3)}" y="${+y.toFixed(3)}" width="${+w.toFixed(3)}" height="${+h.toFixed(3)}" rx="${+(Math.min(w, h) / 2).toFixed(3)}" fill="${fill}"/>`;

/**
 * WebKit's unstyled classic bars (lane + knob, webkitBarColors) as an extra background layer of the clone scroller over its border box. Not as positioned boxes: an
 * overflow:auto box in a WebKit SVG image clips its positioned descendants to a scrollport that still excludes the (hidden) bar gutter, so boxes in the gutter vanished (measured).
 * @param {Window} win @param {Element} src @param {HTMLElement} clone @param {ScrollFacts} f @param {boolean} dark
 */
export function paintWebkitBars(win, src, clone, f, dark) {
  const cs = win.getComputedStyle(src);
  const c = webkitBarColors(dark);
  const bl = px(cs.borderLeftWidth), bt = px(cs.borderTopWidth);
  const W = /** @type {HTMLElement} */ (src).offsetWidth, H = /** @type {HTMLElement} */ (src).offsetHeight;
  let body = '';
  if (f.scrollableY && f.gv) {
    const g = webkitBarGeometry(f.gv, src.clientHeight, src.clientHeight, src.scrollHeight, f.sT);
    const x = bl + (f.cw ?? src.clientWidth) + g.across;
    body += pill(x, bt + g.laneStart, g.thickness, g.laneLength, c.lane) + pill(x, bt + g.knobStart, g.thickness, g.knobLength, c.knob);
  }
  if (f.scrollableX && f.gh) {
    const g = webkitBarGeometry(f.gh, src.clientWidth, src.clientWidth, src.scrollWidth, f.sL);
    const y = bt + (f.ch ?? src.clientHeight) + g.across;
    body += pill(bl + g.laneStart, y, g.laneLength, g.thickness, c.lane) + pill(bl + g.knobStart, y, g.knobLength, g.thickness, c.knob);
  }
  if (!body || !(W > 0 && H > 0)) return;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${body}</svg>`;
  const url = `url("data:image/svg+xml,${encodeURIComponent(svg).replace(/\(/g, '%28').replace(/\)/g, '%29')}")`;
  const list = (/** @type {string} */ own, /** @type {string} */ v) => `${own}, ${v}`;
  appendInlineStyle(clone, `background-image:${list(url, cs.backgroundImage)}!important;background-size:${list(`${W}px ${H}px`, cs.backgroundSize)}!important;`
    + `background-position:${list('0 0', cs.backgroundPosition)}!important;background-repeat:${list('no-repeat', cs.backgroundRepeat)}!important;`
    + `background-origin:${list('border-box', cs.backgroundOrigin)}!important;background-clip:${list('border-box', cs.backgroundClip)}!important;`
    + `background-attachment:${list('scroll', cs.backgroundAttachment)}!important;background-color:${cs.backgroundColor}!important;`);
}

/** PURE. Measured Safari 27 (macOS 27, classic bars): light lane black 4.7 %, knob black 52 %; dark lane white 4.9 %, knob white 57 %. @param {boolean} dark @returns {{lane: string, knob: string}} */
export const webkitBarColors = (dark) => (dark ? { lane: 'rgba(255,255,255,0.049)', knob: 'rgba(255,255,255,0.573)' } : { lane: 'rgba(0,0,0,0.047)', knob: 'rgba(0,0,0,0.522)' });
