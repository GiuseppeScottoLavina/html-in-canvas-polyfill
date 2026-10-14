/**
 * Apply canvas geometry to a live element (docs/ARCHITECTURE.md ADR-F).
 * Module: live (src/live/*).
 */

import { MARK } from '../contracts/events.js';
import { cssPath, nativeDom } from './drawables.js';
import { borderBoxSize, rectInLayer, styleOf } from './measure.js';

/** @typedef {import('../contracts/types.js').ElementGeometry} ElementGeometry */
/** @typedef {import('../contracts/types.js').GeometryRules} GeometryRules */
/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */

/**
 * PURE. The CSS transform value `translate(-ex px, -ey px) matrix(M)` (or matrix3d for a 3D M; the perspective w row is kept); M is the stored canvas transform, offset = layout offset of the border box in the layer.
 * @param {DOMMatrixReadOnly} m
 * @param {{x: number, y: number}} offset
 * @param {number} [zoom]  CSS zoom of the element relative to the layer: px lengths in its own transform are multiplied by it, so the translation parts are written divided by it
 * @returns {string|null} null when an entry is NaN or infinite (the canvas transform is an unrestricted double: legal, but no CSS transform can express it)
 */
export function correctionTransform(m, offset, zoom = 1) {
  const z = zoom > 0 && Number.isFinite(zoom) ? zoom : 1;
  const cells = m.is2D ? [m.a, m.b, m.c, m.d, m.e / z, m.f / z] : [m.m11, m.m12, m.m13, m.m14, m.m21, m.m22, m.m23, m.m24, m.m31, m.m32, m.m33, m.m34, m.m41 / z, m.m42 / z, m.m43 / z, m.m44];
  if (!cells.every(Number.isFinite) || !Number.isFinite(offset.x) || !Number.isFinite(offset.y)) return null;
  const shift = `translate(${-offset.x / z}px, ${-offset.y / z}px)`;
  return `${shift} ${m.is2D ? 'matrix' : 'matrix3d'}(${cells.join(', ')})`;
}

/**
 * @typedef {Object} HitState  what the polyfill applied to one element
 * @property {string} key  geometry rule key
 * @property {boolean} attached  data-hic-hit is set (or queued to be)
 * @property {string} signature  last queued rule contents; equal = no-op
 * @property {Record<string, string>} place  last placement declarations: `transform` (+ origin 0 0) for a general matrix, or `position:relative` + `left/top` for a translation (shift scheme)
 * @property {boolean} shifted  the element is placed by the shift scheme: its own CSS transform stays the author's and composes after the canvas transform (spec order)
 * @property {string|null} clip  last clip-path value
 * @property {boolean} authorClip  the author's own clip-path wins: none is written
 * @property {DOMMatrix|null} matrix  spec matrix M that was applied (null: layout position only)
 * @property {{x: number, y: number}|null} offset  layout offset used
 * @property {{width: number, height: number}|null} size  border box size (for the clip)
 * @property {boolean} relative  the element is static and needs position:relative for its z-index
 * @property {number} zoom  CSS zoom of the element relative to the layer, read at the first application
 * @property {Set<Element>} nested  geometry-applied drawables below this one
 * @property {Element|null} parentDrawable  applied drawable ancestor this correction was computed against
 * @property {{geometry: ElementGeometry|null, inDrawnList: boolean, offset: {x: number, y: number}|null}} last
 */

/** @type {WeakMap<Element, HitState>} */
const states = new WeakMap();
/** @type {WeakMap<Element, number>} */
const ranks = new WeakMap();
/** @type {WeakMap<HTMLElement, Set<Element>>} elements with state per layer */
const appliedByLayer = new WeakMap();
/** @type {WeakSet<Element>} */
const reported = new WeakSet();
/** @type {Map<Element, () => void>} */
const queue = new Map();
let keyCounter = 0;
let flushQueued = false;

/** Run all queued rule and attribute writes now (also scheduled once per task). */
export function flushGeometryWrites() {
  flushQueued = false;
  const ops = [...queue.values()];
  queue.clear();
  for (const op of ops) op();
}

/** @param {Element} el @param {() => void} op */
function enqueue(el, op) {
  queue.set(el, op);
  if (flushQueued) return;
  flushQueued = true;
  queueMicrotask(() => { if (flushQueued) flushGeometryWrites(); });
}

