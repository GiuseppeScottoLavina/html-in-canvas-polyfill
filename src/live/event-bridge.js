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
 * @property {string} key  its type and capture (keyOf)
 * @property {(() => void)|undefined} [detach]  removes its forwarder from the layer of the current mount (none while the canvas is unmounted)
 * @property {(() => void)|undefined} [unwatch]  removes its abort watcher from its signal
 * @property {(() => void)|undefined} [unguard]  a `once` registration: removes its guard on the canvas (see guardOnce)
 * @property {(() => void)|undefined} [unregister]  a `once` registration: removes the listener's own native registration on the canvas
 */

/** @type {WeakMap<HTMLCanvasElement, Map<string, Entry[]>>} listeners per canvas, kept across unmount/mount so a toggled canvas keeps its bridge */
const registries = new WeakMap();

/**
 * End the registration `entry` (removeEventListener, once, or its signal aborted), whatever mount registered it: out of the canvas registry, its forwarder off the
 * layer of the current mount, its abort watcher off its signal. By identity: an earlier registration of the same function cannot end a later one.
 * @param {Map<string, Entry[]>} entries @param {Entry} entry
 */
function endEntry(entries, entry) {
  const list = entries.get(entry.key), at = list ? list.indexOf(entry) : -1;
  if (!list || at < 0) return;
  list.splice(at, 1);
  if (!list.length) entries.delete(entry.key);
  entry.detach?.();
  entry.unwatch?.();
  entry.unguard?.();
  entry.unguard = undefined;
}

/**
 * A `once` canvas listener is registered twice: natively on the canvas (events aimed at the canvas itself) and as a forwarder on the layer (events of the
 * relocated children). Natively it runs once, whichever route comes first. The guard, a passive native listener of the same type, phase and signal registered on
 * the canvas before the listener's own registration, ends the registration when an event reaches the canvas, so the forwarder goes too; the forwarder ends it
 * and removes the native registration and the guard before it calls the listener. The guard stays while the canvas is unmounted (its events then reach the
 * canvas natively) and goes when the layer is disposed (releaseCanvasListeners), so an uninstall leaves no listener of the polyfill behind.
 * @param {HTMLCanvasElement} canvas @param {Map<string, Entry[]>} entries @param {Entry} entry @param {Function} add @param {Function} remove the native methods
 */
function guardOnce(canvas, entries, entry, add, remove) {
  const [type, phase] = entry.key.split('|'), capture = phase === '1';
  const guard = () => { entry.unguard = undefined; endEntry(entries, entry); };
  add.call(canvas, type, guard, { capture, passive: true, once: true, ...(entry.signal ? { signal: entry.signal } : {}) });
  entry.unguard = () => remove.call(canvas, type, guard, capture);
  entry.unregister = () => remove.call(canvas, type, entry.listener, capture);
}

/**
 * The layer of `canvas` is disposed (an uninstall, or the canvas no longer managed): the guards of its pending `once` listeners go, and a later mount sets them
 * again. A `once` listener that fires natively in between is not seen: after a reinstall it can run once more (the `tree-identity` row of src/contracts/features.js).
 * @param {HTMLCanvasElement} canvas
 */
export function releaseCanvasListeners(canvas) {
  for (const list of registries.get(canvas)?.values() ?? []) for (const entry of list) { entry.unguard?.(); entry.unguard = undefined; }
}

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
  /** the forwarder of each canvas listener on the layer of this mount, and its remover @type {Map<Entry, () => void>} */
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

  /** Register the forwarder of `entry` on the layer of this mount. @param {Entry} entry */
  function forward(entry) {
    const [type, capture] = entry.key.split('|');
    const fn = /** @type {EventListener} */ ((ev) => {
      if (ev.target === layerEl || ev.target === canvas) return;
      if (entry.once) { entry.unregister?.(); endEntry(entries, entry); }
      patchPath(ev, layerEl, canvas);
      asCanvas(ev, canvas, () => {
        try {
          if (typeof entry.listener === 'function') entry.listener.call(canvas, ev);
          else entry.listener.handleEvent(ev);
        } catch (err) { reportAsync(err); }
      });
    });
    const detach = () => {
      layerEl.removeEventListener(type, fn, capture === '1');
      forwarders.delete(entry);
      if (entry.detach === detach) entry.detach = undefined;
    };
    forwarders.set(entry, detach);
    entry.detach = detach;
    layerEl.addEventListener(type, fn, { capture: capture === '1', passive: entry.passive });
  }

  own.define(canvas, 'addEventListener', {
    writable: true,
    value: function addEventListener(/** @type {string} */ type, /** @type {EventListenerOrEventListenerObject|null} */ listener, /** @type {any} */ options) {
      const { capture, once, signal, passive } = normalize(options);
      const key = keyOf(type, capture);
      const list = !listener || OWN_EVENTS.has(type) || signal?.aborted ? null : entries.get(key) ?? [];
      /** @type {Entry|null} */ const entry = list && listener && !list.some((e) => e.listener === listener) ? { listener, once, signal, passive, key } : null;
      // the guard of a once listener goes on the canvas before the listener's own registration, so that it runs first (guardOnce)
      if (entry?.once) guardOnce(canvas, entries, entry, nativeAdd, nativeRemove);
      nativeAdd.call(canvas, type, /** @type {any} */ (listener), options);
      if (!list || !entry) return;
      list.push(entry);
      entries.set(key, list);
      forward(entry);
      if (signal) {
        // the watcher ends this registration, on whichever mount the canvas is then (or none): not the mount that registered it
        const onAbort = () => endEntry(entries, entry);
        signal.addEventListener('abort', onAbort, { once: true });
        entry.unwatch = () => signal.removeEventListener('abort', onAbort);
      }
    },
  });
  own.define(canvas, 'removeEventListener', {
    writable: true,
    value: function removeEventListener(/** @type {string} */ type, /** @type {EventListenerOrEventListenerObject|null} */ listener, /** @type {any} */ options) {
      nativeRemove.call(canvas, type, /** @type {any} */ (listener), options);
      const entry = listener ? entries.get(keyOf(type, normalize(options).capture))?.find((e) => e.listener === listener) : undefined;
      if (entry) endEntry(entries, entry);
    },
  });
  for (const list of entries.values()) for (const entry of list) {
    forward(entry);
    // a guard released by a dispose is set again (it now follows the listener's own registration)
    if (entry.once && !entry.unguard) guardOnce(canvas, entries, entry, nativeAdd, nativeRemove);
  }

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
    // the forwarders this mount registered (not the registry's entries: one may have ended meanwhile); a second call finds none
    for (const detach of [...forwarders.values()]) detach();
    for (const [name, bridge] of handlerBridges) layerEl.removeEventListener(name.slice(2), bridge);
    handlerBridges.clear();
  };
}
