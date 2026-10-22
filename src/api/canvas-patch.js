/**
 * HTMLCanvasElement.prototype patches: content, onpaint, onelementgeometryupdate, framecap/frameCap, layoutSubtree, requestPaint, captureElementImage, getElementImageDefaultSize,
 * updateElementGeometry, clearElementGeometry, getElementTransform; width/height setter hook.
 * Module: api-surface (src/api/*).
 */

import { BUS, EVENTS, EXT } from '../contracts/events.js';
import { createElementImage, defaultSizeOf, elementImageVersion } from './element-image.js';
import { geometryOptionsFromValues } from './geometry.js';
import { ensureHandlerListener, getEventHandler, isPaintDispatching, requestIdlePaint, setEventHandler } from './paint-event.js';
import {
  defineMethod, frameCapFromIdl, geometryOptionsValues, globalsOf, managedRecord, parseFrameCap, resolveElement, warnLegacyOnce, warnRemovedOnce,
} from './validate.js';

/** @typedef {import('../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../contracts/types.js').GeometryApi} GeometryApi */
/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../contracts/types.js').PatchLedger} PatchLedger */

/**
 * `this` of every canvas member; a foreign receiver is a WebIDL "Illegal invocation".
 * @param {HicEnv} env
 * @param {unknown} self
 * @returns {HTMLCanvasElement}
 * @throws TypeError
 */
function brand(env, self) {
  if (!(self instanceof globalsOf(env).HTMLCanvasElement)) throw new TypeError('Illegal invocation');
  return self;
}

/**
 * Own accessor of HTMLCanvasElement.prototype.
 * @param {PatchLedger} ledger
 * @param {object} proto
 * @param {string} name
 * @param {() => unknown} get
 * @param {(v: unknown) => void} set
 */
function defineAccessor(ledger, proto, name, get, set) {
  // Native accessors are named `get <attr>` / `set <attr>`; an anonymous function would show in stack traces and `Function.name`.
  Object.defineProperty(get, 'name', { value: `get ${name}`, configurable: true });
  Object.defineProperty(set, 'name', { value: `set ${name}`, configurable: true });
  ledger.define(proto, name, { get, set, configurable: true, enumerable: true });
}

// ---------------------------------------------------------------------------------------------- attributes and event handlers

/**
 * A `content` / `layoutsubtree` attribute changed through the DOM API: hand the canvas to the registry NOW, so layout reads right after
 * `canvas.content = 'drawable'` already see the relocated children (the registry's MutationObserver would only run in a microtask).
 * @param {HicEnv} env
 * @param {Element} el
 * @param {string} name  attribute name as passed by the caller
 * @param {boolean} present  the attribute exists after the call
 */
function attributeChanged(env, el, name, present) {
  const lower = name.toLowerCase();
  const legacy = lower === 'layoutsubtree' && env.options.legacyNames;
  if (lower !== 'content' && !legacy) return;
  if (!(el instanceof globalsOf(env).HTMLCanvasElement)) return;
  if (legacy && present) warnLegacyOnce(env);
  if (el.isConnected) env.adopt(el);
}

/**
 * Element.prototype.setAttribute / removeAttribute / toggleAttribute observe the two names that (un)manage a canvas. The length test keeps the hot path
 * (every attribute write of the page) to one string-length comparison.
 * @param {HicEnv} env
 * @param {PatchLedger} ledger
 */
function installAttributeHooks(env, ledger) {
  const proto = globalsOf(env).Element.prototype;
  for (const method of /** @type {const} */ (['setAttribute', 'removeAttribute', 'toggleAttribute'])) {
    ledger.wrap(proto, method, (original) => /** @this {Element} */ function (/** @type {unknown} */ name) {
      const result = Reflect.apply(original, this, arguments);
      if (typeof name === 'string' && (name.length === 7 || name.length === 13)) {
        attributeChanged(env, this, name, method === 'toggleAttribute' ? Boolean(result) : method === 'setAttribute');
      }
      return result;
    });
  }
}

/**
 * @param {HicEnv} env
 * @param {PatchLedger} ledger
 * @param {object} proto
 */
function installContentAndHandlers(env, ledger, proto) {
  defineAccessor(ledger, proto, 'content',
    /** @this {HTMLCanvasElement} */ function () {
      const v = brand(env, this).getAttribute('content');
      return v !== null && v.toLowerCase() === 'drawable' ? 'drawable' : 'fallback';
    },
    /** @this {HTMLCanvasElement} */ function (v) {
      brand(env, this).setAttribute('content', String(v));
    });
  for (const type of [EVENTS.PAINT, EVENTS.ELEMENT_GEOMETRY_UPDATE]) {
    defineAccessor(ledger, proto, `on${type}`,
      /** @this {HTMLCanvasElement} */ function () { return getEventHandler(env, brand(env, this), type); },
      /** @this {HTMLCanvasElement} */ function (v) { setEventHandler(env, brand(env, this), type, v); });
  }
  // The handler listener of an `onpaint="..."` attribute must sit where the attribute was set, i.e. before listeners the page adds later.
  env.bus.on(BUS.CANVAS_MOUNTED, ({ record }) => {
    ensureHandlerListener(env, record.canvas, EVENTS.PAINT);
    ensureHandlerListener(env, record.canvas, EVENTS.ELEMENT_GEOMETRY_UPDATE);
  });
}

