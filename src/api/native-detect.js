/**
 * Behavioural native probe and browser gate (side-effect free; never trusts `in` alone: members are read as descriptors, content reflection is exercised on a detached canvas).
 * Module: api-core. Implemented.
 *
 * Measured shapes (Chrome 154 and Canary 157): the paint event interface is NOT a global in either build, and neither has
 * ElementImage.toImageBitmap or frameCap (both are polyfill extensions). They are therefore not part of the completeness decision.
 */

import { carriesMark } from './patch.js';
import { engineOf } from '../util/engine.js';

/** @typedef {import('../contracts/types.js').NativeState} NativeState */

/** Names the CURRENT spec requires. A build missing one is `partial` and never gap-filled. */
export const CORE_NAMES = Object.freeze([
  'content', 'onpaint', 'requestPaint', 'captureElementImage', 'getElementTransform', 'updateElementGeometry', 'clearElementGeometry',
  'CanvasRenderingContext2D.drawElementImage', 'OffscreenCanvasRenderingContext2D.drawElementImage', 'ElementImage',
]);

/** Names that may be missing on an otherwise complete build; they are gap-filled in mode native-bridged. */
export const ADDITIVE_NAMES = Object.freeze([
  'onelementgeometryupdate', 'ElementGeometryUpdateEvent', 'WebGLRenderingContext.texElementSubImage2D', 'WebGL2RenderingContext.texElementSubImage2D',
  'GPUQueue.drawElementImageToTexture',
]);

/** Pre-2026-09 names. `layoutSubtree` plus a missing `content` is the legacy shape. */
export const LEGACY_NAMES = Object.freeze([
  'layoutSubtree', 'WebGLRenderingContext.texElementImage2D', 'WebGL2RenderingContext.texElementImage2D', 'GPUQueue.copyElementImageToTexture',
]);

/**
 * @typedef {Object} Observation  What the probe saw. `applicable` lists the names that CAN exist in this window (no WebGPU class, no GPUQueue names).
 * @property {string[]} present
 * @property {string[]} applicable
 * @property {number|null} browserMajor
 */

/**
 * Pure decision table: observation -> NativeState. Unit-tested without a DOM.
 * @param {Observation} obs
 * @returns {NativeState}
 */
export function classifyNative(obs) {
  const has = new Set(obs.present);
  const applicable = new Set(obs.applicable);
  const coreMissing = CORE_NAMES.filter((n) => applicable.has(n) && !has.has(n));
  const gaps = ADDITIVE_NAMES.filter((n) => applicable.has(n) && !has.has(n));
  const legacyNames = LEGACY_NAMES.filter((n) => has.has(n));
  const seen = [...CORE_NAMES, ...ADDITIVE_NAMES].some((n) => has.has(n)) || legacyNames.length > 0;

  /** @type {NativeState['kind']} */
  let kind;
  if (!seen) kind = 'absent';
  else if (coreMissing.length === 0) kind = gaps.length === 0 ? 'complete' : 'partial';
  else if (coreMissing.length === 1 && coreMissing[0] === 'content' && has.has('layoutSubtree')) kind = 'legacy';
  else kind = 'partial';

  return {
    kind,
    present: [...has],
    missing: kind === 'absent' ? [] : [...coreMissing, ...gaps],
    legacyNames,
    gaps: kind === 'absent' ? [] : [...gaps],
    fillable: kind === 'partial' && coreMissing.length === 0 && gaps.length > 0,
    browserMajor: obs.browserMajor,
  };
}

/**
 * First descriptor of `key` along the prototype chain, or null when absent or stamped by a polyfill (ours or a foreign copy): a patched member is not native.
 * @param {object|undefined|null} obj
 * @param {PropertyKey} key
 * @returns {PropertyDescriptor|null}
 */
function nativeDescriptor(obj, key) {
  for (let o = obj; o; o = Object.getPrototypeOf(o)) {
    const d = Object.getOwnPropertyDescriptor(o, key);
    if (d) return carriesMark(d) ? null : d;
  }
  return null;
}

/** @param {object|undefined|null} proto @param {string} key */
const hasMethod = (proto, key) => typeof nativeDescriptor(proto, key)?.value === 'function';
/** @param {object|undefined|null} proto @param {string} key */
const hasAccessor = (proto, key) => typeof nativeDescriptor(proto, key)?.get === 'function';

/** @param {any} win @param {string} name @returns {Function|null} a native (unstamped) global constructor */
function nativeGlobal(win, name) {
  const d = Object.getOwnPropertyDescriptor(win, name);
  return d && typeof d.value === 'function' && !carriesMark(d) ? d.value : null;
}

