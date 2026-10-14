/**
 * syncPresentation: canvas -> layer styles, content box measurement.
 * Module: live (src/live/*).
 */

import { BUS } from '../contracts/events.js';
import { layoutSize, styleOf } from './measure.js';
import { layerOpacity } from './layer-style.js';

/** @typedef {import('../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../contracts/types.js').ContentBox} ContentBox */
/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */

/**
 * INHERITED properties that children no longer inherit from the canvas (they are siblings now): the CSS inherited-property list as longhands, minus
 * pointer-events (the layer owns it). container-type/name are not inherited but must sit on the layer for @container rules of the canvas to reach the children.
 */
const INHERITED_PROPS = Object.freeze([
  'font-family', 'font-size', 'font-size-adjust', 'font-weight', 'font-style', 'font-stretch', 'font-kerning', 'font-optical-sizing', 'font-palette', 'font-language-override',
  'font-synthesis-weight', 'font-synthesis-style', 'font-synthesis-small-caps', 'font-feature-settings', 'font-variation-settings',
  'font-variant-caps', 'font-variant-east-asian', 'font-variant-emoji', 'font-variant-ligatures', 'font-variant-numeric', 'font-variant-position',
  'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-align-last', 'text-indent', 'text-justify', 'text-orientation', 'text-rendering', 'text-size-adjust',
  'text-transform', 'text-shadow', 'text-wrap-mode', 'text-wrap-style', 'text-underline-offset', 'text-underline-position', 'text-decoration-skip-ink',
  'text-emphasis-style', 'text-emphasis-color', 'text-emphasis-position', 'white-space-collapse', 'word-break', 'overflow-wrap', 'line-break', 'hyphens', 'hyphenate-character',
  'tab-size', 'quotes', 'orphans', 'widows', 'hanging-punctuation', 'ruby-position',
  'color', '-webkit-text-fill-color', '-webkit-text-stroke-color', '-webkit-text-stroke-width', 'accent-color', 'color-scheme', 'caret-color', 'print-color-adjust',
  'cursor', 'image-rendering', 'image-orientation', 'forced-color-adjust', 'scrollbar-color', 'paint-order', 'empty-cells', 'caption-side', 'border-collapse', 'border-spacing',
  'list-style-type', 'list-style-position', 'list-style-image', 'visibility', 'direction', 'writing-mode', 'fill', 'stroke', 'color-interpolation', 'shape-rendering',
  'container-type', 'container-name',
]);

/** Non-inherited properties of the canvas that are written to the layer verbatim (everything else is written only when it differs from what the layer inherits anyway). */
const OWN_PROPS = new Set(['z-index', 'transform', 'transform-origin', 'translate', 'rotate', 'scale', 'display', 'container-type', 'container-name']);
const TRANSFORM_PROPS = ['transform', 'translate', 'rotate', 'scale'];
const MIRRORED_ATTRS = ['lang', 'dir', 'inert'];
const EPS = 1e-6;
/**
 * Inline copies of the load-bearing sheet declarations: an inline !important beats every author rule, whatever its specificity (`#app > * {margin}`).
 * `display` is NOT pinned: the sheet already says `flow-root !important`, and an inline one would also beat the `@media print` rule that hides the layer.
 */
const PINNED = Object.freeze({ margin: '0', opacity: layerOpacity(), 'pointer-events': 'none', 'box-sizing': 'border-box', overflow: 'clip', contain: 'layout', isolation: 'isolate' });
/** The canvas's computed pointer-events, for the live children (the layer itself is always none): an ancestor with `pointer-events:none` must disable them too. */
const POINTER_VAR = '--hic-pointer-events';

/** @type {WeakMap<HTMLElement, {written: Map<string, string>, foreign: Set<string>}>} what this module wrote to a layer's inline style; `foreign` names belong to other live modules */
const stateOf = new WeakMap();

/** @param {HTMLElement} layerEl */
function inlineState(layerEl) {
  let state = stateOf.get(layerEl);
  if (!state) stateOf.set(layerEl, (state = { written: new Map(), foreign: new Set() }));
  return state;
}

/** @param {string} v @returns {number} */
const px = (v) => parseFloat(v) || 0;

/** @param {CSSStyleDeclaration} style @param {string} name @param {Element} el @returns {string} computed value; line-height keeps a unitless factor (it inherits as a factor) */
function valueOf(style, name, el) {
  if (name === 'line-height') {
    const typed = /** @type {any} */ (el).computedStyleMap?.().get('line-height');
    if (typed) return String(typed);
  }
  return style.getPropertyValue(name);
}

/** @param {Element} canvas @returns {Element|null} the element the layer inherits from */
function inheritanceParent(canvas) {
  if (canvas.parentElement) return canvas.parentElement;
  const root = canvas.getRootNode();
  return /** @type {ShadowRoot} */ (root).host ?? null;
}

