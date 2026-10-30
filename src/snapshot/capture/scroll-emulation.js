/**
 * Scroll offsets and classic scrollbars of the scrollers in the clone.
 * Module: snapshot-capture (src/snapshot/capture/*).
 *
 * The clone scrolls FOR REAL: a viewport-sized invisible marker at (scrollLeft, scrollTop) carries `scroll-initial-target: nearest`, so the engine itself
 * scrolls the clone scroller at first layout (sticky headers, fractional offsets and everything else exact, 0.01-0.7 % in the pixel oracle). Native bars are hidden in the
 * clone; when the live scroller has a classic gutter the gutter is reproduced as padding and the track/thumb/corner are painted as boxes.
 */

import { appendInlineStyle, setInlineStyle } from './inline-style.js';
import { currentEngine, currentMacPlatform } from '../../util/engine.js';
import { boxScale } from '../../util/box-scale.js';
import { engineSkins } from './engine-skins.js';
import { inlineCssUrls } from './inline-resources.js';
import { barColors, barParts, barThemeOf, cornerSvg, hasArrowGlyphs, svgUrl, trackSvg } from './chromium-bars.js';
import { darkSchemeOf } from './color-scheme.js';
import { backdropOf, parseColor } from './caret-overlay.js';
import { webkitThumb } from './webkit-bar-geometry.js';

/** @typedef {import('../../contracts/types.js').CaptureRequest} CaptureRequest */
/** @typedef {import('../../contracts/types.js').HicEnv} HicEnv */

/**
 * Resources the bars of one scroller referenced: background images of author-styled parts (::-webkit-scrollbar-thumb / -track) still loading (`pending`: the capture is
 * incomplete and is rebuilt when they arrive) or refused (`failed`: cross-origin without CORS, left out of the picture like every other such image).
 * @typedef {{pending: boolean, failed: Array<{url: string, error: import('../../contracts/errors.js').HicUnsupportedError}>}} BarResources
 */

/**
 * Per-capture output of the scroll emulation: marker rules go into one <style> next to the shaken sheet.
 * @typedef {Object} ScrollSink
 * @property {string[]} rules
 * @property {number} nextId
 */

/**
 * @typedef {Object} ScrollFacts
 * @property {number} sT
 * @property {number} sL
 * @property {number} gv  live width of the vertical bar gutter (0 for overlay bars), css px, fractional at a fractional DPR (exactGutter)
 * @property {number} gh  live height of the horizontal bar gutter
 * @property {number} [cw]  width of the scrollport beside the vertical gutter (clientWidth without its rounding), css px
 * @property {number} [ch]  height of the scrollport above the horizontal gutter
 * @property {boolean} scrollableY
 * @property {boolean} scrollableX
 * @property {boolean} styled  author styled bars (::-webkit-scrollbar)
 */

const NS_X = 'http://www.w3.org/1999/xhtml';
const ABS = 'position:absolute;z-index:60;pointer-events:none;';

/** @param {string} v @returns {number} */
const px = (v) => parseFloat(v) || 0;

/** @type {boolean|null} */
let initialTargetSupported = null;

/** @type {boolean|null} */
let snapSupported = null;

/** @returns {boolean} the engine honours `scroll-initial-target` (Chrome >= 133) */
function supportsInitialTarget() {
  initialTargetSupported ??= typeof CSS !== 'undefined' && CSS.supports('scroll-initial-target', 'nearest');
  return initialTargetSupported;
}

/**
 * Engines without scroll-initial-target (Firefox 155, Safari 27) re-snap a scroll container after layout, also inside an SVG image: a mandatory snap type with ONE
 * snap area at (scrollLeft, scrollTop) opens the clone scrolled there, sticky descendants pinned (G-xbrowser probe). Children are translated only without either.
 * @returns {boolean}
 */
function supportsSnap() {
  snapSupported ??= typeof CSS !== 'undefined' && CSS.supports('scroll-snap-type', 'both mandatory') && CSS.supports('scroll-snap-align', 'start');
  return snapSupported;
}

/** @typedef {import('./chromium-bars.js').BarLook} BarLook */

/**
 * Live scroll state of one element, or null when it neither scrolls nor has a scrollbar gutter.
 * @param {Element} src
 * @param {CSSStyleDeclaration} cs
 * @returns {ScrollFacts|null}
 */
export function scrollFacts(src, cs) {
  const sT = src.scrollTop;
  const sL = src.scrollLeft;
  const html = /** @type {HTMLElement} */ (src);
  const bx = px(cs.borderLeftWidth) + px(cs.borderRightWidth), by = px(cs.borderTopWidth) + px(cs.borderBottomWidth);
  // an inline box has no client box (clientWidth / clientHeight 0): no gutter
  const boxed = src.clientWidth > 0 || src.clientHeight > 0;
  const rv = boxed ? Math.max(0, html.offsetWidth - src.clientWidth - bx) || 0 : 0;
  const rh = boxed ? Math.max(0, html.offsetHeight - src.clientHeight - by) || 0 : 0;
  const scrollableY = cs.overflowY !== 'visible' && src.scrollHeight > src.clientHeight;
  const scrollableX = cs.overflowX !== 'visible' && src.scrollWidth > src.clientWidth;
  // a gutter alone counts (overflow: scroll, a listbox select, scrollbar-gutter: stable): the clone has no bars, so it must keep the gutter to lay out as the page does.
  // Not for an <input>: it never shows a bar, and Gecko reports a focused field's client box narrower than its padding box (the clone came out 10 px narrower)
  const gutterOnly = src.localName !== 'input' && (rv || rh);
  if (!sT && !sL && !(scrollableY && rv) && !(scrollableX && rh) && !gutterOnly) return null;
  const bar = cs.getPropertyValue('width') ? (src.ownerDocument.defaultView ?? window).getComputedStyle(src, '::-webkit-scrollbar') : null;
  const styled = !!bar?.width && bar.width !== 'auto' && bar.width !== '0px' && cs.scrollbarWidth === 'auto';
  const gv = rv && exactGutter(src, cs, rv, styled ? px(bar.width) : null, 'v');
  const gh = rh && exactGutter(src, cs, rh, styled ? px(bar.height) : null, 'h');
  // the scrollport beside the exact gutter (clientWidth rounds it); clientWidth itself when the computed size does not describe the box
  const bb = borderBoxOf(cs, html);
  const near = (/** @type {number} */ v, /** @type {number} */ live) => (Math.abs(v - live) < 1 ? v : live);
  return { sT, sL, gv, gh, cw: near(bb.width - bx - gv, src.clientWidth), ch: near(bb.height - by - gh, src.clientHeight), scrollableY, scrollableX, styled };
}

