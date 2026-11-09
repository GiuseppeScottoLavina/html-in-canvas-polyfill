/**
 * canvas.addEventListener bridge: listeners on the canvas also receive bubbling events of relocated descendants (currentTarget AND composedPath() overridden: the layer
 * entry is replaced by the canvas), and the `on*` event-handler IDL properties of the canvas (`canvas.onclick = fn`, from the HTMLElement/GlobalEventHandlers
 * descriptor table) are instance accessors whose handlers take their place in the same ordered registry. A canvas listener must behave as on a native element
 * whose child's events and own events reach it: the listener matrix holds that (test/unit/live/listener-matrix.mjs, docs/TEST-PLAN.md 2.3).
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
 * @property {EventListenerOrEventListenerObject|null} listener  null for the entry of an `on*` handler
 * @property {string|null} handler  the `on*` property of a handler entry: its value is read from the canvas at each event, as natively
 * @property {boolean} once
 * @property {AbortSignal|null} signal
 * @property {boolean} passive  registered with `passive: true` (the canvas is not the window, the document or the body: `passive` left out means false there)
 * @property {string} key  its type and capture (keyOf)
 * @property {(() => void)|undefined} [detach]  removes its forwarder from the layer of the current mount (none while the canvas is unmounted)
 * @property {(() => void)|undefined} [unwatch]  removes its abort watcher from its signal
 * @property {(() => void)|undefined} [unguard]  a `once` registration: removes its guard (see guardOnce)
 * @property {(() => void)|undefined} [unregister]  a `once` registration: removes the listener's own native registration on the canvas
 */

/**
 * The bridge of one canvas. Its registry, its methods and its guards last while the canvas is managed, mounted or not (a listener added, removed or run while
 * the canvas is unmounted is seen); only the forwarders are per mount. A dispose (an uninstall, or the canvas no longer managed) restores the methods and
 * removes the guards; the registry stays, so that a reinstall bridges the listeners again.
 * @typedef {{entries: Map<string, Entry[]>, own: ReturnType<typeof createOwnProps>|null, add: Function, remove: Function, layerEl: HTMLElement|null}} Bridge
 */

/** @type {WeakMap<HTMLCanvasElement, Bridge>} */
const bridges = new WeakMap();

/** @param {string} type @param {boolean} capture */
const keyOf = (type, capture) => `${type}|${capture ? 1 : 0}`;

/**
 * End the registration `entry` (removeEventListener, once, its signal aborted, a handler set to null): out of the registry, its forwarder off the layer, its
 * abort watcher off its signal, its guard off. By identity: an earlier registration of the same function cannot end a later one.
 * @param {Bridge} b @param {Entry} entry
 */
function endEntry(b, entry) {
  const list = b.entries.get(entry.key), at = list ? list.indexOf(entry) : -1;
  if (!list || at < 0) return;
  list.splice(at, 1);
  if (!list.length) b.entries.delete(entry.key);
  entry.detach?.();
  entry.unwatch?.();
  entry.unguard?.();
  entry.unguard = undefined;
}

/**
 * A `once` canvas listener is registered twice: natively on the canvas (events aimed at the canvas, and the children's while unmounted) and as a forwarder on the
 * layer (the relocated children's events). Natively it runs once, whichever route comes first. The guard, a passive native listener of the same type, phase and
 * signal registered on the canvas just before the listener's own registration, ends the registration when an event is about to reach the listener there, so the
 * forwarder goes with it; the forwarder ends it and removes the native registration and the guard before it calls the listener. A guard goes with a dispose, so
 * an uninstall leaves no listener of the polyfill; a reinstall registers the type's listeners again behind their guards (reregister).
 * @param {Bridge} b @param {HTMLCanvasElement} canvas @param {Entry} entry
 */
function guardOnce(b, canvas, entry) {
  const [type, phase] = entry.key.split('|'), capture = phase === '1';
  const guard = () => { entry.unguard = undefined; endEntry(b, entry); };
  b.add.call(canvas, type, guard, { capture, passive: true, once: true, ...(entry.signal ? { signal: entry.signal } : {}) });
  entry.unguard = () => b.remove.call(canvas, type, guard, capture);
  entry.unregister = () => b.remove.call(canvas, type, entry.listener, capture);
}