/** @param {Map<string, string>} wanted @param {CSSStyleDeclaration} cs */
function boxProps(wanted, cs) {
  for (const side of ['top', 'right', 'bottom', 'left']) {
    wanted.set(`border-${side}-width`, `${px(cs.getPropertyValue(`border-${side}-width`))}px`);
    wanted.set(`padding-${side}`, `${px(cs.getPropertyValue(`padding-${side}`))}px`);
  }
}

/** @param {Map<string, string>} wanted @param {HTMLCanvasElement} canvas @param {CSSStyleDeclaration} cs @param {CSSStyleDeclaration|null} parentStyle */
function ownProps(wanted, canvas, cs, parentStyle) {
  if (cs.display === 'none') wanted.set('display', 'none');
  const positioned = cs.position !== 'static' || /flex|grid/.test(parentStyle?.display ?? '');
  if (positioned && cs.zIndex !== 'auto') wanted.set('z-index', cs.zIndex);
  let transformed = false;
  for (const name of TRANSFORM_PROPS) {
    const value = cs.getPropertyValue(name);
    if (value && value !== 'none') { wanted.set(name, value); transformed = true; }
  }
  if (transformed) {
    wanted.set('transform-origin', cs.transformOrigin);
    pinToTransformedBox(wanted, canvas, cs);
  }
  if (cs.containerType !== 'normal' && cs.containerType) wanted.set('container-type', cs.containerType);
  if (cs.containerName !== 'none' && cs.containerName) wanted.set('container-name', cs.containerName);
}

/** @param {string} value @returns {number[]} numbers in a computed value such as "5px 6px" or "10deg" (angles in degrees) */
function numbers(value) {
  return (value.match(/-?\d*\.?\d+(?:e-?\d+)?/g) ?? []).map(Number);
}

/** @param {CSSStyleDeclaration} cs @returns {DOMMatrix} translate, rotate, scale, transform in CSS order (2D parts only) */
function ownTransform(cs) {
  const m = new DOMMatrix();
  if (cs.translate && cs.translate !== 'none') { const [x = 0, y = 0] = numbers(cs.translate); m.translateSelf(x, y); }
  if (cs.rotate && cs.rotate !== 'none') { const turn = numbers(cs.rotate); m.rotateSelf(turn.at(-1) ?? 0); }
  if (cs.scale && cs.scale !== 'none') { const [x = 1, y = x] = numbers(cs.scale); m.scaleSelf(x, y); }
  return cs.transform && cs.transform !== 'none' ? m.multiplySelf(new DOMMatrix(cs.transform)) : m;
}

/**
 * Anchor positioning follows the TRANSFORMED bounding box of the canvas (and anchor-size reports that box), so the copied transform would apply twice. A transformed canvas therefore gets
 * its untransformed layout size and an anchor offset that cancels the bounding-box shift of its own transform: the same transform then lands on the same pixels.
 * @param {Map<string, string>} wanted @param {HTMLCanvasElement} canvas @param {CSSStyleDeclaration} cs
 */
function pinToTransformedBox(wanted, canvas, cs) {
  const size = layoutSize(canvas, cs);
  if (!size) return;
  const [ox = 0, oy = 0] = numbers(cs.transformOrigin);
  const full = new DOMMatrix().translate(ox, oy).multiply(ownTransform(cs)).translate(-ox, -oy);
  const corners = [[0, 0], [size.width, 0], [0, size.height], [size.width, size.height]].map(([x, y]) => full.transformPoint(new DOMPoint(x, y)));
  const dx = Math.min(...corners.map((p) => p.x / (p.w || 1)));
  const dy = Math.min(...corners.map((p) => p.y / (p.w || 1)));
  wanted.set('width', `${size.width}px`);
  wanted.set('height', `${size.height}px`);
  wanted.set('left', `calc(anchor(left, 0px) - ${dx}px)`);
  wanted.set('top', `calc(anchor(top, 0px) - ${dy}px)`);
}

/** @param {Map<string, string>} wanted @param {HTMLCanvasElement} canvas @param {CSSStyleDeclaration} cs @param {CSSStyleDeclaration|null} parentStyle */
function inheritedProps(wanted, canvas, cs, parentStyle) {
  for (const name of INHERITED_PROPS) {
    if (OWN_PROPS.has(name)) continue;
    const value = valueOf(cs, name, canvas);
    if (!value) continue;
    if (parentStyle && value === valueOf(parentStyle, name, /** @type {Element} */ (inheritanceParent(canvas)))) continue;
    wanted.set(name, value);
  }
}

/** Custom properties whose value differs from what the layer inherits from the shared parent. */
/** @param {Map<string, string>} wanted @param {HTMLCanvasElement} canvas @param {Element|null} parent */
function customProps(wanted, canvas, parent) {
  const read = /** @type {any} */ (canvas).computedStyleMap;
  if (typeof read !== 'function') return;
  const own = read.call(canvas);
  const above = parent ? /** @type {any} */ (parent).computedStyleMap() : null;
  for (const [name, value] of own) {
    if (!name.startsWith('--')) continue;
    const text = String(value);
    if (above && above.has(name) && String(above.get(name)) === text) continue;
    wanted.set(name, text);
  }
}

