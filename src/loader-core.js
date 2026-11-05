/**
 * What the module loader (src/loader.js) imports on the polyfill path: install() and the GPU bundle, as the package entry has them, and nothing else. Not a public entry.
 * The loader cannot import the package entry (./index.js): a bundler keeps every export of a module that is imported dynamically, so the polyfill path would carry
 * the public FEATURES table and the other exports (about 12 KB gzip in an esbuild consumer, measured 2026-11-05). The engines (./engines.js) are imported beside this
 * module on Gecko and WebKit only, unless `engines: false`, as the classic loader does. The install() it exports is the package entry's own: one install per window.
 * Module: api-core (entry).
 */
// the WebGL / WebGPU element textures, as in the package entry
import './gpu.js';

export { install } from './api/install.js';
