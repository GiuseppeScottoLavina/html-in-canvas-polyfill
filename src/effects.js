/**
 * Optional ESM entry: the effect host and plugin ABI (needs the installed core). Side-effect free; `installEffects()` defines window.HTMLInCanvasEffects.
 * Module: gpu-effects. Implemented.
 */
import { createLateEffects, installEffectsGlobal } from './effects/index.js';

export { definePlugin } from './effects/plugin-abi.js';
export { createLateEffects, installEffectsGlobal };

/** @param {Window} [win] @returns {import('./contracts/types.js').EffectsApi} the window's EffectsApi; defines window.HTMLInCanvasEffects unless it exists */
export function installEffects(win = window) {
  const api = createLateEffects(win);
  installEffectsGlobal(win, api);
  return api;
}
