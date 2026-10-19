/**
 * Layout measurement helpers that ignore applied geometry transforms.
 * Module: live (src/live/*).
 *
 * Rects come from getBoundingClientRect (fractional, viewport space, affected by transforms), so every helper removes the two
 * transform sources that matter: a uniform ancestor scale (measured as layer rect / layer layout size) and the polyfill's own applied
 * matrix. Rotated or 3D applied matrices cannot be inverted from a bounding box: those fall back to the computed used size.
 */

import { isLayerElement, nativeDom } from './drawables.js';

/** @typedef {import('../contracts/types.js').LiveLayer} LiveLayer */
/** @typedef {import('../contracts/types.js').Rect} Rect */
/** @typedef {import('../contracts/types.js').Size} Size */
/** @typedef {import('../contracts/types.js').Insets} Insets */

const EPS = 1e-6;

/**
 * Element has a CSS box (not display:none, not under display:none).
 * @param {Element} el
 * @returns {boolean}
 */
export function isLaidOut(el) {
  return el.isConnected && el.getClientRects().length > 0;
}

/** @param {string} value @returns {number} */
const px = (value) => parseFloat(value) || 0;

/** @param {Element} el @returns {CSSStyleDeclaration} computed style through the element's own window */
export function styleOf(el) {
  return (el.ownerDocument.defaultView ?? window).getComputedStyle(el);
}

/**
 * Used border-box size in css px before any transform, from the computed style (fractional). null for boxes whose width/height resolve to a keyword (inline).
 * @param {Element} el
 * @param {CSSStyleDeclaration} [style]
 * @returns {Size|null}
 */
export function layoutSize(el, style = styleOf(el)) {
  const w = parseFloat(style.width);
  const h = parseFloat(style.height);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  if (style.boxSizing === 'border-box') return { width: w, height: h };
  return {
    width: w + px(style.paddingLeft) + px(style.paddingRight) + px(style.borderLeftWidth) + px(style.borderRightWidth),
    height: h + px(style.paddingTop) + px(style.paddingBottom) + px(style.borderTopWidth) + px(style.borderBottomWidth),
  };
}

/** @param {Element} el @returns {HTMLElement|null} nearest polyfill layer above el (not el itself); reads the native parent chain, which the tree facade shadows */
function layerOf(el) {
  const parentOf = nativeDom().parentNode;
  for (let cur = parentOf.call(el); cur && cur.nodeType === 1; cur = parentOf.call(cur)) {
    if (isLayerElement(/** @type {Element} */ (cur))) return /** @type {HTMLElement} */ (cur);
  }
  return null;
}

/**
 * Uniform scale between layout px and viewport px at `layer` (page transforms on its ancestors, e.g. scale(1.5)); 1 when it cannot be measured.
 * @param {Element|null} layer
 * @returns {{x: number, y: number}}
 */
function layoutScale(layer) {
  if (!layer) return { x: 1, y: 1 };
  const size = layoutSize(layer);
  if (!size || size.width < EPS || size.height < EPS) return { x: 1, y: 1 };
  const r = layer.getBoundingClientRect();
  return { x: r.width / size.width || 1, y: r.height / size.height || 1 };
}

/** @param {DOMMatrixReadOnly|null} m @returns {{x: number, y: number}|null} per-axis scale when m is an axis-aligned positive 2D scale+translate */
function axisScale(m) {
  if (!m) return { x: 1, y: 1 };
  if (!m.is2D || Math.abs(m.b) > EPS || Math.abs(m.c) > EPS || m.a < EPS || m.d < EPS) return null;
  return { x: m.a, y: m.d };
}

/** @param {Element} el @returns {boolean} an author transform (any of the four properties) is in effect */
function hasAuthorTransform(el) {
  const s = styleOf(el);
  return s.transform !== 'none' || (s.translate !== 'none' && s.translate !== '') || (s.rotate !== 'none' && s.rotate !== '') || (s.scale !== 'none' && s.scale !== '');
}

/** @param {HTMLElement} el @returns {Size} integer fallback */
const offsetSize = (el) => ({ width: el.offsetWidth, height: el.offsetHeight });