/**
 * Does `src` reserve a classic bar gutter (overflow: scroll, a listbox, scrollbar-gutter: stable) although it may not scroll? Cheap: two layout reads.
 * @param {Element} src @param {CSSStyleDeclaration} cs @returns {boolean}
 */
export function hasBarGutter(src, cs) {
  const h = /** @type {HTMLElement} */ (src);
  if (src.localName === 'input' || !(src.clientWidth > 0 || src.clientHeight > 0)) return false;
  return h.offsetWidth - src.clientWidth - px(cs.borderLeftWidth) - px(cs.borderRightWidth) > 0.5 || h.offsetHeight - src.clientHeight - px(cs.borderTopWidth) - px(cs.borderBottomWidth) > 0.5;
}

/** Visual thickness (css px of the root) of the classic bars of an unstyled probe, per devicePixelRatio and scrollbar-width. @type {Map<string, {v: number, h: number}>} */
const barProbes = new Map();

/**
 * The platform's classic bar thickness, measured on a hidden unstyled scroller (cached; `fresh` measures again, after the system switched between overlay and classic bars).
 * @param {Document} doc @param {string} sw computed scrollbar-width @param {boolean} fresh @returns {{v: number, h: number}}
 */
function probeBars(doc, sw, fresh) {
  const key = `${doc.defaultView?.devicePixelRatio}|${sw}`;
  let out = fresh ? undefined : barProbes.get(key);
  if (out) return out;
  const probe = doc.createElement('div');
  probe.style.cssText = `all:initial;display:block;position:fixed;left:0;top:0;width:100px;height:100px;overflow:scroll;scrollbar-width:${sw};contain:strict;visibility:hidden;pointer-events:none`;
  const inner = probe.appendChild(doc.createElement('div'));
  inner.style.cssText = 'all:initial;display:block;height:100%';
  doc.documentElement.appendChild(probe);
  const o = probe.getBoundingClientRect(), i = inner.getBoundingClientRect();
  probe.remove();
  out = { v: o.width - i.width, h: o.height - i.height };
  barProbes.set(key, out);
  return out;
}

/**
 * How Chromium paints the classic bars of `src` (chromium-bars.js), or null: another engine, author-styled bars (::-webkit-scrollbar), no bars, or overlay bars.
 * @param {Window} win @param {Element} src @param {CSSStyleDeclaration} cs @param {boolean} styled @returns {BarLook|null}
 */
export function chromiumBarLook(win, src, cs, styled) {
  if (styled || currentEngine().engine !== 'chromium' || cs.scrollbarWidth === 'none') return null;
  const doc = src.ownerDocument, dpr = win.devicePixelRatio || 1;
  const auto = probeBars(doc, 'auto', false).v, thin = probeBars(doc, 'thin', false).v;
  if (!(auto > 0)) return null;
  const { theme, k } = barThemeOf(Math.round(auto * dpr), Math.round(thin * dpr), dpr, currentMacPlatform());
  return { theme, k, dpr, thin: cs.scrollbarWidth === 'thin', dark: darkSchemeOf(win, src), authored: parseScrollbarColor(cs.scrollbarColor), glyphs: theme === 'fluent' && hasArrowGlyphs(doc) };
}

/**
 * Pin the live border box on the clone of a control whose INTRINSIC size includes the scrollbar thickness (an unsized <textarea>, a listbox <select>): Chrome adds the
 * bar thickness to their intrinsic width (and a horizontal bar's to the height) whether or not a bar shows, the thickness of OVERLAY bars included (macOS: 16 px), and
 * author-styled (::-webkit-scrollbar) bars too; the clone has no bars (`scrollbar-width: none`, ::-webkit-scrollbar rules dropped), so the drawn control came out a bar
 * narrower than the live one and the controls after it reflowed (drawn away from where they are hit; Chrome 155: 29-32 of the 62 F6 regions with classic bars on Linux
 * and macOS, 16 with macOS overlay bars). The live box is the truth for every engine and bar kind.
 * @param {Element} src @param {Element} clone
 */
export function pinBarBox(src, clone) {
  const win = src.ownerDocument.defaultView ?? window;
  const cs = win.getComputedStyle(src);
  if (cs.display === 'none') return;
  const decl = barBoxPin(borderBoxOf(cs, /** @type {HTMLElement} */ (src)));
  if (decl) appendInlineStyle(clone, decl);
}

/**
 * PURE. The declarations of pinBarBox: the measured border box, '' without a box.
 * @param {{width: number, height: number}} bb @returns {string}
 */