/** @param {Function|null} Ctor @param {string} type @returns {boolean} the class is really constructible as an event */
function constructsEvent(Ctor, type) {
  if (!Ctor) return false;
  try { return /** @type {any} */ (new (/** @type {any} */ (Ctor))(type)).type === type; } catch { return false; }
}

/** `content` must exist as a native accessor AND reflect only fallback|drawable. @param {any} win */
function contentReflects(win) {
  if (!hasAccessor(win.HTMLCanvasElement?.prototype, 'content')) return false;
  try {
    const c = win.document.createElement('canvas');
    c.setAttribute('content', 'drawable');
    if (c.content !== 'drawable') return false;
    c.setAttribute('content', 'bogus');
    if (c.content !== 'fallback') return false;
    c.removeAttribute('content');
    return c.content === 'fallback';
  } catch { return false; }
}

/**
 * @param {any} win
 * @returns {Observation}
 */
function observe(win) {
  /** @type {Set<string>} */ const present = new Set();
  /** @type {Set<string>} */ const applicable = new Set([...CORE_NAMES, ...ADDITIVE_NAMES, ...LEGACY_NAMES]);
  /** @param {string} name @param {boolean} ok */
  const note = (name, ok) => { if (ok) present.add(name); };
  /** @param {string} name */
  const optionalClass = (name) => { if (!win[name]) for (const n of applicable) if (n.startsWith(`${name}.`)) applicable.delete(n); };

  const canvas = win.HTMLCanvasElement?.prototype;
  note('content', contentReflects(win));
  note('layoutSubtree', hasAccessor(canvas, 'layoutSubtree'));
  note('onpaint', hasAccessor(canvas, 'onpaint'));
  note('onelementgeometryupdate', hasAccessor(canvas, 'onelementgeometryupdate'));
  for (const m of ['requestPaint', 'captureElementImage', 'getElementTransform', 'updateElementGeometry', 'clearElementGeometry']) note(m, hasMethod(canvas, m));

  for (const cls of ['CanvasRenderingContext2D', 'OffscreenCanvasRenderingContext2D']) {
    optionalClass(cls);
    note(`${cls}.drawElementImage`, hasMethod(win[cls]?.prototype, 'drawElementImage'));
  }
  const image = nativeGlobal(win, 'ElementImage');
  note('ElementImage', !!image && hasAccessor(image.prototype, 'width') && hasMethod(image.prototype, 'close'));
  note('ElementGeometryUpdateEvent', constructsEvent(nativeGlobal(win, 'ElementGeometryUpdateEvent'), 'elementgeometryupdate'));

  for (const cls of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
    optionalClass(cls);
    note(`${cls}.texElementSubImage2D`, hasMethod(win[cls]?.prototype, 'texElementSubImage2D'));
    note(`${cls}.texElementImage2D`, hasMethod(win[cls]?.prototype, 'texElementImage2D'));
  }
  optionalClass('GPUQueue');
  note('GPUQueue.drawElementImageToTexture', hasMethod(win.GPUQueue?.prototype, 'drawElementImageToTexture'));
  note('GPUQueue.copyElementImageToTexture', hasMethod(win.GPUQueue?.prototype, 'copyElementImageToTexture'));

  return { present: [...present], applicable: [...applicable], browserMajor: readBrowser(win).major };
}

/**
 * @param {any} win
 * @returns {import('../util/engine.js').EngineInfo}
 */
function readBrowser(win) {
  return engineOf(win.navigator);
}

/**
 * Build a detached canvas and test every name of the CURRENT spec (docs/API-CONTRACT.md section 2). Fills NativeState.gaps and NativeState.fillable:
 * a build that has every CORE name but lacks only ADDITIVE names is `partial` with fillable=true (gap-fill, not refusal).
 * @param {Window} win
 * @returns {NativeState}
 */
export function probeNative(win) {
  return classifyNative(observe(win));
}

/** Oldest Chromium major the design is expected to work on (anchor positioning is 125; only 154 and Canary 157 were measured). */
export const MIN_CHROMIUM_MAJOR = 130;
/** Oldest Firefox and Safari majors: the measured ones (G-xbrowser, 2026-10-09: Firefox 155.0.1, Safari 27.0.1 on macOS); older ones are unverified and refused. */
export const MIN_FIREFOX_MAJOR = 155;
export const MIN_SAFARI_MAJOR = 27;

