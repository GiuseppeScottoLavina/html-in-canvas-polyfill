/**
 * CanvasPaintEvent, ElementGeometryUpdateEvent and the SchedulerHooks implementation (the only code that constructs/dispatches spec events).
 * Also the event-handler IDL attribute machinery (`onpaint`, `onelementgeometryupdate`: property, content attribute compiled lazily, one dispatching listener per canvas).
 * Events created by the polyfill are not trusted (`isTrusted === false`, deviation event-untrusted): userland cannot create trusted events.
 * Module: api-surface (src/api/*).
 */

import { EVENTS } from '../contracts/events.js';

/** @typedef {import('../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../contracts/types.js').SchedulerHooks} SchedulerHooks */

/**
 * @param {unknown} list  sequence<Element>
 * @param {string} what  member name for the error message
 * @returns {ReadonlyArray<Element>}
 */
function frozenList(list, what) {
  if (list === undefined) return Object.freeze([]);
  if (list === null || typeof (/** @type {any} */ (list))[Symbol.iterator] !== 'function') throw new TypeError(`The '${what}' member is not a sequence.`);
  return Object.freeze(Array.from(/** @type {Iterable<Element>} */ (list)));
}

export class CanvasPaintEvent extends Event {
  /** @type {ReadonlyArray<Element>} */
  #changedElements;

  /** @param {string} type @param {{changedElements?: Element[], bubbles?: boolean, cancelable?: boolean, composed?: boolean}} [init] */
  constructor(type, init) {
    if (arguments.length === 0) throw new TypeError("Failed to construct 'CanvasPaintEvent': 1 argument required, but only 0 present.");
    super(type, init);
    this.#changedElements = frozenList(init?.changedElements, 'changedElements');
  }

  /** [SameObject] frozen array. @returns {ReadonlyArray<Element>} */
  get changedElements() {
    return this.#changedElements;
  }
}
Object.defineProperty(CanvasPaintEvent.prototype, Symbol.toStringTag, { value: 'CanvasPaintEvent', configurable: true });

export class ElementGeometryUpdateEvent extends Event {
  /** @type {ReadonlyArray<Element>} */
  #elements;

  /** @param {string} type @param {{elements?: Element[], bubbles?: boolean, cancelable?: boolean, composed?: boolean}} [init] */
  constructor(type, init) {
    if (arguments.length === 0) throw new TypeError("Failed to construct 'ElementGeometryUpdateEvent': 1 argument required, but only 0 present.");
    super(type, init);
    this.#elements = frozenList(init?.elements, 'elements');
  }

  /** @returns {ReadonlyArray<Element>} */
  get elements() {
    return this.#elements;
  }
}
Object.defineProperty(ElementGeometryUpdateEvent.prototype, Symbol.toStringTag, { value: 'ElementGeometryUpdateEvent', configurable: true });

// ---------------------------------------------------------------------------------------------- event handler IDL attributes

/**
 * @typedef {Object} HandlerSlot
 * @property {Function|null} fn          value set through the IDL property
 * @property {boolean} explicit          the IDL property was assigned
 * @property {string|null} attrAtSet     content attribute value at that moment: a later attribute change supersedes the property (HTML event handler processing)
 * @property {{code: string, fn: Function|null}|null} compiled  last compiled content attribute
 * @property {boolean} listening         the dispatching listener is attached
 */

/** @type {WeakMap<EventTarget, Map<string, HandlerSlot>>} */
const slots = new WeakMap();
/** @type {WeakMap<HicEnv, Array<{target: EventTarget, type: string, listener: EventListener}>>} dispatching listeners of one install, removed by disposeHandlers */
const attached = new WeakMap();
/** @type {WeakSet<CanvasRecord>} records whose paint event is being dispatched right now */
const dispatching = new WeakSet();

/** @param {CanvasRecord} record @returns {boolean} a paint event of this canvas is being dispatched (the handlers are running) */
export function isPaintDispatching(record) {
  return dispatching.has(record);
}

/** @param {EventTarget} target @param {string} type @returns {HandlerSlot} */
function slotOf(target, type) {
  let perTarget = slots.get(target);
  if (!perTarget) slots.set(target, perTarget = new Map());
  let slot = perTarget.get(type);
  if (!slot) perTarget.set(type, slot = { fn: null, explicit: false, attrAtSet: null, compiled: null, listening: false });
  return slot;
}

/**
 * Current value of the `on<type>` handler: the property if it was assigned and the content attribute did not change since, else the lazily
 * compiled content attribute (a CSP or Trusted Types block of `new Function` is reported, never silent), else null.
 * @param {HicEnv} env
 * @param {HTMLElement} target
 * @param {string} type
 * @returns {Function|null}
 */
export function getEventHandler(env, target, type) {
  const slot = slotOf(target, type);
  const name = `on${type}`;
  const attr = target.getAttribute(name);
  if (slot.explicit && slot.attrAtSet === attr) return slot.fn;
  if (attr === null) return null;
  if (!slot.compiled || slot.compiled.code !== attr) {
    /** @type {Function|null} */
    let fn = null;
    try {
      fn = new (/** @type {typeof globalThis} */ (/** @type {unknown} */ (env.window)).Function)('event', attr);
    } catch (err) {
      env.reporter.caught(err, `${name}-attribute`);
    }
    slot.compiled = { code: attr, fn };
  }
  return slot.compiled.fn;
}