/** @param {HTMLElement} layerEl @returns {Set<Element>} */
function registry(layerEl) {
  let set = appliedByLayer.get(layerEl);
  if (!set) appliedByLayer.set(layerEl, (set = new Set()));
  return set;
}

/** @param {HicEnv} env @param {string} id @param {Element} el @param {string} detail */
function reportOnce(env, id, el, detail) {
  if (reported.has(el)) return;
  reported.add(el);
  env.reporter.deviation(id, `${detail}: ${cssPath(el)}`);
}

/** @param {DOMMatrixReadOnly} m @returns {boolean} a finite 2D pure translation */
const isTranslation = (m) => m.is2D && m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && Number.isFinite(m.e) && Number.isFinite(m.f);

/** @param {CSSStyleDeclaration} cs @returns {boolean} */
const transformed = (cs) => [cs.transform, cs.translate, cs.rotate, cs.scale].some((v) => v && v !== 'none');

/** @param {CSSStyleDeclaration} cs @returns {boolean} */
const clips = (cs) => cs.overflowX !== 'visible' || cs.overflowY !== 'visible' || /paint|strict|content/.test(cs.contain) || cs.clipPath !== 'none';

/**
 * The applied drawable ancestor of `el` (nearest), or null; `blocked` when a plain ancestor on the way up to the layer transforms or clips.
 * @param {Element} el
 * @param {HTMLElement} layerEl
 * @returns {{parent: Element|null, blocked: boolean}}
 */
function ancestorPath(el, layerEl) {
  const parentOf = nativeDom().parentNode;
  for (let cur = parentOf.call(el); cur && cur !== layerEl && cur.nodeType === 1; cur = parentOf.call(cur)) {
    const node = /** @type {Element} */ (cur);
    const applied = states.get(node);
    if (applied?.matrix) return { parent: node, blocked: applied.shifted && transformed(styleOf(node)) };
    const cs = styleOf(node);
    if (transformed(cs) || clips(cs)) return { parent: null, blocked: true };
  }
  return { parent: null, blocked: false };
}

/**
 * CSS matrix of a drawable below an applied drawable `parent`: T(eP - eC) M_P^-1 M, so that parent and child transforms compose to M_child. Every applied rule pins `transform-origin: 0 0`: the canvas transform maps the BORDER BOX (origin at its top-left corner) to the canvas and knows no transform-origin (WPT get-element-transform).
 * @param {Element} el @param {DOMMatrix} m @param {{x: number, y: number}} offset
 * @param {Element} parent @param {HitState} parentState
 * @returns {DOMMatrix|null} null when the parent draw matrix is singular
 */
function nestedMatrix(el, m, offset, parent, parentState) {
  const dp = parentState.matrix ?? new DOMMatrix();
  if (!Array.from(dp.inverse().toFloat64Array()).every(Number.isFinite)) return null;
  const pe = parentState.offset ?? { x: 0, y: 0 };
  return new DOMMatrix().translate(pe.x - offset.x, pe.y - offset.y).multiply(dp.inverse()).multiply(m);
}

/** @param {DOMRect|null} clip @param {{width: number, height: number}|null} size @returns {string|null} inset() relative to the border box, null when it clips nothing */
function clipInset(clip, size) {
  if (!clip || !size) return null;
  if (![clip.x, clip.y, clip.width, clip.height, size.width, size.height].every(Number.isFinite)) return null;
  const t = Math.max(0, clip.y);
  const l = Math.max(0, clip.x);
  const r = Math.max(0, size.width - (clip.x + clip.width));
  const b = Math.max(0, size.height - (clip.y + clip.height));
  if (t + l + r + b < 0.01) return null;
  const px = (/** @type {number} */ n) => `${Math.round(n * 100) / 100}px`;
  return `inset(${px(t)} ${px(r)} ${px(b)} ${px(l)})`;
}

/** @param {HTMLElement} layerEl @param {Element} el @param {HitState} st @param {GeometryRules} rules @param {Record<string, string>} place @param {string|null} clip */
function queueWrite(layerEl, el, st, rules, place, clip) {
  const rank = ranks.get(el);
  /** @type {Record<string, string>} */
  const decl = { ...place };
  if (clip) decl['clip-path'] = clip;
  if (rank !== undefined) {
    decl['z-index'] = String(rank);
    if (st.relative) decl.position = 'relative';
  }
  const signature = JSON.stringify(decl);
  st.place = place;
  st.clip = clip;
  // Same signature as the last QUEUED write: that write is either flushed or still pending and still correct, so it must stay in the queue.
  if (st.attached && st.signature === signature) return;
  st.signature = signature;
  st.attached = true;
  registry(layerEl).add(el);
  enqueue(el, () => {
    rules.set(st.key, decl);
    if (el.getAttribute(MARK.HIT_ATTR) !== st.key) el.setAttribute(MARK.HIT_ATTR, st.key);
  });
}