/**
 * Layout sizes are multiples of 1/64 css px (Blink LayoutUnit) but the bounding box of a scaled element is float32, so `width / scale` carries noise of ~1e-4 px. A surface is sized
 * `ceil((width + 2 * ink) * scale)`: 4e-5 px of excess made it one device pixel wider than the final layout, and the SVG raster was resampled for good (the resize residual: 2.7 % of the
 * pixels off). A value within 0.05/64 px of the grid is the grid value; anything else (a page scaled by an ancestor, a layout that is not on the grid) is left alone.
 * @param {number} v css px
 * @returns {number}
 */
function snapToLayoutGrid(v) {
  const g = v * 64;
  const n = Math.round(g);
  return Math.abs(g - n) < 0.05 ? n / 64 : v;
}

/**
 * Fractional border box size in css px before any transform (getBoundingClientRect divided by the applied linear transform, or the computed used size).
 * @param {Element} el
 * @param {DOMMatrixReadOnly|null} applied
 * @returns {Size|null}
 */
export function borderBoxSize(el, applied) {
  if (!isLaidOut(el)) return null;
  const k = applied ? axisScale(applied) : (hasAuthorTransform(el) ? null : { x: 1, y: 1 });
  if (k) {
    const s = layoutScale(layerOf(el));
    const r = el.getBoundingClientRect();
    return { width: snapToLayoutGrid(r.width / (s.x * k.x)), height: snapToLayoutGrid(r.height / (s.y * k.y)) };
  }
  return layoutSize(el) ?? offsetSize(/** @type {HTMLElement} */ (el));
}

/**
 * Rect of el in the border-box frame of `drawable` with the drawable's applied geometry transform removed (LiveLayer.frameRect).
 * A rotated/3D applied matrix cannot be inverted from bounding boxes: the answer is then the whole drawable border box (a safe damage superset).
 * @param {Element} drawable
 * @param {Element} el
 * @param {DOMMatrixReadOnly|null} applied
 * @returns {Rect|null}
 */
export function frameRectOf(drawable, el, applied) {
  if (!isLaidOut(el)) return null;
  const whole = () => {
    const size = borderBoxSize(drawable, applied);
    return size ? { x: 0, y: 0, width: size.width, height: size.height } : null;
  };
  if (el === drawable) return whole();
  const k = applied ? axisScale(applied) : (hasAuthorTransform(drawable) ? null : { x: 1, y: 1 });
  if (!k) return whole();
  const s = layoutScale(layerOf(drawable));
  const sx = s.x * k.x;
  const sy = s.y * k.y;
  const d = drawable.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { x: (r.x - d.x) / sx, y: (r.y - d.y) / sy, width: r.width / sx, height: r.height / sy };
}

/**
 * frameRectOf(drawable, el, applied) for many `el` of one drawable while the layout does not change (one synchronous capture): the drawable-level reads (author transform,
 * layer scale, the drawable's own rect) are made once instead of per element, which was most of the cost of a per-row measurement. Same arithmetic, same answers.
 * The returned function takes `sized`: the caller ignores a rect without area, so the laid-out test is skipped (a box without layout measures 0 x 0, which such a caller
 * rejects exactly as it rejects null).
 * @param {Element} drawable
 * @param {DOMMatrixReadOnly|null} applied
 * @returns {(el: Element, sized?: boolean) => Rect|null}
 */
export function frameMeasurerOf(drawable, applied) {
  const k = applied ? axisScale(applied) : (hasAuthorTransform(drawable) ? null : { x: 1, y: 1 });
  if (!k) {
    const size = borderBoxSize(drawable, applied);
    return (el) => (size && isLaidOut(el) ? { x: 0, y: 0, width: size.width, height: size.height } : null);
  }
  const s = layoutScale(layerOf(drawable));
  const sx = s.x * k.x;
  const sy = s.y * k.y;
  const d = drawable.getBoundingClientRect();
  return (el, sized = false) => {
    if (el === drawable) return frameRectOf(drawable, el, applied);
    if (!sized && !isLaidOut(el)) return null;
    const r = el.getBoundingClientRect();
    return { x: (r.x - d.x) / sx, y: (r.y - d.y) / sy, width: r.width / sx, height: r.height / sy };
  };
}