/**
 * IDL setter: non-callable values coerce to null.
 * @param {HicEnv} env
 * @param {HTMLElement} target
 * @param {string} type
 * @param {unknown} value
 */
export function setEventHandler(env, target, type, value) {
  const slot = slotOf(target, type);
  slot.fn = typeof value === 'function' ? /** @type {Function} */ (value) : null;
  slot.explicit = true;
  slot.attrAtSet = target.getAttribute(`on${type}`);
  ensureHandlerListener(env, target, type);
}

/**
 * Attach the one listener that runs the `on<type>` handler (idempotent). It is attached at the first assignment or at the first dispatch,
 * so a handler set through a content attribute sits after listeners added earlier (documented ordering deviation of the polyfill).
 * @param {HicEnv} env
 * @param {HTMLElement} target
 * @param {string} type
 */
export function ensureHandlerListener(env, target, type) {
  const slot = slotOf(target, type);
  if (slot.listening) return;
  slot.listening = true;
  /** @type {EventListener} */
  const listener = function (event) {
    const fn = getEventHandler(env, target, type);
    if (fn && fn.call(target, event) === false) event.preventDefault();
  };
  target.addEventListener(type, listener);
  let list = attached.get(env);
  if (!list) attached.set(env, list = []);
  list.push({ target, type, listener });
}

/** Uninstall: remove every dispatching listener and forget the handler state, so `onpaint` is the platform's plain property again. @param {HicEnv} env */
export function disposeHandlers(env) {
  for (const { target, type, listener } of attached.get(env) ?? []) {
    target.removeEventListener(type, listener);
    slots.get(target)?.delete(type);
  }
  attached.delete(env);
}

// ---------------------------------------------------------------------------------------------- dispatch

/**
 * Dispatch an `elementgeometryupdate` event (Offscreen batches, section 5.2) at the HTMLCanvasElement.
 * @param {HicEnv} env
 * @param {HTMLCanvasElement} canvas
 * @param {Element[]} elements
 */
export function fireGeometryUpdate(env, canvas, elements) {
  ensureHandlerListener(env, canvas, EVENTS.ELEMENT_GEOMETRY_UPDATE);
  try {
    canvas.dispatchEvent(new ElementGeometryUpdateEvent(EVENTS.ELEMENT_GEOMETRY_UPDATE, { elements }));
  } catch (err) {
    env.reporter.caught(err, 'elementgeometryupdate-dispatch');
  }
}

/** @type {WeakSet<HTMLCanvasElement>} unmanaged canvases with a requestPaint() waiting for the next frame */
const idlePaints = new WeakSet();

/**
 * requestPaint() on a canvas that is not content=drawable: native still fires one `paint` event (no changed elements) at the next rendering opportunity (WPT get-element-transform, which removes `content` and waits for a paint).
 * @param {HicEnv} env
 * @param {HTMLCanvasElement} canvas
 */
export function requestIdlePaint(env, canvas) {
  if (!canvas.isConnected || idlePaints.has(canvas)) return;
  idlePaints.add(canvas);
  env.window.requestAnimationFrame(() => {
    idlePaints.delete(canvas);
    if (!canvas.isConnected || env.registry.get(canvas)?.state === 'active') return;
    ensureHandlerListener(env, canvas, EVENTS.PAINT);
    try {
      canvas.dispatchEvent(new CanvasPaintEvent(EVENTS.PAINT, { changedElements: [] }));
    } catch (err) {
      env.reporter.caught(err, 'paint-dispatch');
    }
  });
}

/**
 * firePaint: build CanvasPaintEvent(type "paint", frozen changedElements), dispatch on record.canvas; dispatch is exception-safe (a handler error is reported by the platform, never thrown into the scheduler).
 * @param {HicEnv} env
 * @returns {SchedulerHooks}
 */
export function createSchedulerHooks(env) {
  return {
    firePaint(record, changed) {
      const canvas = record.canvas;
      ensureHandlerListener(env, canvas, EVENTS.PAINT);
      dispatching.add(record);
      try {
        canvas.dispatchEvent(new CanvasPaintEvent(EVENTS.PAINT, { changedElements: changed }));
      } catch (err) {
        env.reporter.caught(err, 'paint-dispatch');
      } finally {
        dispatching.delete(record);
      }
    },
  };
}

/**
 * Define window.CanvasPaintEvent / ElementGeometryUpdateEvent only when absent.
 * @param {Window} win
 * @param {import('../contracts/types.js').PatchLedger} ledger
 */
export function defineEventGlobals(win, ledger) {
  for (const [name, value] of /** @type {Array<[string, Function]>} */ ([['CanvasPaintEvent', CanvasPaintEvent], ['ElementGeometryUpdateEvent', ElementGeometryUpdateEvent]])) {
    if (!(name in win)) ledger.define(win, name, { value, writable: true, configurable: true, enumerable: false });
  }
}
