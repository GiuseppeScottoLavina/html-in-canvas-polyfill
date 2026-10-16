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
 * A legacy build may lack the geometry methods altogether: Safari Technology Preview 254 with Debug > WebKit Internal Features > HTML-in-Canvas, measured live
 * 2026-10-16 (no updateElementGeometry / clearElementGeometry). There drawElementImage returns an identity matrix wherever it draws, the children stay
 * hit-testable at their layout boxes, ANY css transform on a drawn child (an identity matrix included) makes the build draw nothing for it, and a draw
 * without a destination size draws css px as grid px (half size on a DPR 2 grid). So on that shape the bridge writes no transform rule (hit testing stays
 * at the layout box) and gives a sizeless draw the standard size (the border box at the canvas grid scale).
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
  const nativeGeometry = typeof Object.getOwnPropertyDescriptor(canvasProto, 'updateElementGeometry')?.value === 'function';

  /**
   * (element, dx, dy[, options]) -> (element, dx, dy, dw, dh) with the standard default size: the border box in css px times the canvas grid scale.
   * @param {HTMLCanvasElement} canvas @param {Element} el @param {unknown[]} args @returns {unknown[]}
   */
  function withStandardSize(canvas, el, args) {
    const last = args[args.length - 1];
    const options = args.length > 3 && !!last && typeof last === 'object';
    if (args.length - 1 - (options ? 1 : 0) !== 2) return args;
    const box = el.getBoundingClientRect();
    const outer = canvas.getBoundingClientRect();
    const cs = win.getComputedStyle(canvas);
    const px = (/** @type {string} */ v) => parseFloat(v) || 0;
    const cw = outer.width - px(cs.borderLeftWidth) - px(cs.borderRightWidth) - px(cs.paddingLeft) - px(cs.paddingRight);
    const ch = outer.height - px(cs.borderTopWidth) - px(cs.borderBottomWidth) - px(cs.paddingTop) - px(cs.paddingBottom);
    return [el, args[1], args[2], box.width * (cw > 0 ? canvas.width / cw : 1), box.height * (ch > 0 ? canvas.height / ch : 1)];
  }

  /** @param {object} proto @param {string} key @param {(orig: Function) => Function} wrapper  wrap a method only where this build has it */
  const wrapIfPresent = (proto, key, wrapper) => { if (typeof Object.getOwnPropertyDescriptor(proto, key)?.value === 'function') ledger.wrap(proto, key, wrapper); };

  wrapIfPresent(canvasProto, 'updateElementGeometry', (orig) => /** @this {HTMLCanvasElement} */ function (/** @type {unknown[]} */ ...args) {
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

  wrapIfPresent(canvasProto, 'clearElementGeometry', (orig) => /** @this {HTMLCanvasElement} */ function (/** @type {unknown[]} */ ...args) {
    const result = orig.apply(this, args);
    if (isElement(args[0])) guarded(() => clearTransform(/** @type {Element} */ (args[0])), 'bridge.clearElementGeometry');
    return result;
  });

  wrapIfPresent(canvasProto, 'getElementTransform', (orig) => /** @this {HTMLCanvasElement} */ function (/** @type {unknown[]} */ ...args) {
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
      result = orig.apply(this, !nativeGeometry && isElement(target) && isStandardCaller(canvas) ? withStandardSize(canvas, target, args) : args);
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
    if (!nativeGeometry) return undefined;
    const options = args.length >= 4 ? args[args.length - 1] : null;
    const preserve = !!options && typeof options === 'object' && /** @type {{preserveElementGeometry?: unknown}} */ (options).preserveElementGeometry === true;
    if (!preserve && isElement(target) && result) {
      guarded(() => {
        const update = /** @type {any} */ (canvas).updateElementGeometry;
        if (typeof update === 'function') update.call(canvas, target, { canvasTransform: /** @type {DOMMatrixInit} */ (result) });
        else { const matrix = toMatrix(result); if (matrix) setTransform(target, matrix); }
      }, 'bridge.drawElementImage');
    }
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