/**
 * The frame cap extension's IDL property `canvas.frameCap`, reflecting the `framecap` attribute. Also defined in the native modes, where it
 * bounds the effect frames of an effects host (src/effects/frame-source.js reads the attribute); nothing of the standard surface is touched.
 * @param {HicEnv} env
 * @param {PatchLedger} ledger
 */
export function installFrameCapProperty(env, ledger) {
  const proto = globalsOf(env).HTMLCanvasElement.prototype;
  if (Object.prototype.hasOwnProperty.call(proto, EXT.FRAME_CAP_PROP)) return;
  defineAccessor(ledger, proto, EXT.FRAME_CAP_PROP,
    /** @this {HTMLCanvasElement} */ function () {
      return parseFrameCap(brand(env, this).getAttribute(EXT.FRAME_CAP_ATTR), env.options.defaultFrameCap);
    },
    /** @this {HTMLCanvasElement} */ function (v) {
      brand(env, this).setAttribute(EXT.FRAME_CAP_ATTR, String(frameCapFromIdl(v)));
    });
}

/**
 * Extensions and legacy names: framecap / frameCap (the schedule module observes the attribute) and layoutSubtree.
 * @param {HicEnv} env
 * @param {PatchLedger} ledger
 * @param {object} proto
 */
function installExtensions(env, ledger, proto) {
  installFrameCapProperty(env, ledger);
  if (!env.options.legacyNames) return;
  defineAccessor(ledger, proto, 'layoutSubtree',
    /** @this {HTMLCanvasElement} */ function () { return brand(env, this).hasAttribute('layoutsubtree'); },
    /** @this {HTMLCanvasElement} */ function (v) {
      warnLegacyOnce(env);
      brand(env, this).toggleAttribute('layoutsubtree', Boolean(v));
    });
}

// ---------------------------------------------------------------------------------------------- methods

/**
 * @param {HicEnv} env
 * @param {PatchLedger} ledger
 * @param {object} proto
 * @param {GeometryApi} geometry
 */
function installMethods(env, ledger, proto, geometry) {
  defineMethod(ledger, proto, 'requestPaint', 0, /** @this {HTMLCanvasElement} */ function () {
    const canvas = brand(env, this);
    const record = managedRecord(env, canvas);
    if (record?.state === 'active') env.scheduler.requestPaint(record);
    else if (!record) requestIdlePaint(env, canvas);
  });

  defineMethod(ledger, proto, 'captureElementImage', 1, /** @this {HTMLCanvasElement} */ function (/** @type {unknown} */ element) {
    const canvas = brand(env, this);
    if (arguments.length < 1) throw new TypeError("Failed to execute 'captureElementImage': 1 argument required, but only 0 present.");
    // The IDL takes an Element only. Accepting an ElementImage would pin the NEWEST version and break the "never changes afterwards" guarantee of the image passed in.
    if (elementImageVersion(element)) throw new TypeError("Failed to execute 'captureElementImage': parameter 1 is not of type 'Element'.");
    const { record, version } = resolveElement(env, canvas, element, 'snapshot');
    return createElementImage(env, record, /** @type {NonNullable<typeof version>} */ (version));
  });

  defineMethod(ledger, proto, 'getElementImageDefaultSize', 1, /** @this {HTMLCanvasElement} */ function (/** @type {unknown} */ element) {
    const canvas = brand(env, this);
    if (arguments.length < 1) throw new TypeError("Failed to execute 'getElementImageDefaultSize': 1 argument required, but only 0 present.");
    return elementImageDefaultSize(env, canvas, canvas, element);
  });

  defineMethod(ledger, proto, 'updateElementGeometry', 1, /** @this {HTMLCanvasElement} */ function (/** @type {unknown} */ element, /** @type {unknown} */ options = {}) {
    const canvas = brand(env, this);
    if (arguments.length < 1) throw new TypeError("Failed to execute 'updateElementGeometry': 1 argument required, but only 0 present.");
    const values = geometryOptionsValues(options);
    const resolved = resolveElement(env, canvas, element, 'eligible');
    geometry.update(resolved.record, resolved.element, geometryOptionsFromValues(values));
  });

  defineMethod(ledger, proto, 'clearElementGeometry', 1, /** @this {HTMLCanvasElement} */ function (/** @type {unknown} */ element) {
    const canvas = brand(env, this);
    if (arguments.length < 1) throw new TypeError("Failed to execute 'clearElementGeometry': 1 argument required, but only 0 present.");
    const resolved = resolveElement(env, canvas, element, 'eligible');
    geometry.clear(resolved.record, resolved.element);
  });

  // One argument (the two-argument draft overload was removed from the specification and the WPT on 2026-10-09, WPT b59184b6): a further argument is ignored, as WebIDL does.
  defineMethod(ledger, proto, 'getElementTransform', 1, /** @this {HTMLCanvasElement} */ function (/** @type {unknown} */ element) {
    const canvas = brand(env, this);
    if (arguments.length < 1) throw new TypeError("Failed to execute 'getElementTransform': 1 argument required, but only 0 present.");
    if (arguments.length > 1) {
      warnRemovedOnce(env, 'getElementTransform-two-arguments', 'getElementTransform(element, drawTransform) was removed from the specification on 2026-10-09: '
        + 'the second argument is ignored and the result is the element\'s canvas transform (API-CONTRACT 4.7 shows how to derive the old value).');
    }
    const resolved = resolveElement(env, canvas, element, 'eligible');
    return geometry.get(resolved.record, resolved.element);
  });
}

