/**
 * Argument validation and snapshot resolution shared by every surface patch.
 * The exception table is docs/API-CONTRACT.md section 6; the value-level parsers (matrix, rect, options, framecap) are pure and allocate no DOM object.
 * Module: api-surface (src/api/*).
 */

import { HicUnsupportedError, invalidState } from '../contracts/errors.js';
import { EXT } from '../contracts/events.js';
import { createOnceLog } from '../util/once-log.js';
import { IDENTITY16 } from '../util/matrix.js';
import { elementImageVersion } from './element-image.js';

/** @typedef {import('../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../contracts/types.js').SnapshotVersion} SnapshotVersion */

/**
 * @typedef {Object} Resolved
 * @property {CanvasRecord} record
 * @property {Element} element
 * @property {SnapshotVersion|null} version  null when need==='eligible' and no snapshot exists
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

// ---------------------------------------------------------------------------------------------- canvas and element resolution

/**
 * The window of the env with its global constructors (HicEnv.window is typed as the bare `Window`).
 * @param {HicEnv} env
 * @returns {Window & typeof globalThis}
 */
export function globalsOf(env) {
  return /** @type {Window & typeof globalThis} */ (env.window);
}

/** @param {HicEnv} env @param {unknown} canvas @returns {canvas is HTMLCanvasElement} */
function isHtmlCanvas(env, canvas) {
  return canvas instanceof globalsOf(env).HTMLCanvasElement;
}

/** @param {HicEnv} env @param {HTMLCanvasElement} canvas @returns {boolean} the attributes ask for management (the registry decides) */
function wantsManagement(env, canvas) {
  const content = canvas.getAttribute('content');
  return (content !== null && content.toLowerCase() === 'drawable') || (env.options.legacyNames && canvas.hasAttribute('layoutsubtree'));
}

/**
 * The record of a MANAGED canvas (layer mounted, or suspended with display:none), else null. A connected canvas whose attributes already say
 * content=drawable but that the registry has not seen yet (observer microtask pending) is adopted first.
 * @param {HicEnv} env
 * @param {unknown} canvas
 * @returns {CanvasRecord|null}
 */
export function managedRecord(env, canvas) {
  if (!isHtmlCanvas(env, canvas)) return null;
  let record = env.registry.get(canvas);
  if ((!record || record.state === 'detached') && canvas.isConnected && wantsManagement(env, canvas)) {
    env.adopt(canvas);
    record = env.registry.get(canvas);
  }
  return record && (record.state === 'active' || record.state === 'suspended') ? record : null;
}

/** @param {Element} el @returns {string} */
function describe(el) {
  return el.id ? `${el.localName}#${el.id}` : el.localName;
}

/**
 * Argument conversion of "Element or ElementImage" (WebIDL runs before anything else, including the NaN early return of drawElementImage).
 * @param {HicEnv} env
 * @param {unknown} target
 * @throws TypeError
 */
export function assertTargetType(env, target) {
  if (!(target instanceof globalsOf(env).Element) && !elementImageVersion(target)) {
    throw new TypeError('Parameter 1 is not of type \'Element\' or \'ElementImage\'.');
  }
}

/**
 * Spec "get element image snapshot" / "get the element reference" (docs/API-CONTRACT.md section 6.1). Exact exception table there.
 * need==="snapshot": InvalidStateError when no snapshot; need==="eligible": only eligibility is required (geometry methods).
 * An ElementImage resolves to ITS version (not the newest one) and to its originating element.
 * @param {HicEnv} env
 * @param {HTMLCanvasElement} canvas
 * @param {unknown} target
 * @param {'snapshot'|'eligible'} need
 * @returns {Resolved}
 * @throws TypeError | DOMException InvalidStateError | HicUnsupportedError('svg-drawable')
 */
export function resolveElement(env, canvas, target, need) {
  assertTargetType(env, target);
  const image = elementImageVersion(target);
  if (image) return resolveImage(env, canvas, image, need);
  const element = /** @type {Element} */ (target);
  const record = managedRecord(env, canvas);
  if (!record) throw invalidState('The canvas does not have content="drawable".');
  // An outermost <svg> is a CSS box like any HTML element (captured, measured and hit tested as one); an SVG element INSIDE an <svg> (`<rect drawable>`) has no border box.
  if (element.namespaceURI === SVG_NS && /** @type {SVGElement} */ (element).ownerSVGElement && element.hasAttribute('drawable') && env.registry.logicalCanvasAncestor(element) === canvas) {
    throw refuseSvg(env, canvas, element);
  }
  if (need === 'snapshot') {
    const owner = env.registry.ownerOfDrawable(element);
    if (owner && owner !== record) throw invalidState('The element belongs to another canvas.');
  }
  if (!record.layer || record.layer.nearestDrawable(element) !== element) {
    throw invalidState('The element is not a drawable descendant of this canvas.');
  }
  // No box, no snapshot: a canvas that is detached or display:none renders nothing, and the retained surface of its earlier life must not be served.
  if (need === 'snapshot' && (record.state !== 'active' || record.canvas.getClientRects().length === 0)) {
    throw invalidState('The canvas is not rendered (detached or display:none), so its drawables have no snapshot.');
  }
  const version = env.store.version(element);
  if (need === 'snapshot' && !version) throw invalidState(`The element has no snapshot yet (no first paint, display:none, or its state was reset). Draw from the canvas's paint event or after installed.whenPainted(canvas); `
    + `the paint event waits for the first snapshot up to options.paintGateMaxWaitMs (${env.options.paintGateMaxWaitMs} ms). A very large drawable can need longer: raise paintGateMaxWaitMs, keep the drawable below options.nodeBudget.soft (${env.options.nodeBudget.soft} nodes), or split it into several smaller drawables.`);
  return { record, element, version };
}

