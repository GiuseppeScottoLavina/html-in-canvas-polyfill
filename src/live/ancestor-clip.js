/**
 * Clipping / fixed ancestors of a canvas: keeps the layer clipped like the canvas and reveals focus inside canvas scrollers (docs/ARCHITECTURE.md ADR-L).
 * Module: live (src/live/*).
 */

import { onCanvasSuspension } from '../util/suspension.js';
import { boxScale } from '../util/box-scale.js';
import { cssPath } from './drawables.js';
import { layoutSize, styleOf } from './measure.js';
import { setLayerDeclaration } from './presentation.js';

/** @typedef {import('../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */

/**
 * @typedef {Object} AncestorClip
 * @property {() => void} update  re-detect the chain and rewrite the layer clip-path inset (called from syncPresentation, scroll and resize of the chain)
 * @property {(el: Element) => void} reveal  scroll the canvas's clipping ancestors with 'nearest' semantics so `el` (inside the layer) becomes visible
 * @property {() => 'static'|'fixed'|'clipped'|'unsupported'} kind  what was found; 'unsupported' is reported once as layer-containing-block
 * @property {() => void} dispose
 */

/** @typedef {{el: HTMLElement, x: boolean, y: boolean}} Clipper */

/** @param {CSSStyleDeclaration} cs @returns {boolean} an absolutely positioned descendant of this element is placed relative to it */
function formsContainingBlock(cs) {
  if (cs.position !== 'static') return true;
  if ([cs.transform, cs.translate, cs.rotate, cs.scale, cs.perspective, cs.filter, cs.backdropFilter].some((v) => v && v !== 'none')) return true;
  if (/layout|paint|strict|content/.test(cs.contain)) return true;
  if (cs.containerType && cs.containerType !== 'normal') return true;
  return /transform|perspective|filter|contain/.test(cs.willChange);
}

/** @param {CSSStyleDeclaration} cs @returns {{x: boolean, y: boolean}} axes along which this element clips its in-flow content */
function clippedAxes(cs) {
  const paint = /paint|strict|content/.test(cs.contain) || cs.contentVisibility === 'auto' || cs.contentVisibility === 'hidden';
  return { x: paint || cs.overflowX !== 'visible', y: paint || cs.overflowY !== 'visible' };
}

/** @param {Element} el @returns {Element|null} parent across shadow boundaries */
function parentOf(el) {
  return el.parentElement ?? /** @type {ShadowRoot} */ (el.getRootNode()).host ?? null;
}

/** @param {HTMLElement} el @returns {{left: number, top: number, right: number, bottom: number, sx: number, sy: number}} visible (padding box) rect of a clipper in viewport px */
function visibleRect(el) {
  const r = el.getBoundingClientRect();
  const { x: sx, y: sy } = boxScale(el, r);
  const left = r.left + el.clientLeft * sx;
  const top = r.top + el.clientTop * sy;
  return { left, top, right: left + el.clientWidth * sx, bottom: top + el.clientHeight * sy, sx, sy };
}

/**
 * Nearest-scroll delta of the interval [lo, hi] against the visible interval [from, to]: 0 when visible, else the smaller move that reveals the start.
 * @param {number} lo @param {number} hi @param {number} from @param {number} to
 */
function nearest(lo, hi, from, to) {
  if (lo < from) return lo - from;
  if (hi > to) return Math.min(hi - to, lo - from);
  return 0;
}

/**
 * 1) canvas or an ancestor is position:fixed -> the layer gets position:fixed (important). 2) overflow != visible / contain:paint / content-visibility ancestors BETWEEN the canvas and the layer's containing block
 * clip the canvas but not the layer: keep `clip-path: inset()` on the layer = canvas rect intersected with those ancestors' visible rects (ResizeObserver + scroll on the chain).
 * The inset is computed from the canvas rect, never from the layer's own rect (that misses the anchor's scroll compensation). Never sets position on author elements. Sticky canvases need nothing (measured).
 * @param {HicEnv} env
 * @param {CanvasRecord} record
 * @param {HTMLElement} layerEl
 * @returns {AncestorClip}
 */