export function barBoxPin(bb) {
  if (!(bb.width > 0 && bb.height > 0)) return '';
  return `box-sizing:border-box!important;width:${bb.width}px!important;height:${bb.height}px!important;min-width:0!important;min-height:0!important;max-width:none!important;max-height:none!important;`;
}

/**
 * The exact width of a classic bar gutter, css px of `src`. A classic bar is a whole number of DEVICE pixels (Chrome: 15 px at DPR 1 is floor(15 x 1.25) = 18 device px
 * = 14.4 px at DPR 1.25), but offsetWidth - clientWidth (`rounded`) rounds it to a whole css px: the clone's scrollport came out up to half a pixel wider, so a fractional
 * layout inside it (five 1fr grid columns) landed one device pixel away from the page's. Unstyled bars are measured on a probe; author-styled bars (::-webkit-scrollbar,
 * Chromium only) are floor(width x DPR) device px (measured Chrome 155, DPR 1 to 2). `rounded` is kept when the exact value does not agree with it within 1 px.
 * @param {Element} src @param {CSSStyleDeclaration} cs @param {number} rounded @param {number|null} styled author bar thickness, null when unstyled @param {'v'|'h'} axis
 * @returns {number}
 */
function exactGutter(src, cs, rounded, styled, axis) {
  const doc = src.ownerDocument, dpr = doc.defaultView?.devicePixelRatio || 1, zoom = /** @type {any} */ (src).currentCSSZoom ?? 1;
  const near = (/** @type {number} */ v) => Math.abs(v - rounded) < 1;
  if (styled !== null) { const v = Math.floor(styled * dpr + 1e-3) / dpr; return zoom === 1 && currentEngine().engine === 'chromium' && near(v) ? v : rounded; }
  for (const fresh of [false, true]) { const v = probeBars(doc, cs.scrollbarWidth || 'auto', fresh)[axis] / zoom; if (near(v)) return v; }
  return rounded;
}

/**
 * PURE. The two colours of a computed `scrollbar-color` value (`<thumb> <track>`; the computed form is `rgb(...) rgb(...)`), null for `auto`.
 * @param {string} value
 * @returns {{thumb: string, track: string}|null}
 */
export function parseScrollbarColor(value) {
  const parts = [];
  let depth = 0;
  let start = 0;
  const v = value.trim();
  for (let i = 0; i <= v.length; i++) {
    const c = v[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if ((c === undefined || (c === ' ' && depth === 0)) && i > start) { parts.push(v.slice(start, i)); start = i + 1; } else if (c === ' ' && depth === 0) start = i + 1;
  }
  return parts.length === 2 ? { thumb: parts[0], track: parts[1] } : null;
}

/** @param {CSSStyleDeclaration} cs @param {HTMLElement} [el] @returns {{width: number, height: number}} used border-box size from the computed style */
function borderBoxOf(cs, el) {
  const w = px(cs.width);
  const h = px(cs.height);
  const box = cs.boxSizing === 'border-box' ? { width: w, height: h } : {
    width: w + px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth),
    height: h + px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth),
  };
  // WebKit's computed width/height of a scroller EXCLUDES its classic bar gutter (measured Safari 27: width:120px with a 17 px bar computes 103px), so the clone came out
  // a gutter too narrow and its bars were cut off; the layout box (offsetWidth/offsetHeight, whole px) is the truth when the two disagree by more than rounding
  if (el) {
    if (Math.abs(box.width - el.offsetWidth) >= 1) box.width = el.offsetWidth;
    if (Math.abs(box.height - el.offsetHeight) >= 1) box.height = el.offsetHeight;
  }
  return box;
}

/**
 * Make the clone scroller show the live scroll position and bars. `sink` receives the marker rule (pseudo-element marker, no extra child that could break `:last-child`).
 * Without `sink`, or when the live scroller already uses ::after, a real marker element is appended instead.
 * @param {HicEnv} env
 * @param {Element} src
 * @param {HTMLElement} cloneScroller
 * @param {CaptureRequest} req
 * @param {ScrollSink} [sink]
 * @param {ScrollFacts|null} [known]
 * @returns {BarResources}  the images of author-styled bars that are still loading or were refused
 */
export function applyScrollState(env, src, cloneScroller, req, sink, known) {
  /** @type {BarResources} */
  const res = { pending: false, failed: [] };
  const win = env.window;
  const cs = win.getComputedStyle(src);
  const f = known ?? scrollFacts(src, cs);
  if (!f) return res;
  if (src.localName === 'select') {
    if (f.sT || f.sL || f.scrollableY || f.scrollableX) listboxScroll(src, cloneScroller, cs);
    if (f.gv) chromiumListboxBar(win, src, cloneScroller, cs, f);
    return res;
  }
  let style = 'scroll-behavior:auto!important;';
  if (f.gv || f.gh) {
    const bb = borderBoxOf(cs, /** @type {HTMLElement} */ (src));
    style += `box-sizing:border-box!important;width:${bb.width}px!important;height:${bb.height}px!important;min-width:0!important;min-height:0!important;max-width:none!important;max-height:none!important;`;
    style += `padding-right:${px(cs.paddingRight) + f.gv}px!important;padding-bottom:${px(cs.paddingBottom) + f.gh}px!important;`;
  }
  if (cs.position === 'static') style += 'position:relative!important;';
  appendInlineStyle(cloneScroller, style);
  let scrolled = true;
  if (f.sT || f.sL) {
    if (supportsInitialTarget()) addMarker(win, src, cloneScroller, f, sink, false);
    else if (supportsSnap()) addMarker(win, src, cloneScroller, f, sink, true);
    else { translateChildren(cloneScroller, f); scrolled = false; }
  }
  if (f.gv || f.gh) paintClassicScrollbars(env, req, res, src, cloneScroller, scrolled);
  return res;
}

