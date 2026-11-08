/**
 * canvas.addEventListener bridge: listeners on the canvas also receive bubbling events of relocated descendants (currentTarget AND composedPath() overridden: the layer entry is replaced by the canvas), and the `on*` event-handler IDL
 * properties of the canvas (`canvas.onclick = fn`, from the HTMLElement/GlobalEventHandlers descriptor table) are instance accessors that register one bridge listener on the layer.
 * Module: live (src/live/*).
 *
 * Only listeners registered while the canvas is managed are bridged (the bridge cannot enumerate listeners that were added natively before); they stay registered
 * natively on the canvas, so an unmount hands them back to the canvas together with its children.
 */

import { EVENTS } from '../contracts/events.js';
import { createOwnProps } from './tree-facade.js';

/** Events dispatched at the canvas itself by the polyfill: they never bubble up from children. */
/** @type {Set<string>} */
const OWN_EVENTS = new Set([EVENTS.PAINT, EVENTS.ELEMENT_GEOMETRY_UPDATE, EVENTS.UNSUPPORTED, EVENTS.EFFECT_FRAME, EVENTS.EFFECT_ERROR]);

/**
 * @typedef {Object} Entry
 * @property {EventListenerOrEventListenerObject} listener
 * @property {boolean} once
 * @property {AbortSignal|null} signal
 * @property {boolean} passive  registered with `passive: true` (the canvas is not the window, the document or the body: `passive` left out means false there)
 */

/** @type {WeakMap<HTMLCanvasElement, Map<string, Entry[]>>} listeners per canvas, kept across unmount/mount so a toggled canvas keeps its bridge */
const registries = new WeakMap();

/** @type {Array<{name: string, desc: PropertyDescriptor}>|null} */
let handlerTable = null;

/** @param {HTMLCanvasElement} canvas the `on*` accessors on the canvas prototype chain, resolved once */
function handlerDescriptors(canvas) {
  if (handlerTable) return handlerTable;
  /** @type {Map<string, PropertyDescriptor>} */
  const found = new Map();
  for (let proto = Object.getPrototypeOf(canvas); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (!name.startsWith('on') || found.has(name) || OWN_EVENTS.has(name.slice(2))) continue;
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (desc?.get && desc.set) found.set(name, desc);
    }
  }
  handlerTable = [...found].map(([name, desc]) => ({ name, desc }));
  return handlerTable;
}

/** @param {unknown} options @returns {{capture: boolean, once: boolean, signal: AbortSignal|null, passive: boolean}} */
function normalize(options) {
  if (typeof options === 'boolean') return { capture: options, once: false, signal: null, passive: false };
  const o = /** @type {AddEventListenerOptions|undefined} */ (options);
  return { capture: !!o?.capture, once: !!o?.once, signal: o?.signal ?? null, passive: o?.passive === true };
}

/** @param {unknown} err */
function reportAsync(err) {
  if (typeof reportError === 'function') reportError(err);
  else queueMicrotask(() => { throw err; });
}

/** Replace the layer by the canvas in composedPath(); permanent for this event, only listeners after the layer see it. */
function patchPath(/** @type {Event} */ ev, /** @type {Element} */ layerEl, /** @type {Element} */ canvas) {
  if (Object.hasOwn(ev, 'composedPath')) return;
  const original = ev.composedPath;
  Object.defineProperty(ev, 'composedPath', {
    configurable: true,
    value: () => original.call(ev).map((t) => (t === layerEl ? canvas : t)),
  });
}

/**
 * Run `call` with currentTarget reporting `canvas`.
 * @param {Event} ev
 * @param {HTMLCanvasElement} canvas
 * @param {() => void} call
 */
function asCanvas(ev, canvas, call) {
  Object.defineProperty(ev, 'currentTarget', { configurable: true, get: () => canvas });
  try { call(); } finally { Reflect.deleteProperty(ev, 'currentTarget'); }
}

/**
 * Instance-level addEventListener/removeEventListener and on* accessors on the canvas. Every canvas listener gets its own forwarder on the layer, registered in the
 * same order with the listener's capture and passive flags: the browser itself then ignores a passive listener's preventDefault (whatever reference to it the page
 * holds), stops the later ones at stopImmediatePropagation and skips one removed during the dispatch. Returns the remover.
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLElement} layerEl
 * @returns {() => void}
 */