/** @param {HTMLElement} layerEl @param {Map<string, string>} wanted */
function flush(layerEl, wanted) {
  const { written, foreign } = inlineState(layerEl);
  for (const [name, value] of wanted) {
    if (written.get(name) === value) continue;
    layerEl.style.setProperty(name, value, 'important');
    written.set(name, value);
  }
  for (const name of [...written.keys()]) {
    if (wanted.has(name) || foreign.has(name)) continue;
    layerEl.style.removeProperty(name);
    written.delete(name);
  }
}

/** @param {HTMLCanvasElement} canvas @param {HTMLElement} layerEl */
function mirrorAttributes(canvas, layerEl) {
  for (const name of MIRRORED_ATTRS) {
    const value = canvas.getAttribute(name);
    if (value === null) { if (layerEl.hasAttribute(name)) layerEl.removeAttribute(name); } else if (layerEl.getAttribute(name) !== value) layerEl.setAttribute(name, value);
  }
}

/** @param {HTMLCanvasElement} canvas @param {CSSStyleDeclaration} cs @param {ContentBox} previous @returns {ContentBox} */
function measureContentBox(canvas, cs, previous) {
  const border = layoutSize(canvas, cs);
  if (!border || canvas.getClientRects().length === 0) return previous;
  const width = Math.max(0, border.width - px(cs.paddingLeft) - px(cs.paddingRight) - px(cs.borderLeftWidth) - px(cs.borderRightWidth));
  const height = Math.max(0, border.height - px(cs.paddingTop) - px(cs.paddingBottom) - px(cs.borderTopWidth) - px(cs.borderBottomWidth));
  return { width, height, gridScaleX: width > EPS ? canvas.width / width : 1, gridScaleY: height > EPS ? canvas.height / height : 1 };
}

/** @param {ContentBox} a @param {ContentBox} b */
const sameBox = (a, b) => Math.abs(a.width - b.width) < EPS && Math.abs(a.height - b.height) < EPS
  && Math.abs(a.gridScaleX - b.gridScaleX) < EPS && Math.abs(a.gridScaleY - b.gridScaleY) < EPS;

/**
 * Read the canvas (computed style), write border/padding/own props/inherited props/mirrored custom properties to layerEl with setProperty(..., 'important'),
 * set position-anchor:--hic-<id> inline on the layer, update record.contentBox and return it (css size + gridScale). BUS.RESIZE is emitted when an already measured box changes.
 * Border/padding changes do not resize the box: they are caught by attribute observation and the event-driven re-checks of schedule/observers/presentation-watch.js (a cheap computed-style compare; no idle timer).
 * Cheap when nothing changed (compare against the last written values).
 * @param {HicEnv} env
 * @param {CanvasRecord} record
 * @param {HTMLElement} layerEl
 * @returns {ContentBox}
 */
export function syncPresentation(env, record, layerEl) {
  const canvas = record.canvas;
  const cs = styleOf(canvas);
  /** @type {Map<string, string>} */
  const wanted = new Map([['position-anchor', `--hic-${record.id}`], ...Object.entries(PINNED)]);
  if (canvas.isConnected && cs.display !== '') {
    const parent = inheritanceParent(canvas);
    const parentStyle = parent ? styleOf(parent) : null;
    boxProps(wanted, cs);
    wanted.set(POINTER_VAR, cs.pointerEvents);
    ownProps(wanted, canvas, cs, parentStyle);
    inheritedProps(wanted, canvas, cs, parentStyle);
    customProps(wanted, canvas, parent);
  } else {
    for (const [name, value] of inlineState(layerEl).written) wanted.set(name, value);
  }
  flush(layerEl, wanted);
  mirrorAttributes(canvas, layerEl);
  const previous = record.contentBox;
  const next = measureContentBox(canvas, cs, previous);
  if (next !== previous && !sameBox(next, previous)) {
    record.contentBox = next;
    if (previous.width > 0 || previous.height > 0) env.bus.emit(BUS.RESIZE, { record, contentBox: next, previous });
  }
  return record.contentBox;
}

/** @param {HTMLElement} layerEl forget what was written and clear the inline style (a re-mounted layer starts clean) */
export function resetLayerStyle(layerEl) {
  stateOf.delete(layerEl);
  layerEl.removeAttribute('style');
}

/**
 * Let another live module (ancestor-clip) write one inline declaration on the layer that syncPresentation must neither clear nor overwrite.
 * @param {HTMLElement} layerEl
 * @param {string} name
 * @param {string|null} value  null removes
 */
export function setLayerDeclaration(layerEl, name, value) {
  const { written, foreign } = inlineState(layerEl);
  foreign.add(name);
  if (value === null) {
    layerEl.style.removeProperty(name);
    written.delete(name);
  } else if (written.get(name) !== value) {
    layerEl.style.setProperty(name, value, 'important');
    written.set(name, value);
  }
}
