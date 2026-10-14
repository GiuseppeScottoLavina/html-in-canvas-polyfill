// Browser-side helpers of the api-core tests (imported by *.browser.test.mjs; the runner serves the repo root).
import { createBus } from '/src/util/bus.js';
import { resolveOptions } from '/src/api/options.js';
import { createEnv } from '/src/api/env.js';
import { createReporter } from '/src/api/report.js';
import { BUS } from '/src/contracts/events.js';

/**
 * An env on a real window. With `fakeTimers` the window's setTimeout/clearTimeout are captured so a test can fire the 5 s grace period at once.
 * @param {import('/src/contracts/types.js').HicOptions} [options]
 * @param {{fakeTimers?: boolean, window?: Window}} [extra]
 */
export function makeEnv(options = {}, { fakeTimers = false, window: realWindow = window } = {}) {
  /** @type {Array<{fn: () => void, ms: number, cancelled: boolean}>} */
  const timers = [];
  const win = fakeTimers
    ? new Proxy(realWindow, {
      get(target, prop) {
        if (prop === 'setTimeout') return (/** @type {() => void} */ fn, /** @type {number} */ ms) => timers.push({ fn, ms, cancelled: false });
        if (prop === 'clearTimeout') return (/** @type {number} */ id) => { if (timers[id - 1]) timers[id - 1].cancelled = true; };
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' && !/^[A-Z]/.test(String(prop)) ? v.bind(target) : v;
      },
    })
    : realWindow;
  const resolved = resolveOptions(options);
  /** @type {any} */ let reporter = null;
  const bus = createBus((err, topic) => reporter?.caught(err, `bus:${topic}`));
  reporter = createReporter(win, resolved);
  const env = createEnv(win, resolved, bus, reporter, realWindow.document);
  /** @type {Array<Document|ShadowRoot>} */
  const known = [realWindow.document];
  Object.assign(env, { roots: { roots: () => [...known], adopt() {}, rootOf: (/** @type {Node} */ n) => n.getRootNode(), onRoot: () => () => {}, style: () => ({}), dispose() {} } });
  /** announce a shadow root the way live/root-scope.js does */
  const announceRoot = (/** @type {ShadowRoot} */ root) => { known.push(root); bus.emit(BUS.ROOT_ADDED, { root }); };
  /** @param {() => void} [after] */
  const fireTimers = () => { for (const t of timers.splice(0)) if (!t.cancelled) t.fn(); };
  return { env, bus, reporter, timers, announceRoot, fireTimers };
}

/**
 * A stand-in for live/live-layer.js: relocates the canvas children into a <hic-layer> sibling, exactly the part of the contract the registry depends on.
 * @param {string[]} [log]
 * @param {{failFor?: (record: any) => boolean}} [opts]
 */
export function fakeLayerFactory(log = [], opts = {}) {
  return (/** @type {any} */ _env, /** @type {any} */ record) => {
    if (opts.failFor?.(record)) throw new Error(`layer factory failed for canvas ${record.id}`);
    const element = record.canvas.ownerDocument.createElement('hic-layer');
    element.setAttribute('data-hic-layer', String(record.id));
    element.setAttribute('data-hic-node', '');
    let mounted = false;
    return /** @type {any} */ ({
      element,
      mount() {
        if (mounted) return;
        mounted = true;
        for (const kid of [...record.canvas.childNodes]) element.appendChild(kid);
        record.canvas.after(element);
        log.push(`mount:${record.id}`);
      },
      unmount() {
        if (!mounted) return;
        mounted = false;
        for (const kid of [...element.childNodes]) record.canvas.appendChild(kid);
        element.remove();
        log.push(`unmount:${record.id}`);
      },
      isMounted: () => mounted,
      dispose() { log.push(`dispose:${record.id}`); },
    });
  };
}

/** let MutationObserver callbacks run (they are microtasks; one macrotask turn covers chains of them) */
export const settle = () => new Promise((ok) => setTimeout(ok, 0));

/**
 * Module factories for installWith(): enough of each contract to let the composition run, recording what happens in `log`.
 * @param {string[]} [log]
 * @param {Partial<Record<string, Function>>} [overrides]
 */
