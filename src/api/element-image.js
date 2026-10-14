/**
 * ElementImage: immutable handle on one SnapshotVersion. `new ElementImage()` throws TypeError (no constructor in the IDL); width/height are 0 after close() and when the originating canvas is gone; not Transferable (the worker guard reports it);
 * getElementTransform and updateElementGeometry accept (Element or ElementImage).
 * Module: api-surface (src/api/*).
 */

import { invalidState } from '../contracts/errors.js';

/** @typedef {import('../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../contracts/types.js').SnapshotStore} SnapshotStore */
/** @typedef {import('../contracts/types.js').SnapshotVersion} SnapshotVersion */

/**
 * The unpin obligation of one ElementImage. Shared with the FinalizationRegistry, so it must not reference the image.
 * @typedef {{store: SnapshotStore, version: SnapshotVersion, released: boolean}} Pin
 */
/** @typedef {{env: HicEnv, record: CanvasRecord, pin: Pin, detached: boolean}} ImageState */

const CREATE = Symbol('hic.create-element-image');
const NOT_CLONEABLE = 'hic:not-cloneable';

/** @type {WeakMap<object, ImageState>} */
const states = new WeakMap();

/** @param {Pin} pin */
function release(pin) {
  if (pin.released) return;
  pin.released = true;
  pin.store.unpin(pin.version);
}

/** A never-closed ElementImage must not pin its surface forever. */
const finalizer = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry(release) : null;

/** @param {unknown} self @returns {ImageState} */
function stateOf(self) {
  const state = typeof self === 'object' && self !== null ? states.get(self) : undefined;
  if (!state) throw new TypeError('Illegal invocation');
  return state;
}

/** @param {ImageState} state @param {'w'|'h'} axis @returns {number} */
function gridSize(state, axis) {
  if (state.detached || state.record.state === 'disposed') return 0;
  const v = state.pin.version;
  const canvasSize = axis === 'w' ? v.canvasWidth : v.canvasHeight;
  if (!(canvasSize > 0)) return 0;
  return axis === 'w' ? v.width * (state.record.canvas.width / canvasSize) : v.height * (state.record.canvas.height / canvasSize);
}

export class ElementImage {
  /** @param {unknown[]} args the creation token (a rest parameter keeps `ElementImage.length` at 0, as the interface has no constructor) */
  constructor(...args) {
    if (args[0] !== CREATE) throw new TypeError('Illegal constructor');
  }
  /** Default draw width in grid px: version.width * (canvas.width / version.canvasWidth); 0 when closed or the canvas is gone. @returns {number} */
  get width() {
    return gridSize(stateOf(this), 'w');
  }
  /** @returns {number} */
  get height() {
    return gridSize(stateOf(this), 'h');
  }
  /** Idempotent: detach, unpin the version. */
  close() {
    const state = stateOf(this);
    if (state.detached) return;
    state.detached = true;
    finalizer?.unregister(this);
    release(state.pin);
  }
  /** Extension: transferable copy of the pinned surface (full source rect). @returns {Promise<ImageBitmap>} @throws InvalidStateError when closed */
  async toImageBitmap() {
    const state = stateOf(this);
    if (state.detached) throw invalidState('The ElementImage is closed.');
    const v = state.pin.version;
    const src = state.env.store.rasterSource(v, { sx: 0, sy: 0, sw: v.width, sh: v.height });
    if (!src) throw invalidState('The ElementImage has no pixels to copy.');
    return state.env.window.createImageBitmap(src.source, src.sx, src.sy, src.sw, src.sh);
  }
}

// WebIDL attributes and operations are enumerable; class members are not.
for (const key of ['width', 'height', 'close']) Object.defineProperty(ElementImage.prototype, key, { enumerable: true });
Object.defineProperty(ElementImage.prototype, Symbol.toStringTag, { value: 'ElementImage', configurable: true });

/**
 * Pin the version and wrap it; registers a FinalizationRegistry unpin.
 * @param {HicEnv} env
 * @param {CanvasRecord} record
 * @param {SnapshotVersion} version
 * @returns {ElementImage}
 * @throws InvalidStateError when the drawable of the version is gone
 */
export function createElementImage(env, record, version) {
  const el = version.element.deref();
  if (!el) throw invalidState('The element of this snapshot no longer exists.');
  const store = env.store;
  /** @type {Pin} */
  const pin = { store, version: store.pin(el), released: false };
  const image = new ElementImage(CREATE);
  // Structured clone copies a class instance as an empty object, silently. An own enumerable function makes every clone (nested postMessage,
  // structuredClone, IndexedDB) fail with DataCloneError, as for a non-serializable platform object.
  Object.defineProperty(image, NOT_CLONEABLE, { value: () => undefined, enumerable: true });
  states.set(image, { env, record, pin, detached: false });
  finalizer?.register(image, pin, image);
  return image;
}

/**
 * Internal accessor: the version, the record and detached state of an ElementImage, or null for a foreign object.
 * @param {unknown} img
 * @returns {{version: SnapshotVersion|null, record: CanvasRecord|null, detached: boolean}|null}
 */
export function elementImageVersion(img) {
  const state = typeof img === 'object' && img !== null ? states.get(img) : undefined;
  if (!state) return null;
  return { version: state.detached ? null : state.pin.version, record: state.record, detached: state.detached };
}

/**
 * Define window.ElementImage only when absent (through the ledger).
 * @param {Window} win
 * @param {import('../contracts/types.js').PatchLedger} ledger
 */
export function defineElementImageGlobal(win, ledger) {
  if ('ElementImage' in win) return;
  ledger.define(win, 'ElementImage', { value: ElementImage, writable: true, configurable: true, enumerable: false });
}