/** @param {HTMLElement} layerEl @param {GeometryRules} rules @param {Element} el */
function detach(layerEl, rules, el) {
  const st = states.get(el);
  if (!st) return;
  states.delete(el);
  registry(layerEl).delete(el);
  if (st.parentDrawable) states.get(st.parentDrawable)?.nested.delete(el);
  enqueue(el, () => {
    rules.remove(st.key);
    el.removeAttribute(MARK.HIT_ATTR);
  });
}

/**
 * First application: author transform / positioning of the element decide whether the correction is possible. An own CSS transform is fine under a translation (shift scheme, see placement()).
 * @param {HicEnv} env @param {HTMLElement} layerEl @param {Element} el @param {DOMMatrixReadOnly} m
 */
function firstChecks(env, layerEl, el, m) {
  const cs = styleOf(el);
  if (transformed(cs) && !(isTranslation(m) && cs.position === 'static')) { reportOnce(env, 'css-transform-on-drawable', el, 'geometry not applied, the element has its own CSS transform'); return null; }
  const path = ancestorPath(el, layerEl);
  if (path.blocked) { reportOnce(env, 'nested-geometry', el, 'geometry not applied below a transformed or clipping ancestor'); return null; }
  return { relative: cs.position === 'static', clipped: cs.clipPath !== 'none', zoom: zoomInLayer(el, layerEl, cs) };
}

/** @param {Element} el @param {HTMLElement} layerEl @param {CSSStyleDeclaration} cs @returns {number} product of the `zoom` of el and its ancestors below the layer */
function zoomInLayer(el, layerEl, cs) {
  const parentOf = nativeDom().parentNode;
  let z = parseFloat(cs.zoom) || 1;
  for (let cur = parentOf.call(el); cur && cur !== layerEl && cur.nodeType === 1; cur = parentOf.call(cur)) z *= parseFloat(styleOf(/** @type {Element} */ (cur)).zoom) || 1;
  return z;
}

/**
 * Write `[data-hic-hit="key"]{transform; clip-path; z-index}` through `rules` (NO inline style, NO layout read in the common case: `layoutOffset` is the one cached on the newest SnapshotVersion, or the layer's lazily revalidated value) and set data-hic-hit.
 * No-op when matrix, clip and rank are unchanged. Writes are queued and flushed once per task. Nested drawables (a drawable ancestor with applied geometry P): the correction is P^-1 * D_child, and the parent's clip-path is
 * not applied to hit testing while it has geometry-applied nested drawables (reported once as nested-geometry). Skips with a once-per-element report (nested-geometry / css-transform-on-drawable) when preconditions fail. geometry null: remove the rule and the attribute.
 * Layout is read only on the first application without an offset, for the clip size, and for a nested correction (transform origins).
 * @param {HicEnv} env
 * @param {GeometryRules} rules
 * @param {HTMLElement} layerEl
 * @param {Element} el
 * @param {ElementGeometry|null} geometry
 * @param {boolean} inDrawnList
 * @param {{x: number, y: number}|null} layoutOffset
 */