export function fakeServices(log = [], overrides = {}) {
  return /** @type {any} */ ({
    createLiveLayer: fakeLayerFactory(log),
    installSelectorBridge: () => () => {},
    createRootScope: (/** @type {any} */ env) => {
      const known = [env.document];
      return {
        roots: () => [...known],
        rootOf: (/** @type {Node} */ n) => n.getRootNode(),
        adopt(/** @type {ShadowRoot} */ root) { if (!known.includes(root)) { known.push(root); env.bus.emit(BUS.ROOT_ADDED, { root }); } },
        onRoot: () => () => {},
        style: () => ({}),
        dispose() { log.push('roots.dispose'); },
      };
    },
    createCapture: () => () => { throw new Error('capture is not exercised by the api-core tests'); },
    createSnapshotStore: () => ({ forget() {}, dispose() { log.push('store.dispose'); } }),
    createScheduler: () => ({
      register: (/** @type {any} */ r) => log.push(`register:${r.id}`),
      unregister: (/** @type {any} */ r) => log.push(`unregister:${r.id}`),
      dispose() { log.push('scheduler.dispose'); },
    }),
    startObservers: () => () => { log.push('observers.stop'); },
    createEffects: () => ({ version: 2, definePlugin: (/** @type {any} */ d) => d, createHost: async () => { throw new Error('unused'); }, dispose() { log.push('effects.dispose'); } }),
    createInteractionTracker: () => ({ snapshot: () => ({}), setMappedTarget() {}, onChange: () => () => {} }),
    ...overrides,
  });
}

/** A same-origin iframe: a second realm whose prototypes can be patched, shaped and compared without touching the test page. */
export function makeFrame(/** @type {{cleanup: (fn: () => void) => void}} */ t, html = '') {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'width:300px;height:200px;border:0';
  document.body.append(frame);
  t.cleanup(() => frame.remove());
  const w = /** @type {any} */ (frame.contentWindow);
  w.document.body.innerHTML = html;
  return w;
}

const PROTOTYPES = ['Node', 'EventTarget', 'Element', 'HTMLElement', 'Document', 'ShadowRoot', 'HTMLCanvasElement', 'CanvasRenderingContext2D', 'OffscreenCanvas',
  'OffscreenCanvasRenderingContext2D', 'WebGLRenderingContext', 'WebGL2RenderingContext', 'GPUQueue', 'Worker', 'MessagePort', 'ElementImage'];

/** Every own property descriptor of the window, its document and the prototypes the polyfill may touch. */
export function snapshotDescriptors(/** @type {any} */ w) {
  /** @type {Map<string, PropertyDescriptor>} */
  const out = new Map();
  /** @type {Array<[string, object]>} */
  const objects = [['window', w], ['document', w.document]];
  for (const name of PROTOTYPES) if (w[name]?.prototype) objects.push([`${name}.prototype`, w[name].prototype]);
  for (const [label, obj] of objects) {
    for (const key of Reflect.ownKeys(obj)) out.set(`${label}.${String(key)}`, /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(obj, key)));
  }
  return out;
}

/** @returns {string[]} one line per property that was added, removed or changed (any field, by identity) */
export function diffDescriptors(/** @type {Map<string, PropertyDescriptor>} */ a, /** @type {Map<string, PropertyDescriptor>} */ b) {
  const lines = [];
  for (const [key, da] of a) {
    const db = b.get(key);
    if (!db) { lines.push(`removed ${key}`); continue; }
    for (const field of /** @type {const} */ (['value', 'get', 'set', 'writable', 'enumerable', 'configurable'])) {
      if (!Object.is(da[field], db[field])) { lines.push(`changed ${key}.${field}`); break; }
    }
  }
  for (const key of b.keys()) if (!a.has(key)) lines.push(`added ${key}`);
  return lines;
}

/**
 * Give a frame a native HTML-in-Canvas implementation of a chosen shape, built from plain functions (the page's Chrome has none without a flag).
 * Shapes, as measured:
 *  - 'current'  (default): Canary 157.0.8103.0 with or without the flag, the 2026-10-08 specification: `content`, getElementImageDefaultSize on
 *                HTMLCanvasElement and OffscreenCanvas, ElementImage with close() only.
 *  - 'previous': the 2026-10-07 shape of the pinned WPT revision: `content`, ElementImage.width/height, no getElementImageDefaultSize.
 *  - 'legacy'   (or `legacy: true`): Chrome 154 and 155 with the flag: layoutSubtree, no content, drawElementImage returns a DOMMatrix, ElementImage.width/height.
 * `omit` removes names (as in native-detect.js). drawElementImage throws like the platform (TypeError for a non-Element without the ElementImage
 * shape, InvalidStateError for an element of a canvas that is not connected) unless `inert` (a stub that returns without throwing).
 * Every native method records its calls in `w.__native`.
 * @param {any} w
 * @param {{legacy?: boolean, shape?: 'current'|'previous'|'legacy', omit?: string[], inert?: boolean}} [options]
 */
