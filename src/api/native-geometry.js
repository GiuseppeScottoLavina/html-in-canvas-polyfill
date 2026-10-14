/**
 * Legacy native translation (API-CONTRACT 2.1 rows "drawElementImage", "geometry" and "markup" for the draw side): what the pre-2026-09 native
 * implementation does differently from the standard, expressed through its public API only.
 * Module: api-core (part of the native bridge).
 *
 * Measured on Chrome 154 with --enable-blink-features=CanvasDrawElement:
 *  - drawElementImage returns a DOMMatrix that ALREADY includes the transform-origin compensation; assigning it to element.style.transform lands the element exactly on its drawn pixels;
 *  - updateElementGeometry accepts a dictionary or a matrix; an element is hit-testable only when it was passed to it (any form) AND carries the CSS transform;
 *  - getElementTransform needs two arguments (the standard one-argument form throws "Overload resolution failed").
 * So the standard behaviour is rebuilt with one polyfill-owned adopted stylesheet rule per drawn element (`[data-hic-hit="k"]{transform: ... !important}`),
 * never with the author's style attribute.
 */

import { MARK } from '../contracts/events.js';

/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../contracts/types.js').PatchLedger} PatchLedger */
/** @typedef {Document|ShadowRoot} Scope */

/** @param {unknown} v @returns {v is Element} */
const isElement = (v) => !!v && typeof v === 'object' && /** @type {Node} */ (v).nodeType === 1;

/**
 * @param {HicEnv} env
 * @param {PatchLedger} ledger
 * @param {(canvas: HTMLCanvasElement) => boolean} isStandardCaller  the canvas was activated by content=drawable (a legacy `layoutsubtree` caller keeps the native behaviour)
 * @returns {{dispose: () => void}}
 */
