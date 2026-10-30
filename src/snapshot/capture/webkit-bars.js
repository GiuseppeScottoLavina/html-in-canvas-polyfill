/**
 * WebKit (Safari) classic scrollbars of a clone scroller, measured on Safari 27 (engines bundle, src/engines.js).
 * Module: snapshot-capture (src/snapshot/capture/*).
 */

import { appendInlineStyle, setInlineStyle } from './inline-style.js';
import { darkSchemeOf } from './color-scheme.js';
import { WEBKIT_SYSTEM_INSET, WEBKIT_SYSTEM_MIN, webkitSystemKnob } from './webkit-bar-geometry.js';

/** @typedef {import('./scroll-emulation.js').ScrollFacts} ScrollFacts */

const NS_X = 'http://www.w3.org/1999/xhtml';

/** @param {string} v @returns {number} */
const px = (v) => parseFloat(v) || 0;

/**
 * WebKit draws an unstyled classic bar in its dark look when the scroller uses the dark appearance (its used color-scheme, `<meta name=color-scheme>` included); a dark page
 * background alone keeps the light look (measured Safari 27: on the dark F2 page the knob is black 52 %, in a color-scheme:dark scroller white 57 %).
 * @param {Window} win @param {Element} src @returns {boolean}
 */
export function webkitDarkBars(win, src) {
  return darkSchemeOf(win, src);
}

/**
 * PURE. Geometry of a WebKit (macOS, non-overlay) system bar in a gutter of `gutter` css px along a track of `len` px (measured Safari 27.0.1: a 17 px gutter shows an
 * 11 px lane 3 px from each side, inset 3 px at both ends; a 13 px thin one a 7 px lane; the knob is a pill of the lane's thickness placed by AppKit on whole css px,
 * webkitSystemKnob). knobLength 0: no knob.
 * @param {number} gutter @param {number} len @param {number} client @param {number} scrollSize @param {number} offset
 * @returns {{laneStart: number, laneLength: number, across: number, thickness: number, knobStart: number, knobLength: number}}
 */
export function webkitBarGeometry(gutter, len, client, scrollSize, offset) {
  const laneStart = WEBKIT_SYSTEM_INSET, laneLength = Math.max(0, len - 2 * WEBKIT_SYSTEM_INSET);
  // a gutter of another width was not measured: the regular bar's minimum
  const k = webkitSystemKnob(laneLength, client, scrollSize, offset, WEBKIT_SYSTEM_MIN[gutter] ?? WEBKIT_SYSTEM_MIN[17]);
  return { laneStart, laneLength, across: WEBKIT_SYSTEM_INSET, thickness: Math.max(0, gutter - 2 * WEBKIT_SYSTEM_INSET), knobStart: laneStart + (k?.start ?? 0), knobLength: k?.length ?? 0 };
}

/** @param {number} x @param {number} y @param {number} w @param {number} h @param {string} fill */
const pill = (x, y, w, h, fill) => `<rect x="${+x.toFixed(3)}" y="${+y.toFixed(3)}" width="${+w.toFixed(3)}" height="${+h.toFixed(3)}" rx="${+(Math.min(w, h) / 2).toFixed(3)}" fill="${fill}"/>`;

/**
 * WebKit's unstyled classic bars (lane + knob, webkitBarColors): the lanes and the horizontal knob as an extra background layer of the clone scroller over its border box,
 * the vertical knob as a box of its own (`data-hic-bar="thumb"`: the scroll compositor captures the bar without it and the knob alone, and moves the knob by
 * webkitSystemKnob). The box lies in the gutter the clone keeps as padding, so the scroller's own clip (rounded corners included) applies to it as to the lane.
 * @param {Window} win @param {Element} src @param {HTMLElement} clone @param {ScrollFacts} f @param {boolean} dark
 * @param {boolean} [scrolled]  the clone scroller itself shows the scroll offset; false when its children were translated instead (the knob box sits at the box origin)
 */
export function paintWebkitBars(win, src, clone, f, dark, scrolled = true) {
  const cs = win.getComputedStyle(src);
  const c = webkitBarColors(dark);
  const bl = px(cs.borderLeftWidth), bt = px(cs.borderTopWidth);
  const W = /** @type {HTMLElement} */ (src).offsetWidth, H = /** @type {HTMLElement} */ (src).offsetHeight;
  let body = '';
  if (f.scrollableY && f.gv) {
    const g = webkitBarGeometry(f.gv, src.clientHeight, src.clientHeight, src.scrollHeight, f.sT);
    const x = bl + (f.cw ?? src.clientWidth) + g.across;
    body += pill(x, bt + g.laneStart, g.thickness, g.laneLength, c.lane);
    if (g.knobLength > 0) {
      const w = g.thickness, h = g.knobLength;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${pill(0, 0, w, h, c.knob)}</svg>`;
      const knob = clone.ownerDocument.createElementNS(NS_X, 'div');
      setInlineStyle(knob, `position:absolute;z-index:60;pointer-events:none;left:${(f.cw ?? src.clientWidth) + (scrolled ? f.sL : 0) + g.across}px;top:${(scrolled ? f.sT : 0) + g.knobStart}px;width:${w}px;height:${h}px;background:${svgUrl(svg)} 0 0/100% 100% no-repeat;`);
      clone.appendChild(knob).setAttribute('data-hic-bar', 'thumb');
    }
  }
  if (f.scrollableX && f.gh) {
    const g = webkitBarGeometry(f.gh, src.clientWidth, src.clientWidth, src.scrollWidth, f.sL);
    const y = bt + (f.ch ?? src.clientHeight) + g.across;
    body += pill(bl + g.laneStart, y, g.laneLength, g.thickness, c.lane) + (g.knobLength > 0 ? pill(bl + g.knobStart, y, g.knobLength, g.thickness, c.knob) : '');
  }
  if (!body || !(W > 0 && H > 0)) return;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${body}</svg>`;
  const url = svgUrl(svg);
  const list = (/** @type {string} */ own, /** @type {string} */ v) => `${own}, ${v}`;
  appendInlineStyle(clone, `background-image:${list(url, cs.backgroundImage)}!important;background-size:${list(`${W}px ${H}px`, cs.backgroundSize)}!important;`
    + `background-position:${list('0 0', cs.backgroundPosition)}!important;background-repeat:${list('no-repeat', cs.backgroundRepeat)}!important;`
    + `background-origin:${list('border-box', cs.backgroundOrigin)}!important;background-clip:${list('border-box', cs.backgroundClip)}!important;`
    + `background-attachment:${list('scroll', cs.backgroundAttachment)}!important;background-color:${cs.backgroundColor}!important;`);
}

/** @param {string} svg @returns {string} a CSS url() of the SVG document */
const svgUrl = (svg) => `url("data:image/svg+xml,${encodeURIComponent(svg).replace(/\(/g, '%28').replace(/\)/g, '%29')}")`;

/** PURE. Measured Safari 27 (macOS 27, classic bars): light lane black 4.7 %, knob black 52 %; dark lane white 4.9 %, knob white 57 %. @param {boolean} dark @returns {{lane: string, knob: string}} */
export const webkitBarColors = (dark) => (dark ? { lane: 'rgba(255,255,255,0.049)', knob: 'rgba(255,255,255,0.573)' } : { lane: 'rgba(0,0,0,0.047)', knob: 'rgba(0,0,0,0.522)' });
