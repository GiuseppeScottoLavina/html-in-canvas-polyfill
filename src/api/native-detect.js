/**
 * Behavioural native probe and browser gate (side-effect free; never trusts `in` alone: members are read as descriptors, content reflection and
 * drawElementImage are exercised on a detached canvas).
 * Module: api-core. Implemented.
 *
 * Policy: the decision rests on the CORE behaviour only (the `content` / legacy `layoutSubtree` markup, the `paint` event handler, a 2D
 * `drawElementImage` that behaves like a platform method). Every other member of the specification is recorded when missing, but a missing,
 * renamed or extra secondary member is never a reason to refuse: the API is still evolving (2026-10-08: ElementImage.width/height were replaced by
 * getElementImageDefaultSize; 2026-10-09: the two-argument getElementTransform was removed), and a browser that ships a usable implementation must
 * keep it. Only a native implementation whose core is missing is refused, because it can neither be used nor be replaced safely.
 *
 * Measured shapes (2026-10-14): Chrome 154 and 155.0.8059.40 with --enable-blink-features=CanvasDrawElement (legacy: layoutSubtree, ElementImage.width/height,
 * texElementImage2D, copyElementImageToTexture); Canary 157.0.8103.0 with or without the flag (current: content, getElementImageDefaultSize on HTMLCanvasElement
 * and OffscreenCanvas, ElementImage with close() only).
 * None exposes ElementImage.toImageBitmap or frameCap (both are extensions of this library), so they are not probed.
 */

import { carriesMark } from './patch.js';
import { engineOf } from '../util/engine.js';

/** @typedef {import('../contracts/types.js').NativeState} NativeState */

/** The core: an implementation with all three is usable and the polyfill steps aside. `content` may be replaced by the legacy `layoutSubtree`. */
export const CORE_NAMES = Object.freeze(['content', 'onpaint', 'CanvasRenderingContext2D.drawElementImage']);

/** The rest of the CURRENT specification (WHATWG HTML PR 11588 at 4cfec766, 2026-10-08). A missing one is recorded, never refused. */
export const SPEC_NAMES = Object.freeze([
  'requestPaint', 'captureElementImage', 'getElementTransform', 'updateElementGeometry', 'clearElementGeometry', 'getElementImageDefaultSize',
  'onelementgeometryupdate', 'OffscreenCanvasRenderingContext2D.drawElementImage', 'OffscreenCanvas.updateElementGeometry', 'OffscreenCanvas.clearElementGeometry',
  'OffscreenCanvas.getElementImageDefaultSize', 'ElementImage', 'ElementGeometryUpdateEvent', 'WebGLRenderingContext.texElementSubImage2D',
  'WebGL2RenderingContext.texElementSubImage2D', 'GPUQueue.drawElementImageToTexture',
]);

/** The SPEC_NAMES the optional native bridge can build from public native API (the size getter and the texture names only from their legacy twins). */
export const ADDITIVE_NAMES = Object.freeze([
  'onelementgeometryupdate', 'ElementGeometryUpdateEvent', 'getElementImageDefaultSize', 'WebGLRenderingContext.texElementSubImage2D', 'WebGL2RenderingContext.texElementSubImage2D',
  'GPUQueue.drawElementImageToTexture',
]);

/** Names of earlier drafts. `layoutSubtree` plus a missing `content` is the legacy shape; the others are informational. */
export const LEGACY_NAMES = Object.freeze([
  'layoutSubtree', 'ElementImage.width', 'WebGLRenderingContext.texElementImage2D', 'WebGL2RenderingContext.texElementImage2D', 'GPUQueue.copyElementImageToTexture',
]);

/** What an additive name is built from in the bridge (null: from nothing native). */
const BUILT_FROM = Object.freeze({
  getElementImageDefaultSize: 'ElementImage.width',
  'WebGLRenderingContext.texElementSubImage2D': 'WebGLRenderingContext.texElementImage2D',
  'WebGL2RenderingContext.texElementSubImage2D': 'WebGL2RenderingContext.texElementImage2D',
  'GPUQueue.drawElementImageToTexture': 'GPUQueue.copyElementImageToTexture',
});

/**
 * @typedef {Object} Observation  What the probe saw. `applicable` lists the names that CAN exist in this window (no WebGPU class, no GPUQueue names).
 * @property {string[]} present
 * @property {string[]} applicable
 * @property {number|null} browserMajor
 * @property {NativeState['probe']} [probe]  how 2D drawElementImage behaved on a detached drawable (default 'skipped')
 */

/**
 * Pure decision table: observation -> NativeState. Unit-tested without a DOM.
 * @param {Observation} obs
 * @returns {NativeState}
 */