export function createAncestorClip(env, record, layerEl) {
  const canvas = record.canvas;
  /** @type {'static'|'fixed'|'clipped'|'unsupported'} */
  let found = 'static';
  /** @type {Clipper[]} */
  let chain = [];
  /** @type {Array<() => void>} */
  let unwatch = [];
  let reported = false;
  const resizeObserver = new (/** @type {any} */ (env.window)).ResizeObserver(() => applyClip());

  const offSuspension = onCanvasSuspension(env, record, () => resizeObserver.disconnect(), () => watch(chain));

  function detect() {
    const cs = styleOf(canvas);
    /** @type {Clipper[]} */
    const next = [];
    /** @type {'static'|'fixed'|'clipped'|'unsupported'} */
    let kind = 'static';
    if (cs.position === 'fixed') kind = 'fixed';
    else {
      for (let a = parentOf(canvas); a; a = parentOf(a)) {
        const acs = styleOf(a);
        if (formsContainingBlock(acs)) break;
        const axes = clippedAxes(acs);
        if (!axes.x && !axes.y) continue;
        next.push({ el: /** @type {HTMLElement} */ (a), ...axes });
        if (acs.clipPath !== 'none') kind = 'unsupported';
      }
      if (next.length && kind !== 'unsupported') kind = 'clipped';
    }
    found = kind;
    setLayerDeclaration(layerEl, 'position', kind === 'fixed' ? 'fixed' : 'absolute');
    if (kind === 'unsupported' && !reported) {
      reported = true;
      env.reporter.unsupported({
        feature: 'layer-containing-block',
        message: 'the canvas sits inside a clipping ancestor with a clip-path shape that the layer clip cannot follow',
        hint: 'give the canvas container position:relative',
        path: cssPath(canvas),
      }, canvas);
    }
    return next;
  }

  /** @param {Clipper[]} next */
  function watch(next) {
    for (const off of unwatch) off();
    unwatch = [];
    resizeObserver.disconnect();
    if (!next.length) return;
    resizeObserver.observe(canvas);
    for (const { el } of next) {
      resizeObserver.observe(el);
      const onScroll = () => applyClip();
      el.addEventListener('scroll', onScroll, { passive: true });
      unwatch.push(() => el.removeEventListener('scroll', onScroll));
    }
  }

  function applyClip() {
    if (!chain.length) { setLayerDeclaration(layerEl, 'clip-path', null); return; }
    const cr = canvas.getBoundingClientRect();
    const size = layoutSize(canvas);
    const sx = size && size.width ? cr.width / size.width : 1;
    const sy = size && size.height ? cr.height / size.height : 1;
    const vis = { left: cr.left, top: cr.top, right: cr.right, bottom: cr.bottom };
    for (const { el, x, y } of chain) {
      const v = visibleRect(el);
      if (x) { vis.left = Math.max(vis.left, v.left); vis.right = Math.min(vis.right, v.right); }
      if (y) { vis.top = Math.max(vis.top, v.top); vis.bottom = Math.min(vis.bottom, v.bottom); }
    }
    const round = (/** @type {number} */ n) => Math.round(Math.max(0, n) * 100) / 100;
    const t = round((vis.top - cr.top) / sy);
    const l = round((vis.left - cr.left) / sx);
    const r = round((cr.right - vis.right) / sx);
    const b = round((cr.bottom - vis.bottom) / sy);
    if (vis.right <= vis.left || vis.bottom <= vis.top) setLayerDeclaration(layerEl, 'clip-path', 'inset(100% 0 0 0)');
    else if (t + l + r + b < 0.01) setLayerDeclaration(layerEl, 'clip-path', null);
    else setLayerDeclaration(layerEl, 'clip-path', `inset(${t}px ${r}px ${b}px ${l}px)`);
  }

  return {
    update() {
      const next = detect();
      const same = next.length === chain.length && next.every((c, i) => c.el === chain[i].el && c.x === chain[i].x && c.y === chain[i].y);
      chain = next;
      if (!same) watch(chain);
      applyClip();
    },
    reveal(el) {
      for (const { el: scroller, x, y } of chain) {
        const v = visibleRect(scroller);
        const r = el.getBoundingClientRect();
        if (y) scroller.scrollTop += nearest(r.top, r.bottom, v.top, v.bottom) / v.sy;
        if (x) scroller.scrollLeft += nearest(r.left, r.right, v.left, v.right) / v.sx;
      }
      applyClip();
    },
    kind: () => found,
    dispose() {
      offSuspension();
      for (const off of unwatch) off();
      unwatch = [];
      resizeObserver.disconnect();
      chain = [];
      setLayerDeclaration(layerEl, 'position', null);
      setLayerDeclaration(layerEl, 'clip-path', null);
    },
  };
}
