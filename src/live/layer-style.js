/**
 * The polyfill stylesheet (adopted, one per TREE SCOPE: document and every shadow root that holds a managed canvas): layer rules, per-canvas anchor rule, hit rule, [drawable] rules, print rule, plus the
 * geometry rules sheet (ADR-F). Load-bearing layer declarations are !important and the element is an unknown tag, so author rules (`.stack > * {margin}`, Tailwind space-y, `div:last-child`) cannot displace it (ADR-A).
 * Module: live (src/live/*).
 */

import { createGeometryRules, markOwnedSheet } from './geometry-sheet.js';
import { currentEngine } from '../util/engine.js';

/** @typedef {import('../contracts/types.js').LayerStyleHandle} LayerStyleHandle */
/** @typedef {import('../contracts/types.js').GeometryRules} GeometryRules */

/** @param {number} id @returns {string} the per-canvas rule */
export function anchorRule(id) {
  return `canvas[data-hic-canvas="${id}"]{anchor-name:--hic-${id} !important}`;
}

/** Static rules (ADR-A / ADR-F / ADR-L). The anchor() fallbacks (0px) matter on WebKit: a layout forced while the anchor is momentarily unresolved (a style write in a ResizeObserver
 * callback) placed the layer at its static position below the canvas, which grew the page by a classic scrollbar and raised 'ResizeObserver loop completed' in the app (ADR X-11). Per-layer inline custom values (position-anchor, copied presentation, fixed, clip-path) are written by presentation.js and ancestor-clip.js with setProperty(..., 'important'). The ::after rule generates no box: it is the unitless line-height probe of capture/clone.js on engines without computedStyleMap. */
export const LAYER_CSS = `
hic-layer[data-hic-layer]{position:absolute !important;box-sizing:border-box !important;margin:0 !important;border:0 solid transparent;display:grid !important;grid-template:100% / 100% !important;align-items:start !important;opacity:0 !important;
  pointer-events:none !important;overflow:clip !important;contain:layout !important;overflow-anchor:none !important;isolation:isolate !important;
  top:anchor(top, 0px) !important;left:anchor(left, 0px) !important;width:anchor-size(width, 0px) !important;height:anchor-size(height, 0px) !important;position-visibility:anchors-visible}
hic-layer[data-hic-layer]::after{content:none !important;font-size:200% !important}
hic-layer[data-hic-layer] [data-hic-hit]{pointer-events:var(--hic-pointer-events, auto)}
hic-layer[data-hic-layer] [drawable]{isolation:isolate !important;contain:layout}
:where(hic-layer[data-hic-layer] > *){position:static !important;grid-area:1 / 1 !important;margin:0 !important;justify-self:start !important;align-self:start !important}
@media print{hic-layer[data-hic-layer]{display:none !important}}
`;

/**
 * Gecko (Firefox 155) builds no display items for an opacity:0 subtree, so its async scrolling never finds the live scrollers: a trusted wheel over the
 * canvas reached the live row (event target right) and scrolled nothing (G-xbrowser). 0.001 rounds to 0 in 8-bit compositing (0.255 of a level) and keeps
 * the layer in the hit-test tree. Not feature-detectable without a trusted wheel, hence the engine switch; Chromium keeps opacity:0.
 */
export const GECKO_LAYER_OPACITY = '0.001';

/** @returns {string} the opacity of the live layer on the running engine (presentation.js pins it inline too) */
export function layerOpacity() {
  return currentEngine().engine === 'gecko' ? GECKO_LAYER_OPACITY : '0';
}

/** @returns {string} the layer sheet text for the running engine */
export function layerCss() {
  const opacity = layerOpacity();
  return opacity === '0' ? LAYER_CSS : `${LAYER_CSS}hic-layer[data-hic-layer]{opacity:${opacity} !important}\n`;
}

/**
 * @typedef {Object} RootStyle  shared state of one tree scope
 * @property {number} count live handles
 * @property {CSSStyleSheet} layerSheet
 * @property {CSSStyleSheet} geometrySheet
 * @property {GeometryRules} rules
 * @property {Map<number, CSSRule>} anchors
 */

/** @type {WeakMap<Document|ShadowRoot, RootStyle>} */
const perRoot = new WeakMap();

/** @param {Document|ShadowRoot} root @returns {typeof globalThis} */
function windowOf(root) {
  const doc = root.nodeType === 9 ? /** @type {Document} */ (root) : /** @type {ShadowRoot} */ (root).host.ownerDocument;
  return /** @type {typeof globalThis} */ (/** @type {unknown} */ (doc.defaultView ?? globalThis));
}

/** @param {Document|ShadowRoot} root @returns {RootStyle} */
function acquire(root) {
  let state = perRoot.get(root);
  if (!state) {
    const CSSSheet = windowOf(root).CSSStyleSheet;
    const layerSheet = markOwnedSheet(new CSSSheet());
    layerSheet.replaceSync(layerCss());
    const geometrySheet = new CSSSheet();
    state = { count: 0, layerSheet, geometrySheet, rules: createGeometryRules(geometrySheet), anchors: new Map() };
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, layerSheet, geometrySheet];
    perRoot.set(root, state);
  }
  state.count++;
  return state;
}

/** @param {Document|ShadowRoot} root @param {RootStyle} state */
function release(root, state) {
  if (--state.count > 0) return;
  root.adoptedStyleSheets = root.adoptedStyleSheets.filter((s) => s !== state.layerSheet && s !== state.geometrySheet);
  perRoot.delete(root);
}

/** @param {RootStyle} state @param {CSSRule} rule */
function deleteRule(state, rule) {
  const list = state.layerSheet.cssRules;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === rule) { state.layerSheet.deleteRule(i); return; }
  }
}

/**
 * Install LAYER_CSS (+ per-canvas anchor rules as records come and go) and the geometry sheet into `root` (adoptedStyleSheets); reference counted per root; dispose removes only polyfill-owned sheets.
 * @param {Document|ShadowRoot} root
 * @returns {LayerStyleHandle}
 */
export function installLayerStyle(root) {
  const state = acquire(root);
  /** @type {Set<number>} */
  const mine = new Set();
  let disposed = false;

  /** @param {number} id */
  function remove(id) {
    if (!mine.delete(id)) return;
    const rule = state.anchors.get(id);
    if (rule) deleteRule(state, rule);
    state.anchors.delete(id);
  }

  return {
    add(id) {
      if (disposed || mine.has(id)) return;
      mine.add(id);
      const sheet = state.layerSheet;
      const index = sheet.insertRule(anchorRule(id), sheet.cssRules.length);
      state.anchors.set(id, sheet.cssRules[index]);
    },
    remove,
    geometry: state.rules,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const id of [...mine]) remove(id);
      release(root, state);
    },
  };
}
