/**
 * Scroll offsets and classic scrollbars of the scrollers in the clone.
 * Module: snapshot-capture (src/snapshot/capture/*).
 *
 * The clone scrolls FOR REAL: a viewport-sized invisible marker at (scrollLeft, scrollTop) carries `scroll-initial-target: nearest`, so the engine itself
 * scrolls the clone scroller at first layout (sticky headers, fractional offsets and everything else exact, 0.01-0.7 % in the pixel oracle). Native bars are hidden in the
 * clone; when the live scroller has a classic gutter the gutter is reproduced as padding and the track/thumb/corner are painted as boxes.
 */

import { appendInlineStyle, setInlineStyle } from './inline-style.js';
import { currentEngine } from '../../util/engine.js';
import { engineSkins } from './engine-skins.js';
import { inlineCssUrls } from './inline-resources.js';

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
 * @property {number} gv  live width of the vertical bar gutter (0 for overlay bars)
 * @property {number} gh  live height of the horizontal bar gutter
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
  const gv = Math.max(0, html.offsetWidth - src.clientWidth - px(cs.borderLeftWidth) - px(cs.borderRightWidth));
  const gh = Math.max(0, html.offsetHeight - src.clientHeight - px(cs.borderTopWidth) - px(cs.borderBottomWidth));
  const scrollableY = cs.overflowY !== 'visible' && src.scrollHeight > src.clientHeight;
  const scrollableX = cs.overflowX !== 'visible' && src.scrollWidth > src.clientWidth;
  if (!sT && !sL && !(scrollableY && gv) && !(scrollableX && gh)) return null;
  const w = cs.getPropertyValue('width') && (src.ownerDocument.defaultView ?? window).getComputedStyle(src, '::-webkit-scrollbar').width;
  return { sT, sL, gv, gh, scrollableY, scrollableX, styled: !!w && w !== 'auto' && w !== '0px' && cs.scrollbarWidth === 'auto' };
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
  if (src.localName === 'select') { listboxScroll(src, cloneScroller); return res; }
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
  if ((f.gv && f.scrollableY) || (f.gh && f.scrollableX)) paintClassicScrollbars(env, req, res, src, cloneScroller, scrolled);
  return res;
}

/**
 * A listbox select renders only its options (no marker box, no bar boxes), and the image document scrolls the selected option into view on its own. The live offset is set
 * with snapping instead: the clone is a mandatory snap container whose only snap area is the first option at or below the live scrollport top, `scroll-padding-top` being
 * that option's distance from it (measured in Firefox 157 and Safari 27: snapping wins over the selected-option scroll in the image).
 * @param {Element} src @param {HTMLElement} clone
 */
function listboxScroll(src, clone) {
  const r = src.getBoundingClientRect();
  const scale = r.height > 0 ? /** @type {HTMLElement} */ (src).offsetHeight / r.height : 1; // the layer may be scaled (transform mode)
  const dist = (/** @type {Element} */ o) => (o.getBoundingClientRect().top - r.top) * scale - src.clientTop;
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
    if (skins) { skins.paintWebkitBars(win, src, cloneScroller, f, skins.webkitDarkBars(win, src)); return; }
  }
  const dark = !styled && !authored && engine === 'gecko' && onDarkBackground(win, src);
  const track = authored ? `background:${authored.track};` : styled
    ? `background:${tr.backgroundColor !== 'rgba(0, 0, 0, 0)' ? tr.backgroundColor : bar.backgroundColor};${barImage(tr, env.document.baseURI, req.resources, res)}border-left:${tr.borderLeftWidth} ${tr.borderLeftStyle} ${tr.borderLeftColor};`
    : dark ? 'background:#2e2e2e;border-left:1px solid #333;box-sizing:border-box;' : 'background:#fafafa;border-left:1px solid #e8e8e8;box-sizing:border-box;';
  const thumb = authored ? `background:${authored.thumb};border-radius:99px;box-sizing:border-box;` : styled
    ? `background:${th.backgroundColor};${barImage(th, env.document.baseURI, req.resources, res)}border:${th.borderTopWidth} ${th.borderTopStyle} ${th.borderTopColor};border-radius:${th.borderTopLeftRadius};box-sizing:border-box;`
    : `background:${dark ? '#757575' : '#c1c1c1'};border-radius:4px;box-sizing:border-box;`;
  const minThumb = styled ? 20 : 30;
  const sT = scrolled ? f.sT : 0, sL = scrolled ? f.sL : 0;
  if (f.scrollableY && f.gv) {
    const len = src.clientHeight;
    const v = verticalBar(f.gv, src.clientHeight, src.scrollHeight, styled, !!authored, styled ? px(th.minHeight) : 0);
    box(doc, cloneScroller, `left:${src.clientWidth + sL}px;top:${sT}px;width:${f.gv}px;height:${len}px;${track}`, 'track');
    box(doc, cloneScroller, `left:${src.clientWidth + sL + v.thumbX}px;top:${sT + v.thumbY(f.sT)}px;width:${v.thumbW}px;height:${v.thumbH}px;${thumb}`, 'thumb');
  }
  if (f.scrollableX && f.gh) {
    const len = src.clientWidth;
    const tl = Math.max(minThumb, len * (src.clientWidth / src.scrollWidth));
    const tx = (f.sL / (src.scrollWidth - src.clientWidth)) * (len - tl);
    box(doc, cloneScroller, `left:${sL}px;top:${src.clientHeight + sT}px;width:${len}px;height:${f.gh}px;${track.replace('border-left', 'border-top')}`);
    box(doc, cloneScroller, `left:${sL + tx}px;top:${src.clientHeight + sT + (styled ? 0 : authored ? 3 : 4)}px;width:${tl}px;height:${styled ? f.gh : f.gh - (authored ? 5 : 7)}px;${thumb}`);
  }
  if (f.scrollableX && f.scrollableY && f.gv && f.gh) box(doc, cloneScroller, `left:${src.clientWidth + sL}px;top:${src.clientHeight + sT}px;width:${f.gv}px;height:${f.gh}px;background:${styled ? co.backgroundColor : authored ? authored.track : '#fafafa'};`);
}