/**
 * @param {HicEnv} env
 * @param {HTMLCanvasElement} canvas
 * @param {{version: SnapshotVersion|null, record: CanvasRecord|null, detached: boolean}} image
 * @param {'snapshot'|'eligible'} need
 * @returns {Resolved}
 */
function resolveImage(env, canvas, image, need) {
  if (image.detached || !image.version || !image.record) throw invalidState('The ElementImage is closed.');
  const element = image.version.element.deref();
  if (!element) throw invalidState('The element of this ElementImage no longer exists.');
  if (need === 'snapshot') {
    if (image.record.canvas !== canvas) throw invalidState('The ElementImage was captured from another canvas.');
    return { record: image.record, element, version: image.version };
  }
  const record = managedRecord(env, canvas);
  if (!record) throw invalidState('The canvas does not have content="drawable".');
  if (!record.layer || record.layer.nearestDrawable(element) !== element) {
    throw invalidState('The ElementImage does not belong to a drawable descendant of this canvas.');
  }
  return { record, element, version: env.store.version(element) };
}

/**
 * @param {HicEnv} env @param {HTMLCanvasElement} canvas @param {Element} element
 * @returns {HicUnsupportedError}
 */
function refuseSvg(env, canvas, element) {
  const message = '`drawable` on an SVG element inside an <svg> is not supported by the polyfill (an outermost <svg drawable> is).';
  const hint = 'put `drawable` on the outermost <svg> (or an HTML wrapper) and draw that element';
  env.reporter.unsupported({ feature: 'svg-drawable', message, hint, path: describe(element) }, canvas);
  return new HicUnsupportedError('svg-drawable', message, { hint, path: describe(element) });
}

// ---------------------------------------------------------------------------------------------- DOMMatrixInit / DOMRectInit

/** @type {ReadonlyArray<string>} */
const M_KEYS = ['m11', 'm12', 'm13', 'm14', 'm21', 'm22', 'm23', 'm24', 'm31', 'm32', 'm33', 'm34', 'm41', 'm42', 'm43', 'm44'];
/** @type {ReadonlyArray<readonly [string, number]>} 2D alias, index in M_KEYS */
const ALIASES = [['a', 0], ['b', 1], ['c', 4], ['d', 5], ['e', 12], ['f', 13]];
/** Indices of the members that must keep their identity value in a 2D matrix. */
const THREE_D_ONLY = [2, 3, 6, 7, 8, 9, 10, 11, 14, 15];

/** @param {Record<string, unknown>} o @param {string} k @returns {number|undefined} */
function member(o, k) {
  const v = o[k];
  return v === undefined ? undefined : +(/** @type {any} */ (v));
}

/** @param {number} a @param {number} b @returns {boolean} SameValueZero */
function sameValueZero(a, b) {
  return a === b || (a !== a && b !== b);
}

/**
 * DOMMatrixInit -> 16 values + is2D, following "validate and fixup" of the geometry spec; no DOM object is created.
 * @param {unknown} init  undefined and null mean the identity
 * @returns {{values: number[], is2D: boolean}}
 * @throws TypeError on conflicting aliases ({a:1, m11:2}), or is2D:true with 3D members
 */
export function matrixInitValues(init) {
  const values = Array.from(IDENTITY16);
  if (init === undefined || init === null) return { values, is2D: true };
  if (typeof init !== 'object' && typeof init !== 'function') throw new TypeError('The matrix init is not an object.');
  const o = /** @type {Record<string, unknown>} */ (init);
  /** @type {boolean} */ let threeD = false;
  M_KEYS.forEach((key, i) => {
    const v = member(o, key);
    if (v !== undefined) values[i] = v;
    if (v !== undefined && THREE_D_ONLY.includes(i) && !sameValueZero(v, IDENTITY16[i])) threeD = true;
  });
  for (const [alias, index] of ALIASES) {
    const v = member(o, alias);
    if (v === undefined) continue;
    if (member(o, M_KEYS[index]) !== undefined && !sameValueZero(v, values[index])) {
      throw new TypeError(`The matrix init has conflicting members '${alias}' and '${M_KEYS[index]}'.`);
    }
    values[index] = v;
  }
  const is2DMember = o.is2D;
  const is2D = is2DMember === undefined ? !threeD : Boolean(is2DMember);
  if (is2D && threeD) throw new TypeError('The matrix init is 2D (is2D: true) but has 3D members.');
  return { values, is2D };
}

