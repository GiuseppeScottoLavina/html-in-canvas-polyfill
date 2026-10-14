/**
 * A <canvas> inside a drawable that the page redraws by script (chart libraries, spinners drawn on a canvas) -> damage of the drawable that holds it.
 * Nothing in the DOM changes when a canvas bitmap does, so the drawing methods of the 2D and WebGL contexts are wrapped (through the install's ledger) and a call on a canvas that sits in a live layer marks its drawable.
 * Cost: one wrapper call, one WeakMap read and a clock read per drawing call on ANY canvas of the page; the layer lookup behind it is cached for CACHE_MS per canvas. Damage is coalesced to one scheduler call per microtask.
 * Module: schedule (src/schedule/observers/*).
 */

import { BUS, MARK } from '../../contracts/events.js';

/** @typedef {import('../../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../../contracts/types.js').PatchLedger} PatchLedger */

/** A canvas moved into or out of a drawable is noticed at the latest after this long. */
const CACHE_MS = 100;
const METHODS_2D = ['fillRect', 'strokeRect', 'clearRect', 'fill', 'stroke', 'fillText', 'strokeText', 'drawImage', 'putImageData', 'drawElementImage'];
const METHODS_GL = ['clear', 'drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements'];

/** @typedef {{record: CanvasRecord, drawable: Element}|null} Owner */

/**
 * @param {HicEnv} env
 * @param {PatchLedger} ledger
 * @returns {() => void}
 */
export function observeChildCanvases(env, ledger) {
  const win = /** @type {any} */ (env.window);
  let live = true;
  // The tree facade of a layer child reports the canvas as its parent: climb with the platform getter.
  const parentOf = /** @type {(this: Node) => Node|null} */ (/** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(win.Node.prototype, 'parentNode')).get);
  /** @type {WeakMap<object, {at: number, owner: Owner}>} */
  let cache = new WeakMap();
  // A drawable added to a canvas (a WebGL canvas moved into one, WPT moved-webgl-canvas) is looked up afresh: a cached "not in a layer" answer would hide its next draw for up to CACHE_MS.
  const offDrawables = env.bus.on(BUS.DRAWABLES_CHANGED, () => { cache = new WeakMap(); });
  /** @type {Map<Element, CanvasRecord>} */
  const pending = new Map();

  /** @param {HTMLCanvasElement} canvas @returns {Owner} */
  function resolve(canvas) {
    for (let node = parentOf.call(canvas); node && node.nodeType === 1; node = parentOf.call(node)) {
      if (/** @type {Element} */ (node).localName !== MARK.LAYER_TAG) continue;
      const record = env.registry.all().find((r) => r.layer?.element === node && r.state === 'active');
      const drawable = record?.layer?.nearestDrawable(canvas);
      return record && drawable ? { record, drawable } : null;
    }
    return null;
  }

  /** @param {unknown} canvas */
  function touched(canvas) {
    if (!live || !canvas) return;
    const now = env.now();
    let entry = cache.get(/** @type {object} */ (canvas));
    if (!entry || now - entry.at > CACHE_MS) {
      entry = { at: now, owner: resolve(/** @type {HTMLCanvasElement} */ (canvas)) };
      cache.set(/** @type {object} */ (canvas), entry);
    }
    if (!entry.owner) return;
    if (!pending.size) queueMicrotask(flush);
    pending.set(entry.owner.drawable, entry.owner.record);
  }

  function flush() {
    const list = [...pending];
    pending.clear();
    if (!live) return;
    for (const [drawable, record] of list) {
      if (record.state === 'active') env.scheduler.damage(record, 'mutation', drawable, null);
    }
  }

  /** @param {object|undefined} proto @param {string[]} names */
  function wrapAll(proto, names) {
    if (!proto) return;
    for (const name of names) {
      if (typeof Object.getOwnPropertyDescriptor(proto, name)?.value !== 'function') continue;
      ledger.wrap(proto, name, (original) => /** @this {{canvas?: unknown}} */ function (/** @type {unknown[]} */ ...args) {
        const result = Reflect.apply(original, this, args);
        touched(this.canvas);
        return result;
      });
    }
  }

  wrapAll(win.CanvasRenderingContext2D?.prototype, METHODS_2D);
  wrapAll(win.WebGLRenderingContext?.prototype, METHODS_GL);
  wrapAll(win.WebGL2RenderingContext?.prototype, METHODS_GL);
  return () => { live = false; pending.clear(); offDrawables(); };
}