/** Platform features the polyfill path cannot run without (checked on every engine, so a gap is named, not guessed from the version). @param {any} win @returns {string[]} */
export function missingRequirements(win) {
  const missing = [];
  const supports = (/** @type {string} */ p, /** @type {string} */ v) => { try { return !!win.CSS?.supports?.(p, v); } catch { return false; } };
  if (!supports('anchor-name', '--a') || !supports('position-anchor', '--a')) missing.push('CSS anchor positioning');
  if (typeof win.ResizeObserver !== 'function') missing.push('ResizeObserver');
  if (typeof win.HTMLImageElement?.prototype?.decode !== 'function') missing.push('HTMLImageElement.decode');
  if (typeof win.CSSStyleSheet?.prototype?.replaceSync !== 'function' || !('adoptedStyleSheets' in (win.document ?? {}))) missing.push('constructable stylesheets');
  return missing;
}

/**
 * Desktop Chromium >= 130, Firefox >= 155 or Safari >= 27, with every required platform feature. Pure function of the user agent and feature probes.
 * @param {Window} win
 * @returns {{ok: boolean, major: number|null, engine: string, reason?: string}}
 */
export function browserGate(win) {
  const b = readBrowser(win);
  const no = (/** @type {string} */ reason) => ({ ok: false, major: b.major, engine: b.engine, reason });
  if (b.mobile) return no('mobile browsers are not supported');
  const floor = b.engine === 'chromium' ? MIN_CHROMIUM_MAJOR : b.engine === 'gecko' ? MIN_FIREFOX_MAJOR : b.engine === 'webkit' ? MIN_SAFARI_MAJOR : null;
  const name = b.engine === 'chromium' ? 'Chromium' : b.engine === 'gecko' ? 'Firefox' : 'Safari';
  if (floor === null) return no('not a Chromium, Firefox or Safari desktop browser');
  if (b.major === null || b.major < floor) return no(`${name} ${b.major ?? '?'} is older than the supported minimum ${floor}`);
  const missing = missingRequirements(win);
  if (missing.length) return no(`${name} ${b.major} lacks ${missing.join(', ')}`);
  return { ok: true, major: b.major, engine: b.engine };
}

/**
 * @typedef {Object} ModeDecision
 * @property {import('../contracts/types.js').HicMode} mode  'refused' when `refusal` is set
 * @property {{feature: 'browser'|'partial-native', message: string, hint: string}|null} refusal
 */

/** @param {'browser'|'partial-native'} feature @param {string} message @param {string} hint @returns {ModeDecision} */
const refuse = (feature, message, hint) => ({ mode: 'refused', refusal: { feature, message, hint } });

/**
 * Pure decision table (docs/API-CONTRACT.md section 2): native probe x browser gate x options -> mode or refusal.
 * `forcePolyfill` is the single override of a present native; `mode:'native-only'` wins over it.
 * @param {NativeState} native
 * @param {{ok: boolean, reason?: string}} gate
 * @param {{mode: 'auto'|'polyfill'|'native-only', forcePolyfill: boolean}} opts
 * @returns {ModeDecision}
 */
export function decideMode(native, gate, opts) {
  const gateRefusal = () => refuse('browser', `unsupported browser: ${gate.reason ?? 'browser gate failed'}`,
    `use a desktop Chromium-family browser (Chrome, Edge) >= ${MIN_CHROMIUM_MAJOR}, Firefox >= ${MIN_FIREFOX_MAJOR} or Safari >= ${MIN_SAFARI_MAJOR} (docs/SUPPORT-MATRIX.md, Browsers)`);
  const present = native.kind !== 'absent';

  if (opts.mode === 'native-only') {
    if (native.kind === 'complete') return { mode: 'native', refusal: null };
    return refuse(present ? 'partial-native' : 'browser',
      present ? `mode "native-only" needs a complete native implementation, found "${native.kind}" (missing: ${native.missing.join(', ') || 'none'})`
        : 'mode "native-only" needs a native HTML-in-Canvas implementation and this browser has none',
      'use mode "auto" so the polyfill can complement or replace the missing parts');
  }
  if (opts.forcePolyfill) return gate.ok ? { mode: 'polyfill', refusal: null } : gateRefusal();

  if (!present) return gate.ok ? { mode: 'polyfill', refusal: null } : gateRefusal();
  if (opts.mode === 'polyfill') {
    return refuse('partial-native', `mode "polyfill" cannot override a native implementation (kind "${native.kind}"); a present native is never replaced`,
      'use mode "auto", or options.forcePolyfill in tests');
  }
  if (native.kind === 'complete') return { mode: 'native', refusal: null };
  if (native.kind === 'legacy' || native.fillable) return { mode: 'native-bridged', refusal: null };
  return refuse('partial-native', `this browser has a partial native implementation that the polyfill cannot complement (missing core: ${native.missing.join(', ')})`,
    'update the browser or remove the experimental flag; options.forcePolyfill replaces the native parts (tests only)');
}