/**
 * DOMRectInit -> {x,y,width,height}; absent members are 0. The members are `unrestricted double`: NaN and Infinity are accepted, as natively.
 * @param {unknown} init
 * @returns {{x: number, y: number, width: number, height: number}}
 * @throws TypeError on a non-object
 */
export function rectInitValues(init) {
  if (init === undefined || init === null) return { x: 0, y: 0, width: 0, height: 0 };
  if (typeof init !== 'object' && typeof init !== 'function') throw new TypeError('The rect init is not an object.');
  const o = /** @type {Record<string, unknown>} */ (init);
  return { x: member(o, 'x') ?? 0, y: member(o, 'y') ?? 0, width: member(o, 'width') ?? 0, height: member(o, 'height') ?? 0 };
}

/**
 * A clip rect with negative dimensions is normalised to the same rectangle with positive ones (WPT elementsFromPoint-update-element-geometry "Negative clip is normalized").
 * @param {{x: number, y: number, width: number, height: number}} r
 * @returns {{x: number, y: number, width: number, height: number}}
 */
function normalizedRect(r) {
  return {
    x: r.width < 0 ? r.x + r.width : r.x, y: r.height < 0 ? r.y + r.height : r.y,
    width: Math.abs(r.width), height: Math.abs(r.height),
  };
}

/**
 * UpdateElementGeometryOptions at value level: both `clip` and `canvasClip` are accepted (`clip` wins, the spec text and the IDL disagree).
 * @param {unknown} options
 * @returns {{preserveHitTestOrder: boolean, transform: {values: number[], is2D: boolean}|undefined, clip: {x: number, y: number, width: number, height: number}|undefined}}
 * @throws TypeError
 */
export function geometryOptionsValues(options) {
  if (options !== undefined && options !== null && typeof options !== 'object' && typeof options !== 'function') {
    throw new TypeError('The geometry options are not an object.');
  }
  const o = /** @type {Record<string, unknown>} */ (options ?? {});
  const clipInit = o.clip !== undefined ? o.clip : o.canvasClip;
  return {
    preserveHitTestOrder: Boolean(o.preserveHitTestOrder),
    transform: o.canvasTransform === undefined ? undefined : matrixInitValues(o.canvasTransform),
    clip: clipInit === undefined ? undefined : normalizedRect(rectInitValues(clipInit)),
  };
}

// ---------------------------------------------------------------------------------------------- extension and legacy helpers

/**
 * The `framecap` attribute: HTML "rules for parsing non-negative integers" (leading whitespace, optional +, digits, trailing garbage ignored),
 * clamped to EXT.FRAME_CAP_MAX. Missing or invalid -> defaultCap.
 * @param {string|null} value
 * @param {number} defaultCap
 * @returns {number}
 */
export function parseFrameCap(value, defaultCap) {
  const m = value === null ? null : /^[ \t\n\f\r]*\+?(\d+)/.exec(value);
  return m ? Math.min(EXT.FRAME_CAP_MAX, Number.parseInt(m[1], 10)) : defaultCap;
}

/**
 * The IDL setter of `frameCap` (unsigned long): ToUint32, then the extension's clamp.
 * @param {unknown} v
 * @returns {number}
 */
export function frameCapFromIdl(v) {
  const n = Math.trunc(+(/** @type {any} */ (v)));
  const u32 = Number.isFinite(n) ? ((n % 4294967296) + 4294967296) % 4294967296 : 0;
  return Math.min(EXT.FRAME_CAP_MAX, u32);
}

/** @type {WeakMap<object, ReturnType<typeof createOnceLog>>} */
const legacyLogs = new WeakMap();

/**
 * One console.warn per install the first time a legacy (pre-2026-09) name is used (feature layoutsubtree-legacy).
 * @param {HicEnv} env
 */
export function warnLegacyOnce(env) {
  let log = legacyLogs.get(env);
  if (!log) legacyLogs.set(env, log = createOnceLog(globalsOf(env).console));
  const first = log.once('layoutsubtree-legacy', 'warn',
    '[hic-live-polyfill] `layoutsubtree` / `layoutSubtree` is the pre-2026-09 name of `content="drawable"`; add the `drawable` attribute to the elements you draw and switch to `content="drawable"`.');
  if (first) env.reporter.deviation('layoutsubtree-legacy', 'legacy attribute or property used');
}

// ---------------------------------------------------------------------------------------------- definition helper

/**
 * Define a method through the ledger with the IDL `length` and a stable name (a rest-parameter function would report length 0).
 * @param {import('../contracts/types.js').PatchLedger} ledger
 * @param {object} target
 * @param {string} name
 * @param {number} length  number of required IDL arguments
 * @param {Function} fn
 */
export function defineMethod(ledger, target, name, length, fn) {
  Object.defineProperty(fn, 'name', { value: name, configurable: true });
  Object.defineProperty(fn, 'length', { value: length, configurable: true });
  ledger.define(target, name, { value: fn, writable: true, configurable: true, enumerable: true });
}