export function classifyNative(obs) {
  const has = new Set(obs.present);
  const applicable = new Set(obs.applicable);
  const markup = has.has('content') ? 'content' : has.has('layoutSubtree') ? 'layoutSubtree' : null;
  const coreMissing = CORE_NAMES.filter((n) => !has.has(n) && !(n === 'content' && markup));
  const specMissing = SPEC_NAMES.filter((n) => applicable.has(n) && !has.has(n));
  const legacyNames = LEGACY_NAMES.filter((n) => has.has(n));
  const seen = [...CORE_NAMES, ...SPEC_NAMES].some((n) => has.has(n)) || legacyNames.length > 0;

  /** @type {NativeState['kind']} */
  let kind;
  if (!seen) kind = 'absent';
  else if (coreMissing.length) kind = 'broken';
  else if (markup === 'layoutSubtree') kind = 'legacy';
  else kind = specMissing.length ? 'partial' : 'complete';

  const usable = kind === 'complete' || kind === 'partial' || kind === 'legacy';
  const gaps = usable ? ADDITIVE_NAMES.filter((n) => specMissing.includes(n) && (!(n in BUILT_FROM) || has.has(/** @type {Record<string, string>} */ (BUILT_FROM)[n]))) : [];
  const probe = obs.probe ?? 'skipped';
  return {
    kind,
    present: [...has],
    missing: kind === 'absent' ? [] : [...(kind === 'legacy' ? ['content'] : coreMissing), ...specMissing],
    legacyNames,
    gaps,
    fillable: kind === 'partial' && gaps.length > 0,
    verified: usable && probe === 'ok',
    probe,
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
 * The behavioural half of the core check: a platform drawElementImage converts its first argument (a plain object is a TypeError) and refuses a
 * drawable of a canvas that was never rendered (an InvalidStateError DOMException; measured on Canary 157.0.8103.0). Runs on a detached canvas, so
 * nothing is laid out, painted or observable by the page. 'inert' = it returned without throwing (a stub); 'unexpected' = it threw something else.
 * @param {any} win
 * @param {Function} draw  the native CanvasRenderingContext2D.prototype.drawElementImage
 * @param {'content'|'layoutSubtree'} markup
 * @returns {NativeState['probe']}
 */
function probeDraw(win, draw, markup) {
  let ctx;
  let child;
  try {
    const canvas = win.document.createElement('canvas');
    if (markup === 'content') canvas.setAttribute('content', 'drawable');
    else canvas.setAttribute('layoutsubtree', '');
    child = win.document.createElement('div');
    child.setAttribute('drawable', '');
    canvas.append(child);
    ctx = canvas.getContext('2d');
  } catch { return 'unexpected'; }
  if (!ctx) return 'unexpected';
  /** @param {unknown} arg @returns {'returned'|'type'|'state'|'other'} */
  const outcome = (arg) => {
    try { draw.call(ctx, arg, 0, 0); return 'returned'; } catch (err) {
      if (err instanceof win.TypeError) return 'type';
      return err instanceof win.DOMException && /** @type {DOMException} */ (err).name === 'InvalidStateError' ? 'state' : 'other';
    }
  };
  const foreign = outcome({});
  const drawable = outcome(child);
  if (foreign === 'returned' && drawable === 'returned') return 'inert';
  return foreign === 'type' && drawable === 'state' ? 'ok' : 'unexpected';
}

/**
 * @param {any} win
 * @returns {Observation}
 */
function observe(win) {
  /** @type {Set<string>} */ const present = new Set();
  /** @type {Set<string>} */ const applicable = new Set([...CORE_NAMES, ...SPEC_NAMES, ...LEGACY_NAMES]);
  /** @param {string} name @param {boolean} ok */
  const note = (name, ok) => { if (ok) present.add(name); };
  /** @param {string} name */
  const optionalClass = (name) => { if (!win[name]) for (const n of applicable) if (n.startsWith(`${name}.`)) applicable.delete(n); };

  const canvas = win.HTMLCanvasElement?.prototype;
  note('content', contentReflects(win));
  note('layoutSubtree', hasAccessor(canvas, 'layoutSubtree'));
  note('onpaint', hasAccessor(canvas, 'onpaint'));
  note('onelementgeometryupdate', hasAccessor(canvas, 'onelementgeometryupdate'));
  for (const m of ['requestPaint', 'captureElementImage', 'getElementTransform', 'updateElementGeometry', 'clearElementGeometry', 'getElementImageDefaultSize']) note(m, hasMethod(canvas, m));
  optionalClass('OffscreenCanvas');
  for (const m of ['updateElementGeometry', 'clearElementGeometry', 'getElementImageDefaultSize']) note(`OffscreenCanvas.${m}`, hasMethod(win.OffscreenCanvas?.prototype, m));

  for (const cls of ['CanvasRenderingContext2D', 'OffscreenCanvasRenderingContext2D']) {
    optionalClass(cls);
    note(`${cls}.drawElementImage`, hasMethod(win[cls]?.prototype, 'drawElementImage'));
  }
  const image = nativeGlobal(win, 'ElementImage');
  note('ElementImage', !!image && hasMethod(image.prototype, 'close'));
  note('ElementImage.width', !!image && hasAccessor(image.prototype, 'width'));
  note('ElementGeometryUpdateEvent', constructsEvent(nativeGlobal(win, 'ElementGeometryUpdateEvent'), 'elementgeometryupdate'));

  for (const cls of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
    optionalClass(cls);
    note(`${cls}.texElementSubImage2D`, hasMethod(win[cls]?.prototype, 'texElementSubImage2D'));
    note(`${cls}.texElementImage2D`, hasMethod(win[cls]?.prototype, 'texElementImage2D'));
  }
  optionalClass('GPUQueue');
  note('GPUQueue.drawElementImageToTexture', hasMethod(win.GPUQueue?.prototype, 'drawElementImageToTexture'));
  note('GPUQueue.copyElementImageToTexture', hasMethod(win.GPUQueue?.prototype, 'copyElementImageToTexture'));

  const markup = present.has('content') ? 'content' : present.has('layoutSubtree') ? 'layoutSubtree' : null;
  const draw = nativeDescriptor(win.CanvasRenderingContext2D?.prototype, 'drawElementImage')?.value;
  /** @type {NativeState['probe']} */
  const probe = markup && present.has('onpaint') && typeof draw === 'function' ? probeDraw(win, draw, markup) : 'skipped';
  return { present: [...present], applicable: [...applicable], browserMajor: readBrowser(win).major, probe };
}

/**
 * @param {any} win
 * @returns {import('../util/engine.js').EngineInfo}
 */
function readBrowser(win) {
  return engineOf(win.navigator);
}

/**
 * Build a detached canvas, check the core behaviour and record every name of the CURRENT spec (docs/API-CONTRACT.md section 2).
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
 * @property {string|null} [notice]  why the polyfill stepped aside from an explicit `mode: 'polyfill'` (recorded and warned once by install)
 */

/** @param {'browser'|'partial-native'} feature @param {string} message @param {string} hint @returns {ModeDecision} */
const refuse = (feature, message, hint) => ({ mode: 'refused', refusal: { feature, message, hint } });

/** @param {NativeState} native @returns {boolean} the core works: the polyfill steps aside */
export const nativeUsable = (native) => native.kind === 'complete' || native.kind === 'partial' || native.kind === 'legacy';

/**
 * Pure decision table (docs/API-CONTRACT.md section 2): native probe x browser gate x options -> mode or refusal.
 * A usable native (complete, partial or legacy) is NEVER refused and never replaced: the result is `native`, or `native-bridged` when the optional
 * bridge has something to add (install falls back to `native` when the bridge is not loaded). Only `broken` (a native core is missing) is refused.
 * `forcePolyfill` is the single override of a present native and exists for tests; `mode:'native-only'` wins over it.
 * @param {NativeState} native
 * @param {{ok: boolean, reason?: string}} gate
 * @param {{mode: 'auto'|'polyfill'|'native-only', forcePolyfill: boolean}} opts
 * @returns {ModeDecision}
 */
export function decideMode(native, gate, opts) {
  const gateRefusal = () => refuse('browser', `unsupported browser: ${gate.reason ?? 'browser gate failed'}`,
    `use a desktop Chromium-family browser (Chrome, Edge) >= ${MIN_CHROMIUM_MAJOR}, Firefox >= ${MIN_FIREFOX_MAJOR} or Safari >= ${MIN_SAFARI_MAJOR} (docs/SUPPORT-MATRIX.md, Browsers)`);
  const brokenRefusal = () => refuse('partial-native', `this browser has a native HTML-in-Canvas implementation without its core (missing: ${native.missing.join(', ')})`,
    'update the browser or remove the experimental flag; options.forcePolyfill replaces the native parts (tests only)');
  const usable = nativeUsable(native);
  /** @type {ModeDecision['mode']} */
  const nativeMode = native.kind === 'legacy' || native.fillable ? 'native-bridged' : 'native';

  if (opts.mode === 'native-only') {
    if (usable) return { mode: nativeMode, refusal: null };
    return native.kind === 'broken' ? brokenRefusal()
      : refuse('browser', 'mode "native-only" needs a native HTML-in-Canvas implementation and this browser has none', 'use mode "auto" so the polyfill can provide the API');
  }
  if (opts.forcePolyfill) return gate.ok ? { mode: 'polyfill', refusal: null } : gateRefusal();
  if (native.kind === 'absent') return gate.ok ? { mode: 'polyfill', refusal: null } : gateRefusal();
  if (!usable) return brokenRefusal();
  const notice = opts.mode === 'polyfill'
    ? `mode "polyfill" ignored: this browser implements HTML-in-Canvas (kind "${native.kind}") and a usable native implementation is never replaced`
    : null;
  return { mode: nativeMode, refusal: null, notice };
}