/**
 * Border box of `el` relative to the content box origin of its layer, css px, ignoring ancestor scale. Only valid while `el` carries no polyfill transform.
 * @param {HTMLElement} layerEl
 * @param {Element} el
 * @returns {Rect|null}
 */
export function rectInLayer(layerEl, el) {
  if (!isLaidOut(el)) return null;
  const style = styleOf(layerEl);
  const s = layoutScale(layerEl);
  const lr = layerEl.getBoundingClientRect();
  const ox = lr.x + s.x * (px(style.borderLeftWidth) + px(style.paddingLeft));
  const oy = lr.y + s.y * (px(style.borderTopWidth) + px(style.paddingTop));
  const r = el.getBoundingClientRect();
  const own = hasAuthorTransform(el) ? untransformedBox(el) : null;
  if (own) return { x: (r.x - ox) / s.x - own.x, y: (r.y - oy) / s.y - own.y, width: own.width, height: own.height };
  return { x: (r.x - ox) / s.x, y: (r.y - oy) / s.y, width: r.width / s.x, height: r.height / s.y };
}

/**
 * The element's own CSS transform chain (translate, rotate, scale, transform around transform-origin, CSS Transforms 2 order) as one matrix in its border-box coordinates; null when it cannot be parsed.
 * @param {CSSStyleDeclaration} cs
 * @returns {DOMMatrix|null}
 */
function ownTransformMatrix(cs) {
  const set = (/** @type {string} */ v) => v && v !== 'none';
  const parts = [];
  if (set(cs.translate)) { const [x, y = '0px', z = '0px'] = cs.translate.split(/\s+/); parts.push(`translate3d(${x}, ${y}, ${z})`); }
  if (set(cs.rotate)) {
    const t = cs.rotate.split(/\s+/);
    const axes = /** @type {Record<string, string>} */ ({ x: '1, 0, 0', y: '0, 1, 0', z: '0, 0, 1' });
    parts.push(t.length === 1 ? `rotate(${t[0]})` : t.length === 2 ? `rotate3d(${axes[t[0]] ?? '0, 0, 1'}, ${t[1]})` : `rotate3d(${t[0]}, ${t[1]}, ${t[2]}, ${t[3]})`);
  }
  if (set(cs.scale)) { const [x, y = x, z = '1'] = cs.scale.split(/\s+/); parts.push(`scale3d(${x}, ${y}, ${z})`); }
  if (set(cs.transform)) parts.push(cs.transform);
  try {
    const m = new DOMMatrix(parts.join(' ') || 'none');
    const [ox = 0, oy = 0, oz = 0] = cs.transformOrigin.split(/\s+/).map(px);
    return new DOMMatrix().translate(ox, oy, oz).multiply(m).translate(-ox, -oy, -oz);
  } catch { return null; }
}

/**
 * Layout box of an element with its own CSS transform: its size, and the top-left corner of its transformed bounding box relative to the untransformed border box (so the layout offset is the
 * bounding-box position minus that corner). null when the transform cannot be undone (unparsable, or a point maps to infinity).
 * @param {Element} el
 * @returns {{x: number, y: number, width: number, height: number}|null}
 */
function untransformedBox(el) {
  const cs = styleOf(el);
  const m = ownTransformMatrix(cs);
  const size = layoutSize(el, cs) ?? offsetSize(/** @type {HTMLElement} */ (el));
  if (!m) return null;
  const pts = [[0, 0], [size.width, 0], [0, size.height], [size.width, size.height]].map(([x, y]) => { const p = m.transformPoint(new DOMPoint(x, y)); return [p.x / p.w, p.y / p.w]; });
  const x = Math.min(...pts.map((p) => p[0]));
  const y = Math.min(...pts.map((p) => p[1]));
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y, width: size.width, height: size.height } : null;
}

