/**
 * Seam to the GPU bundle (optimization 7): the WebGL / WebGPU element-texture upload (texture-patch.js) lives in `hic-live-gpu.iife.js` (ESM: imported by the package entry),
 * outside the Chrome core. That bundle registers its installer on a global symbol; install() uses it. Without it the four methods still exist (feature detection keeps
 * working) and throw a loud NotSupportedError that names the missing bundle. Loaded after the core, the bundle replaces the stubs through the installed core's hook.
 * Module: api-surface (src/api/*).
 */

import { HicUnsupportedError } from '../contracts/errors.js';
import { defineMethod, globalsOf } from './validate.js';

/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../contracts/types.js').PatchLedger} PatchLedger */
/** @typedef {{installTexturePatches: (env: HicEnv, ledger: PatchLedger) => void}} GpuBundle */

export const GPU_KEY = Symbol.for('hic.gpu-patches');
export const GPU_LATE_KEY = Symbol.for('hic.gpu-late');

/** @param {HicEnv} env @param {string} feature @param {string} name @returns {never} */
function missing(env, feature, name) {
  const err = new HicUnsupportedError(feature, `${name}() needs the polyfill's GPU bundle, which is not loaded`, { hint: 'load hic-live-gpu.iife.js (before or after hic-live-polyfill.iife.js), or import the package entry instead of the core-only build' });
  env.reporter.unsupported({ feature, message: err.message, hint: err.hint });
  throw err;
}

/** @param {HicEnv} env @param {PatchLedger} ledger */
function installStubs(env, ledger) {
  const win = globalsOf(env);
  for (const ctor of [win.WebGLRenderingContext, win.WebGL2RenderingContext]) {
    if (typeof ctor !== 'function') continue;
    defineMethod(ledger, ctor.prototype, 'texElementSubImage2D', 5, () => missing(env, 'webgl-tex-element', 'texElementSubImage2D'));
    defineMethod(ledger, ctor.prototype, 'texElementImage2D', 6, () => missing(env, 'webgl-tex-element', 'texElementImage2D'));
  }
  const queue = /** @type {any} */ (win).GPUQueue?.prototype;
  if (queue && typeof queue.copyExternalImageToTexture === 'function') {
    defineMethod(ledger, queue, 'drawElementImageToTexture', 2, () => missing(env, 'webgpu-draw-element', 'drawElementImageToTexture'));
    defineMethod(ledger, queue, 'copyElementImageToTexture', 2, () => missing(env, 'webgpu-draw-element', 'copyElementImageToTexture'));
  }
}

/**
 * Install the element-texture methods: the GPU bundle's when registered, else loud stubs. Returns the hook a GPU bundle loaded later calls to replace the stubs.
 * @param {HicEnv} env @param {PatchLedger} ledger @returns {(bundle: GpuBundle) => void}
 */
export function installGpu(env, ledger) {
  const bundle = /** @type {GpuBundle|undefined} */ (/** @type {any} */ (globalThis)[GPU_KEY]);
  let real = false;
  if (bundle) { bundle.installTexturePatches(env, ledger); real = true; } else installStubs(env, ledger);
  return (late) => {
    if (real) return;
    real = true;
    late.installTexturePatches(env, ledger);
  };
}