/**
 * getElementImageDefaultSize (spec "get the element image default size"): the snapshot an Element or ElementImage resolves to, scaled to the CURRENT bitmap of
 * `bitmap` (the canvas, or the OffscreenCanvas transferred from it). InvalidStateError before a snapshot, for a closed image and for an image of another canvas
 * (the WPT expects InvalidStateError where the PR text says TypeError; section 6.3 of API-CONTRACT).
 * @param {HicEnv} env
 * @param {HTMLCanvasElement} canvas  the canvas the element must belong to (an OffscreenCanvas's placeholder)
 * @param {{width: number, height: number}} bitmap
 * @param {unknown} element
 * @returns {{width: number, height: number}}
 */
export function elementImageDefaultSize(env, canvas, bitmap, element) {
  const { version } = resolveElement(env, canvas, element, 'snapshot');
  return defaultSizeOf(/** @type {NonNullable<typeof version>} */ (version), bitmap);
}

// ---------------------------------------------------------------------------------------------- width / height

/**
 * Writing canvas.width/height clears the bitmap. The README's ResizeObserver example does it inside the observer callback, so the grid scale is refreshed from the layer at once
 * (the polyfill's own ResizeObserver may run later) and ONE microtask repaints in the SAME frame: a microtask checkpoint follows every ResizeObserver callback.
 * @param {HicEnv} env
 * @param {PatchLedger} ledger
 * @param {object} proto
 */
function installSizeSetters(env, ledger, proto) {
  /** @type {WeakSet<CanvasRecord>} */
  const queued = new WeakSet();

  /** @param {CanvasRecord} record */
  const repaint = (record) => {
    queued.delete(record);
    if (record.state !== 'active') return;
    try {
      env.scheduler.paintNow(record);
    } catch (err) {
      env.reporter.caught(err, 'canvas-size-paint');
    }
  };

  /** @param {HTMLCanvasElement} canvas */
  const resized = (canvas) => {
    const record = env.registry.get(canvas);
    if (!record || record.state !== 'active' || !record.layer) return;
    try {
      record.layer.syncPresentation();
    } catch (err) {
      env.reporter.caught(err, 'canvas-size-sync');
    }
    // Inside a paint handler the app clears the bitmap in order to redraw it right after (native does not repaint on a size write): a repaint here would loop forever.
    if (isPaintDispatching(record) || queued.has(record)) return;
    queued.add(record);
    globalsOf(env).queueMicrotask(() => repaint(record));
  };

  for (const name of ['width', 'height']) {
    const original = Object.getOwnPropertyDescriptor(proto, name);
    if (!original?.set || !original.get) continue;
    const { get, set } = original;
    defineAccessor(ledger, proto, name, get, /** @this {HTMLCanvasElement} */ function (v) {
      Reflect.apply(set, this, [v]);
      resized(this);
    });
  }
}

/**
 * All through the ledger. `content` reflects only fallback|drawable. The `content` setter and Element.prototype.setAttribute/removeAttribute/toggleAttribute for a canvas's content/layoutsubtree mount/unmount SYNCHRONOUSLY (env.adopt),
 * so layout reads right after `canvas.content='drawable'` already see the relocated children. requestPaint()/captureElementImage/drawElementImage/updateElementGeometry on a connected content=drawable canvas the registry has not seen yet
 * (observer microtask pending) adopt it first instead of treating it as unmanaged.
 * width/height setters call the original, refresh the grid scale (record.layer.syncPresentation, not the ResizeObserver) and queue ONE microtask that calls env.scheduler.paintNow(record): a ResizeObserver-driven resize (README example) redraws in the SAME frame
 * (a microtask checkpoint follows every RO callback; measured on Chrome 154); a write INSIDE a paint dispatch (checked synchronously in the setter) queues nothing, like native.
 * Legacy names only when options.legacyNames.
 * @param {HicEnv} env
 * @param {PatchLedger} ledger
 * @param {GeometryApi} geometry
 */
export function installCanvasPatches(env, ledger, geometry) {
  const proto = globalsOf(env).HTMLCanvasElement.prototype;
  installAttributeHooks(env, ledger);
  installContentAndHandlers(env, ledger, proto);
  installExtensions(env, ledger, proto);
  installMethods(env, ledger, proto, geometry);
  installSizeSetters(env, ledger, proto);
}