/** @param {string} list computed box-shadow or text-shadow (no spread) @returns {Insets} extent of the outer shadows beyond the border box (blur reaches ~1.5 radius: 3 sigma of the spec Gaussian) */
function shadowExtent(list) {
  const out = { left: 0, top: 0, right: 0, bottom: 0 };
  if (!list || list === 'none') return out;
  // Computed value: `<color> <x> <y> <blur> <spread> [inset]` per shadow; colours may contain commas inside parentheses.
  for (const one of list.replace(/\([^)]*\)/g, '()').split(',')) {
    if (/\binset\b/.test(one)) continue;
    const [x = 0, y = 0, blur = 0, spread = 0] = (one.match(/-?[\d.]+(?:e-?\d+)?px/g) ?? []).map(px);
    const reach = spread + 1.5 * blur;
    out.left = Math.max(out.left, reach - x); out.right = Math.max(out.right, reach + x);
    out.top = Math.max(out.top, reach - y); out.bottom = Math.max(out.bottom, reach + y);
  }
  return out;
}

/**
 * Ink that an element paints beyond its border box, css px per side (>= 0): outer box-shadow, outline and, with `text`, text-shadow (inherited, so it also covers the text of
 * descendants that do not override it). Damage rects are grown by it (paintInkOf): a changed digit whose glow or offset shadow reached past the damaged box left the old shadow on the surface.
 * @param {CSSStyleDeclaration} cs
 * @param {boolean} text
 * @returns {Insets}
 */
function ownInk(cs, text) {
  const ink = shadowExtent(text ? `${cs.boxShadow},${cs.textShadow}` : cs.boxShadow);
  const o = cs.outlineStyle !== 'none' ? Math.max(0, px(cs.outlineWidth) + px(cs.outlineOffset)) : 0;
  return { left: Math.max(ink.left, o), top: Math.max(ink.top, o), right: Math.max(ink.right, o), bottom: Math.max(ink.bottom, o) };
}

/** ownInk with text-shadow; one computed style, no layout. null when not laid out. @param {Element} el @returns {Insets|null} */
export const paintInkOf = (el) => (isLaidOut(el) ? ownInk(styleOf(el), true) : null);

/**
 * Ink overflow of a drawable beyond its border box, css px per side (>= 0), in the drawable's own coordinates after its own CSS transform: box-shadow, outline, descendants that overflow to the
 * right/bottom of a non-clipping drawable (its scrollable overflow: O(1), descendant shadows and overflow to the left/top are not measured), then the bounding box of that rect under the
 * element's own transform. Cheap: one computed style and scrollWidth/scrollHeight of clean layout. null when not laid out.
 * @param {Element} el
 * @param {boolean} [ownTransform]  false while the computed transform is the polyfill's geometry correction (matrix scheme), not the author's
 * @returns {Insets|null}
 */
export function inkOverflowOf(el, ownTransform = true) {
  if (!isLaidOut(el)) return null;
  const cs = styleOf(el);
  const size = layoutSize(el, cs) ?? offsetSize(/** @type {HTMLElement} */ (el));
  const ink = ownInk(cs, false);
  if (cs.overflowX === 'visible' && cs.overflowY === 'visible' && !/paint|strict|content/.test(cs.contain)) {
    const h = /** @type {HTMLElement} */ (el);
    // scrollWidth is the padding box plus overflow, rounded to whole px: one extra px covers the rounding.
    if (h.scrollWidth > h.clientWidth) ink.right = Math.max(ink.right, h.scrollWidth - h.clientWidth - px(cs.borderRightWidth) + 1);
    if (h.scrollHeight > h.clientHeight) ink.bottom = Math.max(ink.bottom, h.scrollHeight - h.clientHeight - px(cs.borderBottomWidth) + 1);
  }
  const m = ownTransform && hasAuthorTransform(el) ? ownTransformMatrix(cs) : null;
  if (!m) return ink;
  const pts = [[-ink.left, -ink.top], [size.width + ink.right, -ink.top], [-ink.left, size.height + ink.bottom], [size.width + ink.right, size.height + ink.bottom]]
    .map(([x, y]) => { const p = m.transformPoint(new DOMPoint(x, y)); return [p.x / p.w, p.y / p.w]; });
  const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
  const t = { left: -Math.min(...xs), top: -Math.min(...ys), right: Math.max(...xs) - size.width, bottom: Math.max(...ys) - size.height };
  if (![t.left, t.top, t.right, t.bottom].every(Number.isFinite)) return ink;
  return { left: Math.max(0, t.left), top: Math.max(0, t.top), right: Math.max(0, t.right), bottom: Math.max(0, t.bottom) };
}
