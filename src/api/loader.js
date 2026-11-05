/**
 * The loader: decide exactly as install() would (native-detect.js decideInstall), and download the core only when it will run (docs/API-CONTRACT.md section 2.4).
 * Module: api-core. Shared by the classic loader (src/loader-iife.js: <script> elements) and the module loader (src/loader.js: import()); each passes a Fetcher.
 *
 * What each decision downloads: native and refused, nothing (installed null); native-bridged, the native bridge then the core, unless `bridge: false` (then it is
 * native, as install() is without the bridge); polyfill, the engines bundle on Gecko / WebKit unless `engines: false`, then the core with data-hic-manual. Then the
 * core's own install(options.install) runs and its mode is the status. One promise per window: concurrent and later calls share it. An invalid option (of the
 * loader or of install()) rejects that call with install()'s TypeError, before anything is decided or downloaded, as install() throws it; the call does not take the
 * window's load. Otherwise the promise never rejects: a timeout or a load error settles it with status 'error', and a bundle that arrives after the loader settled
 * never installs (the core never auto-installs under data-hic-manual and the loader calls install() only while it has not settled).
 */

import { decideInstall, probeNative } from './native-detect.js';
import { resolveOptions } from './options.js';
import { HicUnsupportedError } from '../contracts/errors.js';
import { EXT } from '../contracts/events.js';

/** @typedef {import('../contracts/types.js').HicInstalled} HicInstalled */
/** @typedef {import('../contracts/types.js').HicMode} HicMode */
/** @typedef {import('../contracts/types.js').HicOptions} HicOptions */
/** @typedef {import('../contracts/types.js').NativeState} NativeState */

/**
 * @typedef {Object} LoadOptions
 * @property {HicOptions} [install]  passed to install(); its `mode`, `forcePolyfill` and `window` drive the decision exactly as in install()
 * @property {string} [core]  classic loader only: URL of the classic core (default: hic-live-polyfill.iife.js, or .iife.min.js, beside the loader's own src)
 * @property {string|false} [engines]  URL of the engines bundle, loaded on Firefox and Safari on the polyfill path (default beside the loader; the module loader imports them from the package and takes only false), or false: not loaded
 * @property {string|false} [bridge]  URL of the native bridge, loaded only for a native implementation it can bridge (default beside the loader; the module loader imports the /native-bridge entry), or false
 * @property {number} [timeout]  ms until the load settles with status 'error' (default 10000)
 * @property {string} [nonce]  classic loader only: the nonce of the <script> elements it creates (a CSP with a nonce source)
 */

/**
 * @typedef {Object} LoadResult  frozen
 * @property {'native'|'native-bridged'|'polyfill'|'refused'|'error'} status  the mode, or 'error' (no window, a timeout, a load error, a throw of install()); an invalid option rejects instead
 * @property {HicMode|null} mode  null on error
 * @property {HicInstalled|null} installed  what install() returned, or null when the core was not loaded (native, refused, error)
 * @property {NativeState|null} native  the probe of the window (null only without a window)
 * @property {string} [reason]  why: the refusal message install() gives, or the error's message
 * @property {unknown} [error]  the HicUnsupportedError install() would throw (refused), or the error
 */

/**
 * @typedef {Object} Fetcher  how an entry gets the bundles; check() throws a TypeError for an option it does not take
 * @property {(options: LoadOptions) => void} check
 * @property {(win: Window, need: {bridge: boolean, engines: boolean}, options: LoadOptions) => Promise<{install: (o?: HicOptions) => HicInstalled}>} fetch
 */

/** One shared load per window. */
const SLOT = Symbol.for('hic.loader');
const KEYS = ['install', 'core', 'engines', 'bridge', 'timeout', 'nonce'];

/**
 * The options, checked as install() checks its own: the loader's, the fetcher's, then install()'s (resolveOptions, and the document as install() reads it).
 * @param {LoadOptions|undefined} o @param {Fetcher} fetcher @throws TypeError
 */
function checkOptions(o, fetcher) {
  if (o === undefined) return;
  if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new TypeError('load() options must be an object');
  for (const k of Object.keys(o)) if (!KEYS.includes(k)) throw new TypeError(`unknown load() option "${k}"`);
  const t = o.timeout;
  if (t !== undefined && !(typeof t === 'number' && t > 0 && t < Infinity)) throw new TypeError('load() option "timeout" must be a positive number of ms');
  if (o.nonce !== undefined && typeof o.nonce !== 'string') throw new TypeError('load() option "nonce" must be a string');
  if (o.core !== undefined && typeof o.core !== 'string') throw new TypeError('load() option "core" must be a URL');
  for (const k of /** @type {const} */ (['engines', 'bridge'])) if (o[k] !== undefined && o[k] !== false && typeof o[k] !== 'string') throw new TypeError(`load() option "${k}" must be a URL or false`);
  fetcher.check(o);
  resolveOptions(o.install);
  const doc = /** @type {any} */ (o.install)?.document;
  if (doc != null && doc.nodeType !== 9) throw new TypeError('option "document" must be a Document');
}