/**
 * Chromium's bar of a listbox select (the clone renders only the options: no bar boxes): the gutter becomes padding (the options end where the bar starts, as live) and
 * the whole bar (track, buttons, thumb at the scroll offset) one more background layer in it. Other engines: Gecko's skin draws its own (native-controls.js), WebKit
 * leaves the listbox to the image.
 * @param {Window} win @param {Element} src @param {HTMLElement} clone @param {CSSStyleDeclaration} cs @param {ScrollFacts} f
 */
function chromiumListboxBar(win, src, clone, cs, f) {
  const look = chromiumBarLook(win, src, cs, f.styled);
  if (!look || cs.direction === 'rtl') return;
  const d = look.dpr, ch = f.ch ?? src.clientHeight, T = Math.round(f.gv * d), L = Math.round(ch * d);
  const parts = barParts(look, { thick: T, len: L, visible: Math.round(src.clientHeight * d), total: Math.round(src.scrollHeight * d), offset: f.sT * d });
  const t = parts.thumb;
  const thumb = t ? `<rect x="${t.across}" y="${t.at}" width="${t.thick}" height="${t.len}" rx="${Math.min(t.thick, t.len) / 2}" fill="${barColors(look).thumb}"/>` : '';
  const url = svgUrl(trackSvg(look, true, T, L, parts.buttons) + thumb, f.gv, ch, d);
  const list = (/** @type {string} */ own, /** @type {string} */ v) => `${own}, ${v}`;
  appendInlineStyle(clone, `padding-right:${px(cs.paddingRight) + f.gv}px!important;background-image:${list(url, cs.backgroundImage)}!important;`
    + `background-size:${list(`${f.gv}px ${ch}px`, cs.backgroundSize)}!important;background-position:${list(`${px(cs.borderLeftWidth) + (f.cw ?? src.clientWidth)}px ${px(cs.borderTopWidth)}px`, cs.backgroundPosition)}!important;`
    + `background-repeat:${list('no-repeat', cs.backgroundRepeat)}!important;background-origin:${list('border-box', cs.backgroundOrigin)}!important;`
    + `background-clip:${list('border-box', cs.backgroundClip)}!important;background-attachment:${list('scroll', cs.backgroundAttachment)}!important;background-color:${cs.backgroundColor}!important;`);
}

/**
 * The overlay thumb of a scrollable listbox select, which an SVG image never draws:
 * - Chrome for Android keeps a thin overlay thumb on it (it does not fade; measured Chromium 158, DPR 2.625: 4 css px wide, grey 128 at 50 % alpha, flush with the inner
 *   right border, length and offset in proportion to the scrollport). It becomes a background layer of the clone (under the selected option's highlight, where the page
 *   draws it over).
 * - Chrome on macOS with overlay bars draws a listbox's thumb in a drawable whether or not it scrolled (measured on the native oracle, Chrome Canary 158, where the page
 *   fades it after a scroll; Chrome 155 keeps it in the page too, headless and headed): macOverlayThumb.
 * Skipped when the select has its own background image.
 * @param {Element} src @param {HTMLElement} clone @param {CSSStyleDeclaration} cs @param {number} top  the scroll offset drawn
 * @param {{engine: string, os: string, macOverlay?: boolean}} [info]  the engine and whether macOS overlay bars are on (tests pass them)
 */
export function listboxThumb(src, clone, cs, top, info = { ...currentEngine(), macOverlay: currentMacPlatform() && !(probeBars(src.ownerDocument, 'auto', false).v > 0) }) {
  const { engine, os } = info;
  const ch = src.clientHeight, sh = src.scrollHeight;
  if (engine !== 'chromium' || cs.backgroundImage !== 'none' || cs.overflowY === 'hidden' || !(sh > ch) || ch <= 0) return;
  if (os !== 'android') {
    if (info.macOverlay && cs.scrollbarWidth === 'auto' && cs.scrollbarColor === 'auto' && cs.direction !== 'rtl') macOverlayThumb(src, clone, top);
    return;
  }
  const g = 'rgba(128,128,128,0.5)';
  appendInlineStyle(clone, `background-image:linear-gradient(${g},${g})!important;background-size:4px ${(ch * ch) / sh}px!important;background-position:right 0 top ${(top * ch) / sh}px!important;background-repeat:no-repeat!important;background-origin:padding-box!important;`);
}

/**
 * PURE. The macOS overlay thumb of a vertical listbox bar, in device px (k per css px) from the scrollport's top right corner, as Chromium paints it unhovered
 * (measured on the native oracle at DPR 1, 1.25 and 2): the bar is round(16 k) thick; the thumb is inset round(2 k) from the right edge and round(7 k) from the bar's
 * left edge, and round(2 k) at both ends of its track slot; the slot is Blink's ThumbLength over the whole scrollport (no buttons; at least trunc(26 k)) at the truncated
 * ThumbPosition.
 * @param {number} k @param {number} ch  scrollport height, css px @param {number} sh  scroll height, css px @param {number} top  scroll offset, css px
 * @returns {{right: number, width: number, top: number, len: number}|null}
 */