export function applyGeometryToElement(env, rules, layerEl, el, geometry, inDrawnList, layoutOffset) {
  if (!geometry || !inDrawnList) { detach(layerEl, rules, el); return; }
  let st = states.get(el);
  /** @type {{relative: boolean, clipped: boolean, zoom: number}|null} */
  let checks = null;
  if (!st) {
    checks = firstChecks(env, layerEl, el, geometry.transform ?? new DOMMatrix());
    if (!checks) return;
    st = { key: `g${++keyCounter}`, attached: false, signature: '', place: {}, shifted: false, clip: null, authorClip: checks.clipped, matrix: null, offset: null, size: null, relative: checks.relative, zoom: checks.zoom, nested: new Set(), parentDrawable: null, last: { geometry, inDrawnList, offset: layoutOffset } };
    states.set(el, st);
  }
  st.last = { geometry, inDrawnList, offset: layoutOffset };
  const offset = layoutOffset ?? st.offset ?? (st.matrix ? null : measureLayoutOffset(layerEl, el));
  if (!offset) { detach(layerEl, rules, el); return; }
  st.offset = { x: offset.x, y: offset.y };
  const m = geometry.transform ?? new DOMMatrix();
  st.matrix = m;
  const path = ancestorPath(el, layerEl);
  const parentState = path.parent ? states.get(path.parent) : undefined;
  if (st.parentDrawable && st.parentDrawable !== path.parent) states.get(st.parentDrawable)?.nested.delete(el);
  st.parentDrawable = path.parent;
  let transform;
  if (path.parent && parentState) {
    const css = nestedMatrix(el, m, offset, path.parent, parentState);
    if (!css) { reportOnce(env, 'nested-geometry', el, 'geometry not applied, the parent transform is singular'); detach(layerEl, rules, el); return; }
    transform = correctionTransform(css, { x: 0, y: 0 }, st.zoom);
    if (transform === null) { detach(layerEl, rules, el); return; }
    if (!parentState.nested.has(el)) {
      parentState.nested.add(el);
      reportOnce(env, 'nested-geometry', path.parent, 'clip of a drawable with geometry-applied nested drawables is not applied to hit testing');
      reapply(env, rules, layerEl, path.parent);
    }
  } else if (st.relative && isTranslation(m)) {
    transform = null;
  } else {
    // Leaving the shift scheme: the author's own transform would be replaced by the matrix (only the shift scheme composes with it).
    if (st.shifted && transformed(styleOf(el))) { reportOnce(env, 'css-transform-on-drawable', el, 'geometry with scale, rotation or skew not applied, the element has its own CSS transform'); detach(layerEl, rules, el); return; }
    transform = correctionTransform(m, offset, st.zoom);
    if (transform === null) { detach(layerEl, rules, el); return; }
  }
  st.shifted = transform === null;
  let clip = null;
  if (geometry.clip && !st.nested.size && !st.authorClip) {
    st.size = borderBoxSize(el, null); // measured at every application that carries a clip: a cached size outlives a resize and turns a full-box clip into a clip of the whole element
    clip = clipInset(geometry.clip, st.size);
  }
  queueWrite(layerEl, el, st, rules, transform === null ? shiftPlacement(m, offset, st.zoom) : { transform, 'transform-origin': '0 0' }, clip);
}

/**
 * Shift scheme (a translation M on a static element): the canvas transform becomes a relative offset, so the author's own transform, translate, rotate and scale keep applying AFTER it, around the
 * author's transform-origin, exactly the spec order (canvas transform before CSS transforms) and synchronously when the author changes them (WPT canvas-transform-get-bounding-client-rect, elementsFromPoint).
 * Offsets are layout units (1/64 px), well inside the 0.01 px the WPT geometry tests allow.
 * @param {DOMMatrixReadOnly} m @param {{x: number, y: number}} offset @param {number} zoom  see correctionTransform
 * @returns {Record<string, string>}
 */
function shiftPlacement(m, offset, zoom) {
  const z = zoom > 0 && Number.isFinite(zoom) ? zoom : 1;
  return { position: 'relative', left: `${(m.e - offset.x) / z}px`, top: `${(m.f - offset.y) / z}px`, right: 'auto', bottom: 'auto' };
}

/**
 * Layout offset of the border box in the layer, measured with the corrections of the element and of its applied ancestors lifted (they are written synchronously now, so a nested
 * drawable measured while its parent carries its transform would read the PARENT'S drawn position as its own layout offset).
 * @param {HTMLElement} layerEl @param {Element} el @returns {{x: number, y: number}|null}
 */
function measureLayoutOffset(layerEl, el) {
  const parentOf = nativeDom().parentNode;
  /** @type {Array<[Element, string]>} */
  const lifted = [];
  for (let cur = /** @type {Node|null} */ (el); cur && cur !== layerEl && cur.nodeType === 1; cur = parentOf.call(cur)) {
    const key = /** @type {Element} */ (cur).getAttribute(MARK.HIT_ATTR);
    if (key !== null) lifted.push([/** @type {Element} */ (cur), key]);
  }
  for (const [node] of lifted) node.removeAttribute(MARK.HIT_ATTR);
  const r = rectInLayer(layerEl, el);
  for (const [node, key] of lifted) node.setAttribute(MARK.HIT_ATTR, key);
  return r && { x: r.x, y: r.y };
}