export function installEventBridge(canvas, layerEl) {
  let registry = registries.get(canvas);
  if (!registry) registries.set(canvas, (registry = new Map()));
  const entries = registry;
  /** the forwarder of each canvas listener, on the layer of this mount @type {Map<Entry, EventListener>} */
  const forwarders = new Map();
  /** @type {Map<string, EventListener>} */
  const handlerBridges = new Map();
  /** @type {Map<string, Function>} */
  const handlers = new Map();
  const own = createOwnProps();
  const nativeAdd = canvas.addEventListener;
  const nativeRemove = canvas.removeEventListener;

  /** @param {string} type @param {boolean} capture */
  const keyOf = (type, capture) => `${type}|${capture ? 1 : 0}`;

  /** Register the forwarder of `entry` (a listener of `key`) on the layer. @param {string} key @param {Entry} entry */
  function forward(key, entry) {
    const [type, capture] = key.split('|');
    const fn = /** @type {EventListener} */ ((ev) => {
      if (ev.target === layerEl || ev.target === canvas) return;
      if (entry.once) drop(key, entry.listener);
      patchPath(ev, layerEl, canvas);
      asCanvas(ev, canvas, () => {
        try {
          if (typeof entry.listener === 'function') entry.listener.call(canvas, ev);
          else entry.listener.handleEvent(ev);
        } catch (err) { reportAsync(err); }
      });
    });
    forwarders.set(entry, fn);
    layerEl.addEventListener(type, fn, { capture: capture === '1', passive: entry.passive });
  }

  /** @param {string} key @param {EventListenerOrEventListenerObject} listener */
  function drop(key, listener) {
    const list = entries.get(key);
    const at = list ? list.findIndex((e) => e.listener === listener) : -1;
    if (!list || at < 0) return;
    const [entry] = list.splice(at, 1);
    if (!list.length) entries.delete(key);
    const fn = forwarders.get(entry);
    if (fn) {
      const [type, capture] = key.split('|');
      layerEl.removeEventListener(type, fn, capture === '1');
      forwarders.delete(entry);
    }
  }

  own.define(canvas, 'addEventListener', {
    writable: true,
    value: function addEventListener(/** @type {string} */ type, /** @type {EventListenerOrEventListenerObject|null} */ listener, /** @type {any} */ options) {
      nativeAdd.call(canvas, type, /** @type {any} */ (listener), options);
      const { capture, once, signal, passive } = normalize(options);
      if (!listener || OWN_EVENTS.has(type) || signal?.aborted) return;
      const key = keyOf(type, capture);
      const list = entries.get(key) ?? [];
      if (list.some((e) => e.listener === listener)) return;
      const entry = { listener, once, signal, passive };
      list.push(entry);
      entries.set(key, list);
      forward(key, entry);
      signal?.addEventListener('abort', () => drop(key, listener), { once: true });
    },
  });
  own.define(canvas, 'removeEventListener', {
    writable: true,
    value: function removeEventListener(/** @type {string} */ type, /** @type {EventListenerOrEventListenerObject|null} */ listener, /** @type {any} */ options) {
      nativeRemove.call(canvas, type, /** @type {any} */ (listener), options);
      if (listener) drop(keyOf(type, normalize(options).capture), listener);
    },
  });
  for (const [key, list] of entries) for (const entry of list) forward(key, entry);

  /** @param {string} name @param {PropertyDescriptor} desc */
  function bridgeHandler(name, desc) {
    const type = name.slice(2);
    own.define(canvas, name, {
      get() { return desc.get?.call(canvas); },
      set(value) {
        desc.set?.call(canvas, value);
        if (typeof value === 'function') { handlers.set(name, value); ensureHandlerBridge(name, type); } else handlers.delete(name);
      },
    });
    const inline = desc.get?.call(canvas);
    if (typeof inline === 'function') { handlers.set(name, inline); ensureHandlerBridge(name, type); }
  }

  /** @param {string} name @param {string} type */
  function ensureHandlerBridge(name, type) {
    if (handlerBridges.has(name)) return;
    const bridge = /** @type {EventListener} */ ((ev) => {
      const handler = handlers.get(name);
      if (!handler || ev.target === layerEl || ev.target === canvas) return;
      patchPath(ev, layerEl, canvas);
      asCanvas(ev, canvas, () => {
        try { handler.call(canvas, ev); } catch (err) { reportAsync(err); }
      });
    });
    handlerBridges.set(name, bridge);
    layerEl.addEventListener(type, bridge);
  }

  for (const { name, desc } of handlerDescriptors(canvas)) bridgeHandler(name, desc);

  return () => {
    own.restore();
    for (const [key, list] of entries) {
      const [type, capture] = key.split('|');
      for (const entry of list) { const fn = forwarders.get(entry); if (fn) layerEl.removeEventListener(type, fn, capture === '1'); }
    }
    for (const [name, bridge] of handlerBridges) layerEl.removeEventListener(name.slice(2), bridge);
    forwarders.clear();
    handlerBridges.clear();
  };
}