export function macOverlayThumbRect(k, ch, sh, top) {
  const chD = Math.round(ch * k), shD = Math.round(sh * k), inset = Math.round(2 * k), right = inset;
  if (!(shD > chD)) return null;
  const slot = Math.min(chD, Math.max(Math.round((chD * chD) / shD), Math.trunc(26 * k)));
  const raw = (Math.max(0, top) * k * (chD - slot)) / (shD - chD);
  const at = raw > 0 && raw < 1 ? 1 : Math.trunc(raw);
  const width = Math.round(16 * k) - Math.round(7 * k) - right;
  return slot - 2 * inset > 0 ? { right, width, top: at + inset, len: slot - 2 * inset } : null;
}

/**
 * Paint the macOS overlay thumb on the clone of a listbox: a rounded bar, black at 50 % over a light background, white at 50 % over a dark one (the background's
 * lightness decides, not the colour scheme: measured), drawn OVER the options as natively, so it is a background layer of the select and of every option with a
 * background that it crosses (that background, the selected option's highlight, would cover the select's layer; a transparent option shows it).
 * @param {Element} src @param {HTMLElement} clone @param {number} top
 */
function macOverlayThumb(src, clone, top) {
  const win = src.ownerDocument.defaultView ?? window;
  const k = win.devicePixelRatio || 1;
  const t = macOverlayThumbRect(k, src.clientHeight, src.scrollHeight, top);
  if (!t) return;
  const bg = backdropOf(win, src);
  const fill = Math.max(...bg) + Math.min(...bg) > 255 ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.5)';
  const w = t.width / k, h = t.len / k, x = src.clientWidth - (t.right + t.width) / k, y = t.top / k;
  const url = svgUrl(`<rect width="${t.width}" height="${t.len}" rx="${t.width / 2}" fill="${fill}"/>`, w, h, k);
  const layer = (/** @type {Element} */ el, /** @type {number} */ lx, /** @type {number} */ ly, /** @type {string} */ origin) => appendInlineStyle(el, `background-image:${url}!important;`
    + `background-size:${w}px ${h}px!important;background-position:${lx}px ${ly}px!important;background-repeat:no-repeat!important;background-origin:${origin}!important;background-attachment:scroll!important;`);
  layer(clone, x, y, 'padding-box');
  const r = src.getBoundingClientRect();
  const scale = 1 / boxScale(src, r).y;
  const opts = clone.querySelectorAll('option'), live = /** @type {HTMLSelectElement} */ (src).options;
  for (let i = 0; i < live.length; i++) {
    const or = live[i].getBoundingClientRect();
    const ox = (or.left - r.left) * scale - src.clientLeft, oy = (or.top - r.top) * scale - src.clientTop;
    if (oy >= y + h) break;
    if (oy + or.height * scale <= y || ox + or.width * scale <= x || !opts[i]) continue;
    const ocs = win.getComputedStyle(live[i]);
    if (ocs.backgroundImage === 'none' && (parseColor(ocs.backgroundColor)?.[3] ?? 0) > 0) layer(opts[i], x - ox, y - oy, 'border-box');
  }
}

/**
 * A listbox select renders only its options (no marker box, no bar boxes), and the image document scrolls the selected option into view on its own. The live offset is set
 * with snapping instead: the clone is a mandatory snap container whose only snap area is the first option at or below the live scrollport top, `scroll-padding-top` being
 * that option's distance from it (measured in Firefox 157 and Safari 27: snapping wins over the selected-option scroll in the image).
 * @param {Element} src @param {HTMLElement} clone @param {CSSStyleDeclaration} cs
 */
function listboxScroll(src, clone, cs) {
  const r = src.getBoundingClientRect();
  const scale = 1 / boxScale(src, r, cs).y; // the layer may be scaled (transform mode)
  const dist = (/** @type {Element} */ o) => (o.getBoundingClientRect().top - r.top) * scale - px(cs.borderTopWidth); // fractional (clientTop is rounded)
  const live = Array.from(/** @type {HTMLSelectElement} */ (src).options);
  const k = live.findIndex((o) => dist(o) >= -0.5);
  const opt = k >= 0 ? clone.querySelectorAll('option')[k] : null;
  if (!opt) return;
  appendInlineStyle(clone, `scroll-behavior:auto!important;scroll-snap-type:y mandatory!important;scroll-padding:${Math.max(0, dist(live[k]))}px 0 0 0!important;`);
  appendInlineStyle(opt, 'scroll-snap-align:start!important;');
}

/**
 * The marker is the clone scroller's ::after (or, when the live scroller uses ::after, a real child). `snap`: the marker is the ONLY snap area of a mandatory snap
 * container (author snap areas, scroll-padding and scroll-margin are neutralised), else it carries scroll-initial-target.
 * @param {Window} win @param {Element} src @param {HTMLElement} clone @param {ScrollFacts} f @param {ScrollSink|undefined} sink @param {boolean} snap
 */
function addMarker(win, src, clone, f, sink, snap) {
  const box = `left:${f.sL}px;top:${f.sT}px;width:${src.clientWidth}px;height:${src.clientHeight}px;`;
  const target = snap ? 'scroll-snap-align:start start!important;scroll-margin:0!important;' : 'scroll-initial-target:nearest!important;';
  if (snap) appendInlineStyle(clone, 'scroll-snap-type:both mandatory!important;scroll-padding:0!important;');
  if (sink && win.getComputedStyle(src, '::after').content === 'none') {
    const id = String(++sink.nextId);
    clone.setAttribute('data-hic-s', id);
    sink.rules.push(`[data-hic-s="${id}"]::after{content:""!important;position:absolute!important;${box}visibility:hidden!important;pointer-events:none!important;${target}}`);
    if (snap) sink.rules.push(`[data-hic-s="${id}"] :not([data-hic-marker]){scroll-snap-align:none!important}`);
    return;
  }
  const marker = clone.ownerDocument.createElementNS(NS_X, 'div');
  marker.setAttribute('data-hic-marker', '');
  setInlineStyle(marker, `position:absolute;${box}visibility:hidden;pointer-events:none;${target}`);
  if (snap) for (const el of Array.from(clone.querySelectorAll('*'))) appendInlineStyle(el, 'scroll-snap-align:none!important');
  clone.appendChild(marker);
}