/**
 * @param {Fetcher} fetcher
 * @returns {(options?: LoadOptions) => Promise<LoadResult>}
 */
export function createLoad(fetcher) {
  return (options) => {
    const win = /** @type {any} */ (options?.install?.window ?? (typeof window === 'undefined' ? undefined : window));
    if (!win?.document) return Promise.resolve(Object.freeze({ status: 'error', mode: null, installed: null, native: null, reason: 'load() needs a browser window', error: new TypeError('load() needs a browser window') }));
    try { checkOptions(options, fetcher); } catch (e) { return Promise.reject(e); } // as install() throws: the window's load is neither taken nor shared
    if (!win[SLOT]) Object.defineProperty(win, SLOT, { value: run(win, options, fetcher), configurable: true });
    return win[SLOT];
  };
}

/** @param {any} win @param {LoadOptions|undefined} options @param {Fetcher} fetcher @returns {Promise<LoadResult>} */
function run(win, options, fetcher) {
  return new Promise((resolve) => {
    /** @type {NativeState|null} */ let native = null;
    let done = false;
    let timer = 0;
    /** @param {LoadResult['status']} status @param {HicInstalled|null} installed @param {object} [more] */
    const finish = (status, installed, more = {}) => {
      if (done) return;
      done = true;
      win.clearTimeout(timer);
      resolve(Object.freeze({ status, mode: status === 'error' ? null : status, installed, native: installed?.native ?? native, ...more }));
    };
    /** @param {any} error */
    const fail = (error) => finish('error', null, { reason: String(error?.message ?? error), error });
    try {
      let d;
      try { d = decideInstall(win, options?.install); } catch (e) { native = probeNative(win); throw e; }
      native = d.native;
      /** @type {HicInstalled|null} the core is already installed (its script tag, or a direct install()): returned as install() returns it, options checked first */
      const existing = win[EXT.INSTALLED_KEY] ?? null;
      if (existing) return finish(existing.mode, existing);
      const { mode, refusal, notice } = d.decision;
      if (refusal) {
        // install() would throw this (or warn and return a refused HicInstalled); the loader settles and warns once, as the classic core's auto-install does
        win.console.warn(`[hic-live-polyfill] not installed (${refusal.feature}): ${refusal.message}. Hint: ${refusal.hint}`);
        return finish('refused', null, { reason: refusal.message, error: new HicUnsupportedError(refusal.feature, refusal.message, { hint: refusal.hint }) });
      }
      const bridge = mode === 'native-bridged' && options?.bridge !== false;
      if (mode !== 'polyfill' && !bridge) {
        if (notice) win.console.warn(`[hic-live-polyfill] ${notice}`);
        return finish('native', null);
      }
      const engines = mode === 'polyfill' && (d.gate.engine === 'gecko' || d.gate.engine === 'webkit') && options?.engines !== false;
      const ms = options?.timeout ?? 10000;
      timer = win.setTimeout(() => fail(new win.DOMException(`the polyfill did not load within ${ms} ms`, 'TimeoutError')), ms);
      fetcher.fetch(win, { bridge, engines }, options ?? {}).then((api) => {
        if (done) return; // settled (a timeout): a bundle that arrives late never installs
        const installed = api.install(options?.install);
        finish(installed.mode, installed);
      }).catch(fail);
    } catch (e) { fail(e); }
  });
}

/**
 * The classic fetcher: <script> elements in the window's document, in order (async = false: they download in parallel and run in insertion order).
 * @param {{core: string|null, engines: string|null, bridge: string|null}} defaults  URLs beside the loader script (null when it has no src)
 * @returns {Fetcher}
 */
export function scriptFetcher(defaults) {
  return {
    check() {},
    fetch(window, need, o) {
      const win = /** @type {any} */ (window);
      const doc = win.document;
      /** @type {Array<[string|null|undefined, string, boolean]>} [url, what, manual] of the bundles the window lacks */
      const list = [];
      if (need.bridge && !win[EXT.NATIVE_BRIDGE_KEY]) list.push([o.bridge || defaults.bridge, 'bridge', false]);
      if (need.engines && !win[Symbol.for('hic.engine-skins')]) list.push([o.engines || defaults.engines, 'engines', false]);
      if (!win.HicLivePolyfill) list.push([o.core || defaults.core, 'core', true]);
      const loads = list.map(([url, what, manual]) => new Promise((ok, no) => {
        if (!url) throw new TypeError(`no URL for the ${what} bundle: the loader script has no src, pass the "${what}" option`);
        const s = doc.createElement('script');
        s.async = false;
        if (o.nonce) s.nonce = o.nonce;
        if (manual) s.setAttribute('data-hic-manual', '');
        s.onload = ok;
        s.onerror = () => no(new win.DOMException(`the ${what} bundle did not load from ${url} (network error, HTTP error or Content-Security-Policy)`, 'NetworkError'));
        s.src = url;
        (doc.head ?? doc.documentElement).append(s);
      }));
      return Promise.all(loads).then(() => {
        const api = win.HicLivePolyfill;
        if (typeof api?.install !== 'function') throw new TypeError('the core bundle loaded but did not define HicLivePolyfill');
        return api;
      });
    },
  };
}