/**
 * The first mount after a dispose (a reinstall) restores the bridge's registrations as they were at the uninstall: the polyfill could not see the page while it
 * was not installed, and native listeners cannot be read. Each type and phase is registered natively again, in the order of the registry, each once listener
 * behind a new guard (a guard runs first only if it is registered first), and an on* handler among them is set again in its place (handlers are read from the
 * canvas, so one the page set or cleared meanwhile counts as it left it). So they keep their order among themselves and after the listeners registered before
 * the bridge; a listener removed or run (once) while the polyfill was not installed is registered again, and one added meanwhile is not bridged (the
 * tree-identity row of src/contracts/features.js).
 * @param {Bridge} b @param {HTMLCanvasElement} canvas @param {Entry[]} list
 */
function reregister(b, canvas, list) {
  const capture = list[0].key.endsWith('|1');
  const type = list[0].key.slice(0, -2);
  /** @type {Array<() => void>} */ const again = [];
  for (const entry of list) {
    if (entry.handler) {
      const desc = /** @type {PropertyDescriptor} */ (handlerDescriptors(canvas).find((h) => h.name === entry.handler)?.desc);
      const value = desc.get?.call(canvas);
      desc.set?.call(canvas, null);
      again.push(() => desc.set?.call(canvas, value));
    } else {
      b.remove.call(canvas, type, entry.listener, capture);
      again.push(() => {
        if (entry.once) guardOnce(b, canvas, entry);
        b.add.call(canvas, type, entry.listener, { capture, once: entry.once, passive: entry.passive, ...(entry.signal ? { signal: entry.signal } : {}) });
      });
    }
  }
  for (const add of again) add();
}

/**
 * The canvas is disposed (an uninstall, or the canvas no longer managed): the forwarders, the methods and the `on*` accessors go, and the guards of its pending
 * `once` listeners; the registry stays for a reinstall. While the polyfill is not installed the page's listeners are native and the polyfill sees nothing: after
 * a reinstall the canvas listeners are bridged as they were at the uninstall (the `tree-identity` row of src/contracts/features.js).
 * @param {HTMLCanvasElement} canvas
 */
export function releaseCanvasListeners(canvas) {
  const b = bridges.get(canvas);
  if (!b?.own) return;
  b.own.restore();
  b.own = null;
  for (const list of b.entries.values()) for (const entry of list) { entry.detach?.(); entry.unguard?.(); entry.unguard = undefined; }
  b.layerEl = null;
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
 * Register the forwarder of `entry` on the layer of the current mount (none while the canvas is unmounted). Every canvas listener and `on*` handler has its own,
 * in registration order with its capture and passive flags: the browser then ignores a passive listener's preventDefault (whatever reference to it the page
 * holds), stops the later ones at stopImmediatePropagation and skips one removed during the dispatch. A handler that returns false cancels the event.
 * @param {Bridge} b @param {HTMLCanvasElement} canvas @param {Entry} entry
 */
function forward(b, canvas, entry) {
  const layerEl = b.layerEl;
  if (!layerEl) return;
  const [type, capture] = entry.key.split('|');
  const fn = /** @type {EventListener} */ ((ev) => {
    if (ev.target === layerEl || ev.target === canvas) return;
    if (entry.once) { entry.unregister?.(); endEntry(b, entry); }
    patchPath(ev, layerEl, canvas);
    asCanvas(ev, canvas, () => {
      try {
        if (entry.handler) {
          const value = /** @type {any} */ (canvas)[entry.handler];
          if (typeof value === 'function' && value.call(canvas, ev) === false) ev.preventDefault();
        } else if (typeof entry.listener === 'function') entry.listener.call(canvas, ev);
        else entry.listener?.handleEvent(ev);
      } catch (err) { reportAsync(err); }
    });
  });
  const detach = () => {
    layerEl.removeEventListener(type, fn, capture === '1');
    if (entry.detach === detach) entry.detach = undefined;
  };
  entry.detach = detach;
  layerEl.addEventListener(type, fn, { capture: capture === '1', passive: entry.passive });
}