export function installLegacyTranslation(env, ledger, isStandardCaller) {
  const win = /** @type {Window & typeof globalThis} */ (env.window);
  const HIT = MARK.HIT_ATTR;
  /** @type {Map<Scope, {sheet: CSSStyleSheet, rules: Map<string, CSSStyleRule>}>} */
  const scopes = new Map();
  /** @type {WeakMap<Element, {key: string, scope: Scope, matrix: DOMMatrix}>} */
  const applied = new WeakMap();
  /** @type {Set<WeakRef<Element>>} */
  const touched = new Set();
  let serial = 0;

  /** @param {Scope} scope */
  function scopeState(scope) {
    let state = scopes.get(scope);
    if (!state) {
      const sheet = new win.CSSStyleSheet();
      scope.adoptedStyleSheets = [...scope.adoptedStyleSheets, sheet];
      scopes.set(scope, (state = { sheet, rules: new Map() }));
    }
    return state;
  }

  /** @param {Element} el @param {DOMMatrix} matrix */
  function setTransform(el, matrix) {
    const scope = el.getRootNode();
    if (scope.nodeType !== 9 && scope.nodeType !== 11) return;
    const state = scopeState(/** @type {Scope} */ (scope));
    let entry = applied.get(el);
    if (!entry) {
      entry = { key: `l${++serial}`, scope: /** @type {Scope} */ (scope), matrix };
      applied.set(el, entry);
      touched.add(new WeakRef(el));
      el.setAttribute(HIT, entry.key);
      state.sheet.insertRule(`[${HIT}="${entry.key}"]{}`, state.sheet.cssRules.length);
      state.rules.set(entry.key, /** @type {CSSStyleRule} */ (state.sheet.cssRules[state.sheet.cssRules.length - 1]));
    }
    entry.matrix = matrix;
    state.rules.get(entry.key)?.style.setProperty('transform', matrix.toString(), 'important');
  }

  /** @param {Element} el */
  function clearTransform(el) {
    const entry = applied.get(el);
    if (!entry) return;
    applied.delete(el);
    el.removeAttribute(HIT);
    const state = scopes.get(entry.scope);
    const rule = state?.rules.get(entry.key);
    if (state && rule) {
      const index = Array.prototype.indexOf.call(state.sheet.cssRules, rule);
      if (index >= 0) state.sheet.deleteRule(index);
      state.rules.delete(entry.key);
    }
  }

  /** @param {() => void} fn @param {string} where */
  const guarded = (fn, where) => { try { fn(); } catch (err) { env.reporter.caught(err, where); } };

  /** @param {unknown} v @returns {DOMMatrix|null} */
  function toMatrix(v) {
    if (!v || typeof v !== 'object') return null;
    return win.DOMMatrix.fromMatrix(/** @type {DOMMatrixInit} */ (v));
  }

  const canvasProto = win.HTMLCanvasElement.prototype;

  ledger.wrap(canvasProto, 'updateElementGeometry', (orig) => /** @this {HTMLCanvasElement} */ function (/** @type {unknown[]} */ ...args) {
    const result = orig.apply(this, args);
    const [target, options] = args;
    if (isElement(target)) {
      guarded(() => {
        const init = options instanceof win.DOMMatrixReadOnly ? options : /** @type {{canvasTransform?: unknown}|undefined} */ (options)?.canvasTransform;
        const matrix = toMatrix(init) ?? (applied.has(target) ? null : new win.DOMMatrix());
        if (matrix) setTransform(target, matrix);
      }, 'bridge.updateElementGeometry');
    }
    return result;
  });

  ledger.wrap(canvasProto, 'clearElementGeometry', (orig) => /** @this {HTMLCanvasElement} */ function (/** @type {unknown[]} */ ...args) {
    const result = orig.apply(this, args);
    if (isElement(args[0])) guarded(() => clearTransform(/** @type {Element} */ (args[0])), 'bridge.clearElementGeometry');
    return result;
  });

  ledger.wrap(canvasProto, 'getElementTransform', (orig) => /** @this {HTMLCanvasElement} */ function (/** @type {unknown[]} */ ...args) {
    if (args.length === 1 && isElement(args[0])) {
      const entry = applied.get(args[0]);
      return entry ? win.DOMMatrix.fromMatrix(entry.matrix) : new win.DOMMatrix();
    }
    return orig.apply(this, args);
  });

  ledger.wrap(win.CanvasRenderingContext2D.prototype, 'drawElementImage', (orig) => /** @this {CanvasRenderingContext2D} */ function (/** @type {unknown[]} */ ...args) {
    const canvas = this.canvas;
    const target = args[0];
    /** @type {unknown} */
    let result;
    try {
      result = orig.apply(this, args);
    } catch (err) {
      // Reported only when the native call really failed: Chrome 154 with the flag draws deeper descendants fine.
      if (isElement(target) && target.parentElement !== canvas) {
        env.reporter.unsupported({
          feature: 'legacy-native-bridge',
          message: 'the legacy native implementation can only draw DIRECT children of the canvas; this draw of a deeper descendant failed natively',
          hint: 'make the drawn element a direct child of the canvas, or use a native build with the current API',
        }, canvas);
      }
      throw err;
    }
    if (!isStandardCaller(canvas)) return result;
    const options = args.length >= 4 ? args[args.length - 1] : null;
    const preserve = !!options && typeof options === 'object' && /** @type {{preserveElementGeometry?: unknown}} */ (options).preserveElementGeometry === true;
    if (!preserve && isElement(target) && result) guarded(() => /** @type {any} */ (canvas).updateElementGeometry(target, { canvasTransform: /** @type {DOMMatrixInit} */ (result) }), 'bridge.drawElementImage');
    return undefined;
  });

  return {
    dispose() {
      for (const ref of touched) { const el = ref.deref(); if (el) clearTransform(el); }
      touched.clear();
      for (const [scope, { sheet }] of scopes) scope.adoptedStyleSheets = scope.adoptedStyleSheets.filter((s) => s !== sheet);
      scopes.clear();
    },
  };
}