/** Engines without scroll-initial-target: shift the in-flow children (sticky headers cannot be re-pinned this way). @param {HTMLElement} clone @param {ScrollFacts} f */
function translateChildren(clone, f) {
  for (const k of Array.from(clone.children)) {
    const el = /** @type {HTMLElement} */ (k);
    if (el.style.display === 'none') continue;
    el.style.setProperty('transform', `translate(${-f.sL}px,${-f.sT}px) ${el.style.transform}`.trim());
  }
}

/** @param {Document} doc @param {HTMLElement} parent @param {string} css @param {string} [role] `track` / `thumb` (data-hic-bar: the scroll compositor captures them separately) */
function box(doc, parent, css, role) {
  const d = doc.createElementNS(NS_X, 'div');
  setInlineStyle(d, ABS + css);
  if (role) d.setAttribute('data-hic-bar', role);
  parent.appendChild(d);
}

/**
 * PURE. The vertical classic bar the clone paints (paintClassicScrollbars), in the scrollport's coordinates: the thumb's x offset and width inside the gutter, its length,
 * and its top at a scroll offset. The scroll compositor draws the thumb with the same numbers.
 * @param {number} gutter css px @param {number} clientHeight @param {number} scrollHeight @param {boolean} styled author ::-webkit-scrollbar @param {boolean} authored scrollbar-color
 * @param {number} [minThumb]  min-height of an author-styled thumb (styledMinThumb), css px; 0 = the engine default
 * @returns {{thumbX: number, thumbW: number, thumbH: number, thumbY: (top: number) => number}}
 */
export function verticalBar(gutter, clientHeight, scrollHeight, styled, authored, minThumb = 0) {
  const len = clientHeight;
  // an author-styled thumb is never shorter than its own min-height (nor longer than the track)
  const thumbH = Math.min(len, Math.max(styled ? minThumb || 20 : 30, len * (clientHeight / scrollHeight)));
  const range = scrollHeight - clientHeight;
  return {
    thumbX: styled ? 0 : authored ? 3 : 4, thumbW: styled ? gutter : gutter - (authored ? 5 : 7), thumbH,
    thumbY: (top) => (range > 0 ? (top / range) * (len - thumbH) : 0),
  };
}

/**
 * The length macOS WebKit lays an author-styled thumb of `height: auto` out at along a vertical bar, which is its minimum (RenderScrollbarPart: an `auto` thickness is the
 * native bar thickness). Measured Safari 27.0.1: a 300 px track over 31000 px of content shows a 17 px thumb (round(2.9) = 3 without the minimum).
 */
const WEBKIT_AUTO_THUMB = 17;

/**
 * PURE. The minimum length of an author-styled WebKit thumb, css px: its laid-out height, max(min-height, min(max-height, height)) with `height: auto` the native
 * thickness (WEBKIT_AUTO_THUMB). Measured Safari 27.0.1: `min-height: 60px` gives a 60 px thumb where round(visible / total x track) is 36. null for what the polyfill does
 * not resolve (a percentage, a fractional length).
 * @param {{height: string, minHeight: string, maxHeight: string}} part  computed style of ::-webkit-scrollbar-thumb
 * @returns {number|null}
 */
export function webkitStyledMinThumb(part) {
  const len = (/** @type {string} */ v, /** @type {number} */ unset) => (v === 'auto' || v === 'none' || v === '' ? unset : /^[\d.]+px$/.test(v) ? parseFloat(v) : NaN);
  const v = Math.max(len(part.minHeight, 0), Math.min(len(part.maxHeight, Infinity), len(part.height, WEBKIT_AUTO_THUMB)));
  return Number.isInteger(v) ? v : null;
}

/**
 * PURE. An author-styled vertical WebKit bar (::-webkit-scrollbar) in the numbers of verticalBar: the thumb spans the gutter; its length and its offset are whole css px
 * as WebKit computes them (webkitThumb). thumbH 0 when no thumb shows (its minimum does not fit the track).
 * @param {number} gutter css px @param {number} track  the bar's length, css px @param {number} clientHeight @param {number} scrollHeight @param {number} min  webkitStyledMinThumb
 * @returns {{thumbX: number, thumbW: number, thumbH: number, thumbY: (top: number) => number}}
 */
export function webkitStyledBar(gutter, track, clientHeight, scrollHeight, min) {
  const at = (/** @type {number} */ top) => webkitThumb(track, clientHeight, scrollHeight, top, min);
  return { thumbX: 0, thumbW: gutter, thumbH: at(0)?.length ?? 0, thumbY: (top) => at(top)?.start ?? 0 };
}

/**
 * The min-height of the author-styled thumb of `src` (`::-webkit-scrollbar-thumb { min-height }`), css px; 0 when unset.
 * @param {Window} win @param {Element} src @returns {number}
 */
export function styledMinThumb(win, src) {
  return px(win.getComputedStyle(src, '::-webkit-scrollbar-thumb').minHeight);
}