export function defineFakeNative(w, { legacy = false, shape = legacy ? 'legacy' : 'current', omit = [], inert = false } = {}) {
  const isLegacy = shape === 'legacy';
  /** @type {any[][]} */
  const calls = (w.__native = []);
  const has = (/** @type {string} */ name) => !omit.includes(name);
  const def = (/** @type {object} */ obj, /** @type {string} */ key, /** @type {PropertyDescriptor} */ d, name = key) => {
    if (has(name)) Object.defineProperty(obj, key, { configurable: true, enumerable: true, ...d });
  };
  const canvas = w.HTMLCanvasElement.prototype;
  if (isLegacy) {
    def(canvas, 'layoutSubtree', { get() { return this.hasAttribute('layoutsubtree'); }, set(v) { this.toggleAttribute('layoutsubtree', !!v); } });
  } else {
    def(canvas, 'content', { get() { return (this.getAttribute('content') ?? '').toLowerCase() === 'drawable' ? 'drawable' : 'fallback'; }, set(v) { this.setAttribute('content', v); } });
    def(canvas, 'onelementgeometryupdate', { get() { return null; }, set() {} });
  }
  def(canvas, 'onpaint', { get() { return null; }, set() {} });
  for (const m of ['requestPaint', 'captureElementImage', 'getElementTransform', 'updateElementGeometry', 'clearElementGeometry']) {
    def(canvas, m, { writable: true, value: function (/** @type {any[]} */ ...args) {
      calls.push([m, ...args]);
      return m === 'captureElementImage' && typeof w.ElementImage === 'function' ? new w.ElementImage() : undefined;
    } });
  }
  const size = function (/** @type {any} */ el) { calls.push(['getElementImageDefaultSize', el]); return { width: 10, height: 10 }; };
  if (shape === 'current') {
    def(canvas, 'getElementImageDefaultSize', { writable: true, value: size });
    if (w.OffscreenCanvas) def(w.OffscreenCanvas.prototype, 'getElementImageDefaultSize', { writable: true, value: size }, 'OffscreenCanvas.getElementImageDefaultSize');
  }
  if (w.OffscreenCanvas) {
    for (const m of ['updateElementGeometry', 'clearElementGeometry']) {
      def(w.OffscreenCanvas.prototype, m, { writable: true, value: function (/** @type {any[]} */ ...args) { calls.push([`OffscreenCanvas.${m}`, ...args]); } }, `OffscreenCanvas.${m}`);
    }
  }
  for (const cls of ['CanvasRenderingContext2D', 'OffscreenCanvasRenderingContext2D']) {
    if (!w[cls]) continue;
    def(w[cls].prototype, 'drawElementImage', {
      writable: true,
      value: function (/** @type {any} */ el, /** @type {number} */ dx = 0, /** @type {number} */ dy = 0) {
        if (!inert) {
          const element = el instanceof w.Element;
          if (!element && !(el && typeof el === 'object' && ('close' in el || 'width' in el))) throw new w.TypeError("The provided value is not of type '(Element or ElementImage)'.");
          if (element && !el.isConnected) throw new w.DOMException('The element can only be drawn into its nearest ancestor <canvas>.', 'InvalidStateError');
        }
        calls.push(['drawElementImage', el, dx, dy]);
        return isLegacy ? new w.DOMMatrix([1, 0, 0, 1, dx, dy]) : undefined;
      },
    }, `${cls}.drawElementImage`);
  }
  if (has('ElementImage')) {
    const ElementImage = shape === 'current'
      ? class ElementImage { close() {} }
      : class ElementImage { get width() { return 10; } get height() { return 10; } close() {} };
    def(w, 'ElementImage', { writable: true, value: ElementImage });
  }
  if (!isLegacy && has('ElementGeometryUpdateEvent')) def(w, 'ElementGeometryUpdateEvent', { writable: true, value: class ElementGeometryUpdateEvent extends w.Event {} });
  for (const cls of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
    if (!w[cls]) continue;
    def(w[cls].prototype, 'texElementSubImage2D', { writable: true, value() {} }, `${cls}.texElementSubImage2D`);
    if (isLegacy) def(w[cls].prototype, 'texElementImage2D', { writable: true, value() {} }, `${cls}.texElementImage2D`);
  }
  if (w.GPUQueue) {
    def(w.GPUQueue.prototype, 'drawElementImageToTexture', { writable: true, value() {} }, 'GPUQueue.drawElementImageToTexture');
    if (isLegacy) def(w.GPUQueue.prototype, 'copyElementImageToTexture', { writable: true, value() {} }, 'GPUQueue.copyElementImageToTexture');
  }
  return calls;
}
