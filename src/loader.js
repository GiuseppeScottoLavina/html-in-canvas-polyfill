/**
 * Module entry of the loader (`import { load } from '<package>/loader'`): decides exactly as install() would and imports the core only when the polyfill will run:
 * install() with the GPU bundle (./loader-core.js, not the package entry, whose other exports a dynamic import would keep), and the engines (./engines.js) on Gecko and
 * WebKit unless `engines: false`. With a bundler that keeps dynamic imports split, each is a separate chunk, so a browser that implements HTML-in-Canvas fetches only this
 * module and the shared chunks it imports statically. The native bridge (./native-bridge.js) is imported only for a native implementation it can bridge.
 * The URL options (`core`, `engines`, `bridge` as a string) and `nonce` belong to the classic loader: here they are a TypeError (load() rejects).
 * Module: api-core (entry).
 */
import { createLoad } from './api/loader.js';

/** @type {import('./api/loader.js').Fetcher} */
const modules = {
  check(o) {
    for (const k of /** @type {const} */ (['core', 'engines', 'bridge', 'nonce'])) {
      if (typeof o[k] === 'string') throw new TypeError(`load() option "${k}" is a classic-loader option; the module loader imports its modules from the package (only bridge: false and engines: false apply)`);
    }
  },
  fetch: (_win, need) => Promise.all([need.bridge ? import('./native-bridge.js') : null, need.engines ? import('./engines.js') : null, import('./loader-core.js')]).then(([, , core]) => core),
};

/** @typedef {import('./api/loader.js').LoadOptions} LoadOptions */
/** @typedef {import('./api/loader.js').LoadResult} LoadResult */

const shared = createLoad(modules);

/**
 * Decide as install() would; import the core and install only when the polyfill (or the native bridge) will run. Rejects only with a TypeError for an invalid option.
 * @param {LoadOptions} [options]
 * @returns {Promise<LoadResult>}
 */
export function load(options) {
  return shared(options);
}
export { VERSION } from './version.js';
