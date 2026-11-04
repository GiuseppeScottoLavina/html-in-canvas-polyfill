/**
 * Module entry of the loader (`import { load } from '<package>/loader'`): decides exactly as install() would and imports the package entry (the core with the
 * engines and GPU bundles, ./index.js) only when the polyfill will run; with a bundler that entry is a separate chunk, so a browser that implements
 * HTML-in-Canvas fetches only this module. The native bridge (./native-bridge.js) is imported only for a native implementation it can bridge.
 * The URL options (`core`, `engines`, `bridge` as a string) and `nonce` belong to the classic loader: here they are a TypeError (status 'error').
 * Module: api-core (entry).
 */
import { createLoad } from './api/loader.js';

/** @type {import('./api/loader.js').Fetcher} */
const modules = {
  check(o) {
    for (const k of /** @type {const} */ (['core', 'engines', 'bridge', 'nonce'])) {
      if (typeof o[k] === 'string') throw new TypeError(`load() option "${k}" is a classic-loader option; the module loader imports the package entry (only bridge: false applies)`);
    }
  },
  fetch: (_win, need) => Promise.all([need.bridge ? import('./native-bridge.js') : null, import('./index.js')]).then(([, core]) => core),
};

/** @typedef {import('./api/loader.js').LoadOptions} LoadOptions */
/** @typedef {import('./api/loader.js').LoadResult} LoadResult */

const shared = createLoad(modules);

/**
 * Decide as install() would; import the package entry and install only when the polyfill (or the native bridge) will run. Never rejects.
 * @param {LoadOptions} [options]
 * @returns {Promise<LoadResult>}
 */
export function load(options) {
  return shared(options);
}
export { VERSION } from './version.js';
