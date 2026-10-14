// Shared test scaffolding for the live module's browser tests (not a test file).
import { fixture } from '/test/unit/lib/t.js';
import { createBus } from '/src/util/bus.js';
import { resolveOptions } from '/src/api/options.js';
import { createPatchLedger } from '/src/api/patch.js';
import { createRootScope } from '/src/live/root-scope.js';
import { createLiveLayer } from '/src/live/live-layer.js';

/**
 * A HicEnv with real bus, ledger and root scope; registry, reporter and record creation are tiny stand-ins.
 * @param {{t: {cleanup: (fn: () => any) => void}, options?: object}} args
 */
export function setup({ t, options = {} }) {
  const reports = { unsupported: /** @type {any[]} */ ([]), deviation: /** @type {any[]} */ ([]), caught: /** @type {any[]} */ ([]) };
  const records = /** @type {any[]} */ ([]);
  const bus = createBus();
  const ledger = createPatchLedger(window);
  const env = /** @type {any} */ ({
    window, document, options: resolveOptions(options), bus,
    reporter: {
      unsupported: (/** @type {any} */ e) => reports.unsupported.push(e),
      deviation: (/** @type {string} */ id, /** @type {string} */ detail) => reports.deviation.push({ id, detail }),
      caught: (/** @type {unknown} */ err, /** @type {string} */ where) => reports.caught.push({ err, where }),
      entries: () => [],
    },
    now: () => performance.now(),
    registry: { all: () => records, get: (/** @type {any} */ c) => records.find((r) => r.canvas === c) },
    isManagedLayerNode: (/** @type {Element} */ el) => el.hasAttribute('data-hic-node'),
  });
  env.roots = createRootScope(env, ledger);
  let nextId = 0;
  /** Build a record for `canvas` (not mounted yet). */
  function record(/** @type {HTMLCanvasElement} */ canvas, legacy = false) {
    const r = /** @type {any} */ ({
      id: ++nextId, canvas, state: 'active', legacy, root: env.roots.rootOf(canvas), layer: null,
      contentBox: { width: 0, height: 0, gridScaleX: 1, gridScaleY: 1 },
    });
    r.layer = createLiveLayer(env, r);
    records.push(r);
    return r;
  }
  /** Build and mount. */
  function managed(/** @type {HTMLCanvasElement} */ canvas, legacy = false) {
    const r = record(canvas, legacy);
    r.layer.mount();
    return r;
  }
  t.cleanup(() => {
    for (const r of records) r.layer.dispose();
    env.roots.dispose();
    ledger.restoreAll();
  });
  return { env, reports, records, ledger, bus, record, managed };
}

/** A container with a canvas (`<canvas id="c" content="drawable" width=300 height=150 style=...>children</canvas>`) and the canvas element. */
export function page(/** @type {string} */ canvasHtml = '', /** @type {string} */ canvasStyle = '', /** @type {string} */ before = '', /** @type {string} */ after = '', /** @type {Partial<CSSStyleDeclaration>} */ containerStyle = {}) {
  const root = fixture(`${before}<canvas id="c" width="300" height="150" style="${canvasStyle}">${canvasHtml}</canvas>${after}`, containerStyle);
  return { root, canvas: /** @type {HTMLCanvasElement} */ (root.querySelector('#c')) };
}

/** @param {Element} el @returns {{x: number, y: number, width: number, height: number}} */
export function rect(el) {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

/** content box rect of an element in viewport px */
export function contentRect(/** @type {Element} */ el) {
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  const p = (/** @type {string} */ v) => parseFloat(v) || 0;
  return {
    x: r.x + p(s.borderLeftWidth) + p(s.paddingLeft), y: r.y + p(s.borderTopWidth) + p(s.paddingTop),
    width: r.width - p(s.borderLeftWidth) - p(s.borderRightWidth) - p(s.paddingLeft) - p(s.paddingRight),
    height: r.height - p(s.borderTopWidth) - p(s.borderBottomWidth) - p(s.paddingTop) - p(s.paddingBottom),
  };
}

/** @param {{x:number,y:number,width:number,height:number}} a @param {{x:number,y:number,width:number,height:number}} b @param {number} tol */
export function closeRect(a, b, tol = 0.01) {
  return ['x', 'y', 'width', 'height'].every((k) => Math.abs(/** @type {any} */ (a)[k] - /** @type {any} */ (b)[k]) <= tol);
}