/**
 * The background image layers of an author-styled bar part as declarations, their url()s inlined as data: URLs (a cross-origin image without CORS becomes an empty image and is
 * listed in `res.failed`, like the background image of any element). '' without an image.
 * @param {Pick<CSSStyleDeclaration, 'backgroundImage'|'backgroundSize'|'backgroundPosition'|'backgroundRepeat'|'backgroundOrigin'|'backgroundClip'>} part  computed style of the pseudo-element
 * @param {string} baseUrl @param {CaptureRequest['resources']} resources @param {BarResources} res
 * @returns {string}
 */
export function barImage(part, baseUrl, resources, res) {
  const image = part.backgroundImage;
  if (!image || image === 'none') return '';
  const r = inlineCssUrls(image, baseUrl, resources);
  if (r.pending.length) res.pending = true;
  res.failed.push(...r.failed);
  return `background-image:${r.css};background-size:${part.backgroundSize};background-position:${part.backgroundPosition};background-repeat:${part.backgroundRepeat};`
    + `background-origin:${part.backgroundOrigin};background-clip:${part.backgroundClip};`;
}

/**
 * Gecko darkens unstyled classic bars over a dark background (measured on Firefox 155 macOS: track #2e2e2e with a #333 left edge, thumb #757575, same geometry).
 * @param {Window} win @param {Element} src @returns {boolean} the nearest opaque background of `src` (itself or an ancestor) has a luminance below 0.5
 */
function onDarkBackground(win, src) {
  for (let el = /** @type {Element|null} */ (src); el; el = el.parentElement) {
    const m = win.getComputedStyle(el).backgroundColor.match(/[\d.]+/g);
    if (!m || (m.length > 3 && Number(m[3]) === 0)) continue;
    return (0.2126 * Number(m[0]) + 0.7152 * Number(m[1]) + 0.0722 * Number(m[2])) / 255 < 0.5;
  }
  return false;
}

/**
 * Append approximate track/thumb overlays for a scroller whose live gutter is non-overlay (feature classic-scrollbars).
 * Colours and background images of author-styled bars come from the pseudo-element computed styles; unstyled bars use the constants read off the macOS legacy bars (measured on macOS).
 * @param {HicEnv} env
 * @param {CaptureRequest} req
 * @param {BarResources} res
 * @param {Element} src
 * @param {HTMLElement} cloneScroller
 * @param {boolean} [scrolled]  the clone scroller itself shows the scroll offset (marker); false when its children were translated instead (bars sit at the box origin)
 */
function paintClassicScrollbars(env, req, res, src, cloneScroller, scrolled = true) {
  const win = src.ownerDocument.defaultView ?? window;
  const cs = win.getComputedStyle(src);
  const f = scrollFacts(src, cs);
  if (!f || !(f.gv || f.gh)) return;
  const doc = cloneScroller.ownerDocument;
  const pseudo = (/** @type {string} */ p) => win.getComputedStyle(src, p);
  const styled = f.styled;
  const bar = pseudo('::-webkit-scrollbar');
  const tr = pseudo('::-webkit-scrollbar-track');
  const th = pseudo('::-webkit-scrollbar-thumb');
  const co = pseudo('::-webkit-scrollbar-corner');
  const authored = styled ? null : parseScrollbarColor(cs.scrollbarColor);
  const engine = currentEngine().engine;
  if (!styled && !authored && engine === 'webkit') {
    const skins = engineSkins();
    if (skins) { skins.paintWebkitBars(win, src, cloneScroller, f, skins.webkitDarkBars(win, src), scrolled); return; }
  }
  const look = chromiumBarLook(win, src, cs, styled);
  if (look) { paintChromiumBars(look, src, cloneScroller, cs, f, scrolled); return; }
  const dark = !styled && !authored && engine === 'gecko' && onDarkBackground(win, src);
  const track = authored ? `background:${authored.track};` : styled
    ? `background:${tr.backgroundColor !== 'rgba(0, 0, 0, 0)' ? tr.backgroundColor : bar.backgroundColor};${barImage(tr, env.document.baseURI, req.resources, res)}border-left:${tr.borderLeftWidth} ${tr.borderLeftStyle} ${tr.borderLeftColor};`
    : dark ? 'background:#2e2e2e;border-left:1px solid #333;box-sizing:border-box;' : 'background:#fafafa;border-left:1px solid #e8e8e8;box-sizing:border-box;';
  const thumb = authored ? `background:${authored.thumb};border-radius:99px;box-sizing:border-box;` : styled
    ? `background:${th.backgroundColor};${barImage(th, env.document.baseURI, req.resources, res)}border:${th.borderTopWidth} ${th.borderTopStyle} ${th.borderTopColor};border-radius:${th.borderTopLeftRadius};box-sizing:border-box;`
    : `background:${dark ? '#757575' : '#c1c1c1'};border-radius:4px;box-sizing:border-box;`;
  const minThumb = styled ? 20 : 30;
  const sT = scrolled ? f.sT : 0, sL = scrolled ? f.sL : 0;
  const cw = f.cw ?? src.clientWidth, ch = f.ch ?? src.clientHeight;
  if (f.scrollableY && f.gv) {
    // WebKit's author-styled thumb: whole css px (webkitStyledBar); a minimum the polyfill does not resolve keeps the generic geometry
    const wkMin = styled && engine === 'webkit' ? webkitStyledMinThumb(th) : null;
    const v = wkMin !== null ? webkitStyledBar(f.gv, ch, src.clientHeight, src.scrollHeight, wkMin)
      : verticalBar(f.gv, ch, src.scrollHeight, styled, !!authored, styled ? px(th.minHeight) : 0);
    box(doc, cloneScroller, `left:${cw + sL}px;top:${sT}px;width:${f.gv}px;height:${ch}px;${track}`, 'track');
    if (v.thumbH > 0) box(doc, cloneScroller, `left:${cw + sL + v.thumbX}px;top:${sT + v.thumbY(f.sT)}px;width:${v.thumbW}px;height:${v.thumbH}px;${thumb}`, 'thumb');
  }
  if (f.scrollableX && f.gh) {
    const tl = Math.max(minThumb, cw * (src.clientWidth / src.scrollWidth));
    const tx = (f.sL / (src.scrollWidth - src.clientWidth)) * (cw - tl);
    box(doc, cloneScroller, `left:${sL}px;top:${ch + sT}px;width:${cw}px;height:${f.gh}px;${track.replace('border-left', 'border-top')}`);
    box(doc, cloneScroller, `left:${sL + tx}px;top:${ch + sT + (styled ? 0 : authored ? 3 : 4)}px;width:${tl}px;height:${styled ? f.gh : f.gh - (authored ? 5 : 7)}px;${thumb}`);
  }
  if (f.scrollableX && f.scrollableY && f.gv && f.gh) box(doc, cloneScroller, `left:${cw + sL}px;top:${ch + sT}px;width:${f.gv}px;height:${f.gh}px;background:${styled ? co.backgroundColor : authored ? authored.track : '#fafafa'};`);
}