/** @param {HicEnv} env @param {GeometryRules} rules @param {HTMLElement} layerEl @param {Element} el */
function reapply(env, rules, layerEl, el) {
  const st = states.get(el);
  if (st) applyGeometryToElement(env, rules, layerEl, el, st.last.geometry, st.last.inDrawnList, st.last.offset);
}

/**
 * z-index = rank for the drawn elements (through the geometry rule, `position:relative` only on drawables that are static), removes HIT_ATTR from the rest.
 * @param {GeometryRules} rules
 * @param {HTMLElement} layerEl
 * @param {Element[]} order
 */
export function applyHitTestOrder(rules, layerEl, order) {
  const keep = new Set(order);
  for (const el of [...registry(layerEl)]) if (!keep.has(el)) detach(layerEl, rules, el);
  order.forEach((el, i) => {
    ranks.set(el, i + 1);
    const st = states.get(el);
    if (st) queueWrite(layerEl, el, st, rules, st.place, st.clip);
  });
}

/**
 * Re-measure the layout offsets of the applied elements of a layer (their transform is lifted for the read inside one task, so nothing is painted in between) and rewrite changed corrections.
 * @param {HicEnv} env
 * @param {GeometryRules} rules
 * @param {HTMLElement} layerEl
 */
export function revalidateOffsets(env, rules, layerEl) {
  flushGeometryWrites();
  const els = [...registry(layerEl)].filter((el) => states.get(el)?.matrix);
  if (!els.length) return;
  for (const el of els) el.removeAttribute(MARK.HIT_ATTR);
  const rects = els.map((el) => rectInLayer(layerEl, el));
  for (const el of els) el.setAttribute(MARK.HIT_ATTR, /** @type {HitState} */ (states.get(el)).key);
  els.forEach((el, i) => {
    const st = states.get(el);
    const r = rects[i];
    if (!st || !r) return;
    if (st.offset && Math.abs(st.offset.x - r.x) < 0.01 && Math.abs(st.offset.y - r.y) < 0.01) return;
    st.size = null;
    applyGeometryToElement(env, rules, layerEl, el, st.last.geometry, st.last.inDrawnList, { x: r.x, y: r.y });
  });
}

/**
 * The spec matrix M that governs how `el` is rendered: its own when geometry is applied to it, else that of the nearest applied ancestor below the layer (null: none).
 * Used to undo the transform when measuring sizes and frames, so it must be the matrix the DOCUMENT carries: the pending rule writes are flushed first. A draw stores its matrix at once but
 * writes the rule in a microtask, and the paint event is dispatched from the scheduler's own JS stack, so the store's next layout read (verifyGeometries) can run before that microtask: it divided
 * a bounding box that still carried the previous matrix by the new one, measured a size up to 2 % off, and re-rastered the drawable from it (the resize residual: a stale stretch left on screen).
 * @param {Element} el
 * @param {HTMLElement} layerEl
 * @returns {DOMMatrix|null}
 */
export function appliedMatrixOf(el, layerEl) {
  if (queue.size) flushGeometryWrites();
  const parentOf = nativeDom().parentNode;
  for (let cur = /** @type {Node|null} */ (el); cur && cur !== layerEl && cur.nodeType === 1; cur = parentOf.call(cur)) {
    const st = states.get(/** @type {Element} */ (cur));
    // A shifted element is only displaced (no scale): its bounding box carries the author's own transform, which the caller detects itself.
    if (st?.matrix) return st.shifted ? null : st.matrix;
  }
  return null;
}

/** @param {Element} el @returns {{x: number, y: number}|null} layout offset used for the applied correction of `el` (cached, no measuring) */
export function appliedOffsetOf(el) {
  const o = states.get(el)?.offset;
  return o ? { x: o.x, y: o.y } : null;
}

/** Forget everything about a layer (unmount): attributes and rules are removed. */
export function clearGeometry(/** @type {GeometryRules} */ rules, /** @type {HTMLElement} */ layerEl) {
  for (const el of [...registry(layerEl)]) {
    const st = states.get(el);
    if (st) { rules.remove(st.key); el.removeAttribute(MARK.HIT_ATTR); states.delete(el); }
    queue.delete(el);
  }
  registry(layerEl).clear();
}
