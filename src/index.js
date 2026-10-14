/**
 * Public ES-module entry of hic-live-polyfill. The classic IIFE bundle (src/iife.js) wraps the same exports.
 * Module: api-core (re-exports only).
 */
// the Gecko / WebKit painters (engines bundle): the package entry carries every engine, the classic core IIFE does not
import './engines.js';
// the WebGL / WebGPU element textures (GPU bundle): also carried by the package entry only
import './gpu.js';

export { install, getInstalled } from './api/install.js';
export { HicUnsupportedError } from './contracts/errors.js';
export { FEATURES, featureById } from './contracts/features.js';
export { EVENTS, EXT } from './contracts/events.js';

/** Library version; scripts/build.mjs asserts it equals package.json. */
export { VERSION } from './version.js';
