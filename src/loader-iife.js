/**
 * Entry of the classic loader (dist/hic-live-loader.iife.js): window.HicLiveLoader = {load, version}. A small bundle that decides exactly as install() would and downloads
 * the core (and the engines bundle on Firefox and Safari) only when the polyfill will run: on a browser that implements HTML-in-Canvas it downloads nothing.
 * The default bundle URLs are beside this script's own src (the .min.js files when it is the .min.js), read when it runs (docs/BUNDLES.md, docs/API-CONTRACT.md section 2.4).
 * Module: api-core (entry).
 */
import { createLoad, scriptFetcher } from './api/loader.js';
import { VERSION } from './version.js';

const script = /** @type {HTMLScriptElement|null} */ (typeof document !== 'undefined' ? document.currentScript : null);
const src = script?.src ?? '';
const min = /\.min\.js(?:[?#]|$)/.test(src);
/** @param {string} name @returns {string|null} */
const beside = (name) => (src ? new URL(`${name}.iife${min ? '.min' : ''}.js`, src).href : null);

const api = Object.freeze({
  load: createLoad(scriptFetcher({ core: beside('hic-live-polyfill'), engines: beside('hic-live-engines'), bridge: beside('hic-live-native-bridge') })),
  version: VERSION,
});
Object.defineProperty(globalThis, 'HicLiveLoader', { value: api, configurable: true, writable: false });