/**
 * Chromium's own classic bars (chromium-bars.js) as boxes of the clone scroller: per bar the track with its buttons (an SVG background in device px), the thumb (a
 * capsule; `data-hic-bar` roles for the vertical bar, which the scroll compositor moves), and the corner. A bar shows when the box scrolls on its axis or has
 * `overflow: scroll` (then without a thumb); a gutter of `scrollbar-gutter: stable` alone stays empty, as live.
 * @param {BarLook} look @param {Element} src @param {HTMLElement} clone @param {CSSStyleDeclaration} cs @param {ScrollFacts} f @param {boolean} scrolled
 */
function paintChromiumBars(look, src, clone, cs, f, scrolled) {
  const doc = clone.ownerDocument, d = look.dpr, c = barColors(look);
  const dev = (/** @type {number} */ v) => Math.round(v * d);
  const sT = scrolled ? f.sT : 0, sL = scrolled ? f.sL : 0;
  const cw = f.cw ?? src.clientWidth, ch = f.ch ?? src.clientHeight;
  const barY = !!f.gv && (f.scrollableY || cs.overflowY === 'scroll'), barX = !!f.gh && (f.scrollableX || cs.overflowX === 'scroll');
  const thumb = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ w, /** @type {number} */ h, /** @type {string|undefined} */ role = undefined) => box(doc, clone, `left:${x}px;top:${y}px;width:${w}px;height:${h}px;background:${c.thumb};border-radius:999px;`, role);
  if (barY) {
    const T = dev(f.gv), L = dev(ch);
    const p = barParts(look, { thick: T, len: L, visible: dev(src.clientHeight), total: dev(src.scrollHeight), offset: f.sT * d });
    box(doc, clone, `left:${cw + sL}px;top:${sT}px;width:${f.gv}px;height:${ch}px;background:${svgUrl(trackSvg(look, true, T, L, p.buttons), f.gv, ch, d)} 0 0/100% 100% no-repeat;`, 'track');
    if (p.thumb) thumb(cw + sL + p.thumb.across / d, sT + p.thumb.at / d, p.thumb.thick / d, p.thumb.len / d, 'thumb');
  }
  if (barX) {
    const T = dev(f.gh), L = dev(cw);
    const p = barParts(look, { thick: T, len: L, visible: dev(src.clientWidth), total: dev(src.scrollWidth), offset: f.sL * d });
    box(doc, clone, `left:${sL}px;top:${ch + sT}px;width:${cw}px;height:${f.gh}px;background:${svgUrl(trackSvg(look, false, T, L, p.buttons), cw, f.gh, d)} 0 0/100% 100% no-repeat;`);
    if (p.thumb) thumb(sL + p.thumb.at / d, ch + sT + p.thumb.across / d, p.thumb.len / d, p.thumb.thick / d);
  }
  if (barX && barY) box(doc, clone, `left:${cw + sL}px;top:${ch + sT}px;width:${f.gv}px;height:${f.gh}px;background:${svgUrl(cornerSvg(look, dev(f.gv), dev(f.gh)), f.gv, f.gh, d)} 0 0/100% 100% no-repeat;`);
}

/**
 * PURE. The vertical Chromium bar (paintChromiumBars) in the numbers of verticalBar, for the scroll compositor.
 * @param {BarLook} look @param {number} gutter css px @param {number} len  the bar's length (the scrollport height beside it), css px @param {number} clientHeight @param {number} scrollHeight
 * @returns {{thumbX: number, thumbW: number, thumbH: number, thumbY: (top: number) => number}}
 */
export function chromiumVerticalBar(look, gutter, len, clientHeight, scrollHeight) {
  const d = look.dpr;
  const at = (/** @type {number} */ top) => barParts(look, { thick: Math.round(gutter * d), len: Math.round(len * d), visible: Math.round(clientHeight * d), total: Math.round(scrollHeight * d), offset: top * d }).thumb;
  const t0 = at(0);
  return { thumbX: (t0?.across ?? 0) / d, thumbW: (t0?.thick ?? 0) / d, thumbH: (t0?.len ?? 0) / d, thumbY: (top) => (at(top)?.at ?? 0) / d };
}