/** @param {Bridge} b @param {Entry} entry */
function append(b, entry) {
  const list = b.entries.get(entry.key) ?? [];
  list.push(entry);
  b.entries.set(entry.key, list);
}

/**
 * The instance-level addEventListener / removeEventListener and `on*` accessors of the canvas, defined once per install of the bridge (until a dispose).
 * @param {Bridge} b @param {HTMLCanvasElement} canvas
 */
function defineMethods(b, canvas) {
  const own = (b.own = createOwnProps());
  b.add = canvas.addEventListener;
  b.remove = canvas.removeEventListener;
  own.define(canvas, 'addEventListener', {
    writable: true,
    value: function addEventListener(/** @type {string} */ type, /** @type {EventListenerOrEventListenerObject|null} */ listener, /** @type {any} */ options) {
      const { capture, once, signal, passive } = normalize(options);
      const key = keyOf(type, capture);
      const bridged = !!listener && !OWN_EVENTS.has(type) && !signal?.aborted;
      /** @type {Entry|null} */ const entry = bridged && !(b.entries.get(key) ?? []).some((e) => e.listener === listener) ? { listener, handler: null, once, signal, passive, key } : null;
      // the guard of a once listener goes on the canvas before the listener's own registration, so that it runs first (guardOnce)
      if (entry?.once) guardOnce(b, canvas, entry);
      b.add.call(canvas, type, /** @type {any} */ (listener), options);
      if (!entry) return;
      append(b, entry);
      forward(b, canvas, entry);
      if (signal) {
        const onAbort = () => endEntry(b, entry);
        signal.addEventListener('abort', onAbort, { once: true });
        entry.unwatch = () => signal.removeEventListener('abort', onAbort);
      }
    },
  });
  own.define(canvas, 'removeEventListener', {
    writable: true,
    value: function removeEventListener(/** @type {string} */ type, /** @type {EventListenerOrEventListenerObject|null} */ listener, /** @type {any} */ options) {
      b.remove.call(canvas, type, /** @type {any} */ (listener), options);
      const entry = listener ? b.entries.get(keyOf(type, normalize(options).capture))?.find((e) => e.listener === listener) : undefined;
      if (entry) endEntry(b, entry);
    },
  });
  // an on* handler is an entry of the registry where it was first set, as natively: a new value keeps its place, null ends it (set again, it goes last)
  for (const { name, desc } of handlerDescriptors(canvas)) {
    const key = keyOf(name.slice(2), false);
    const sync = () => {
      const entry = b.entries.get(key)?.find((e) => e.handler === name);
      const active = typeof desc.get?.call(canvas) === 'function';
      if (active && !entry) { const made = { listener: null, handler: name, once: false, signal: null, passive: false, key }; append(b, made); forward(b, canvas, made); }
      else if (!active && entry) endEntry(b, entry);
    };
    own.define(canvas, name, {
      get() { return desc.get?.call(canvas); },
      set(value) { desc.set?.call(canvas, value); sync(); },
    });
    sync();
  }
}

/**
 * Mount the bridge of `canvas` on `layerEl`: the methods if the bridge is not installed (its first mount, or the first after a dispose, which also restores the
 * registrations of the uninstall: reregister), then one forwarder per registration, in order. Returns the remover of this mount's forwarders.
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLElement} layerEl
 * @returns {() => void}
 */
export function installEventBridge(canvas, layerEl) {
  let b = bridges.get(canvas);
  if (!b) bridges.set(canvas, (b = { entries: new Map(), own: null, add: canvas.addEventListener, remove: canvas.removeEventListener, layerEl: null }));
  const bridge = b;
  if (!bridge.own) {
    const reinstall = bridge.entries.size > 0;
    defineMethods(bridge, canvas);
    // the first mount after a dispose: the registrations as they were at the uninstall, in order (reregister)
    if (reinstall) for (const list of [...bridge.entries.values()]) reregister(bridge, canvas, [...list]);
  }
  bridge.layerEl = layerEl;
  for (const list of [...bridge.entries.values()]) for (const entry of [...list]) forward(bridge, canvas, entry);
  return () => {
    for (const list of bridge.entries.values()) for (const entry of list) entry.detach?.();
    if (bridge.layerEl === layerEl) bridge.layerEl = null;
  };
}
