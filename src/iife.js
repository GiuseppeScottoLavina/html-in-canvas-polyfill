/**
 * Entry of the classic core bundle (dist/hic-live-polyfill.iife.js): the 2D path. Load it BEFORE app scripts that read the API. The optional bundles load after it
 * (hic-live-effects; plugin bundles from dist/plugins/ in any order) or before it (hic-live-native-bridge); hic-live-engines (Firefox / Safari) in any order; docs/BUNDLES.md has the order and the sizes.
 * Exposes window.HicLivePolyfill and installs synchronously unless its <script> has data-hic-manual.
 * AUTO-install policy (ADR-N): a refusal (HicUnsupportedError: an unsupported or too old browser, a core-incomplete native) is a console.warn once and
 * window.__HIC__ = {error}; it never throws, so a site that includes the script unconditionally keeps working. Any OTHER error is a bug of
 * the polyfill: console.error, window.__HIC__ = {error} and it is rethrown. An explicit install() call keeps the loud throw.
 * Module: api-core.
 */
// not from './index.js': the package entry also imports the Gecko / WebKit painters, which the classic core leaves to hic-live-engines.iife.js
import { install, getInstalled } from './api/install.js';
import { HicUnsupportedError } from './contracts/errors.js';
import { FEATURES, featureById } from './contracts/features.js';
import { EXT } from './contracts/events.js';
import { VERSION } from './version.js';

const api = Object.freeze({ install, getInstalled, version: VERSION, FEATURES, featureById, HicUnsupportedError });
Object.defineProperty(globalThis, 'HicLivePolyfill', { value: api, configurable: true, writable: false });

const script = /** @type {HTMLScriptElement|null} */ (typeof document !== 'undefined' ? document.currentScript : null);
if (!script || !script.hasAttribute('data-hic-manual')) {
  try {
    const first = install();
    // `installed` follows the live instance, so it stays right after uninstall() + install(); report() reads it too
    const debug = { get installed() { return getInstalled() ?? first; }, report: () => debug.installed.report() };
    Object.defineProperty(globalThis, EXT.DEBUG_GLOBAL, { value: debug, configurable: true });
  } catch (error) {
    Object.defineProperty(globalThis, EXT.DEBUG_GLOBAL, { value: { error }, configurable: true });
    if (error instanceof HicUnsupportedError) {
      console.warn(`[hic-live-polyfill] not installed (${error.feature}): ${error.message.replace(/^\[hic-live-polyfill\] /, '')}${error.hint ? `. Hint: ${error.hint}` : ''}`);
    } else {
      console.error('[hic-live-polyfill] install failed', error);
      throw error;
    }
  }
}
