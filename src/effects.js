/**
 * Optional ESM entry: the effect host and plugin ABI (needs the installed core). Side-effect free; `installEffects()` defines window.HTMLInCanvasEffects.
 * Module: gpu-effects.
 */
import { createLateEffects, installEffectsGlobal } from './effects/index.js';

export { definePlugin } from './effects/plugin-abi.js';
export { NO_TARGET, isNoTarget } from './effects/no-target.js';
export { createLateEffects, installEffectsGlobal };

/**
 * The window's EffectsApi; defines window.HTMLInCanvasEffects unless it exists.
 * @experimental the effects, an extension of this library, not part of the HTML-in-Canvas standard (docs/STABILITY.md)
 * @param {Window} [win]
 * @returns {import('./contracts/types.js').EffectsApi}
 */
export function installEffects(win = window) {
  const api = createLateEffects(win);
  installEffectsGlobal(win, api);
  return api;
}
