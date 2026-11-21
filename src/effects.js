/**
 * Optional ESM entry: the effect host and plugin ABI. Side-effect free; `installEffects()` defines window.HTMLInCanvasEffects.
 * Over the polyfill the effects need the installed core. Over a browser's own HTML-in-Canvas they do not: when no core is installed and install() would step aside
 * there (mode native, the decision the loader takes), the effects build what they use of an install themselves (nativeSeam): the options' defaults, a reporter,
 * a bus, and no canvas of the polyfill's. So a page that gets status 'native' from the loader runs the effects without downloading the core.
 * Module: gpu-effects (an entry point: it may compose api/ modules).
 */
import { createLateEffects, installEffectsGlobal } from './effects/index.js';
import { decideInstall } from './api/native-detect.js';
import { withDeviceBudgets } from './api/options.js';
import { createReporter } from './api/report.js';
import { NO_CANVASES, NO_INTERACTION, unavailable } from './util/stand-ins.js';
import { createBus } from './util/bus.js';

export { definePlugin } from './effects/plugin-abi.js';
export { NO_TARGET, isNoTarget } from './effects/no-target.js';
export { createLateEffects, installEffectsGlobal };

/**
 * The seam of an install over a browser's own HTML-in-Canvas, built without the core; null where install() would not step aside in mode native (the polyfill
 * would run, or the native-bridge bundle would bridge an earlier native build: both need the core).
 * @param {Window} win
 * @returns {import('./contracts/types.js').EffectsSeam|null}
 */
function nativeSeam(win) {
  let d;
  try { d = decideInstall(win, undefined); } catch { return null; }
  if (d.decision.mode !== 'native') return null;
  const w = /** @type {Window & typeof globalThis} */ (win);
  const options = withDeviceBudgets(d.given, undefined, d.gate, /** @type {any} */ (w.navigator)?.deviceMemory);
  const absent = (/** @type {string} */ name) => unavailable(name, 'the effects run over the browser\'s own HTML-in-Canvas, without the core');
  const reporter = createReporter(w, options);
  // a bus as an install over a native implementation has: nothing emits on it there (the resize and DPR observers are the polyfill's), the host only subscribes
  const env = /** @type {any} */ ({
    window: w, document: w.document, options, reporter, now: () => w.performance.now(),
    registry: NO_CANVASES, store: absent('store'), scheduler: absent('scheduler'), bus: createBus((err, topic) => reporter.caught(err, `bus:${topic}`)),
  });
  /** @type {Set<() => void>} */
  const cleanups = new Set();
  return {
    env, deps: { store: env.store, scheduler: env.scheduler, geometry: absent('geometry'), tracker: /** @type {any} */ (NO_INTERACTION) }, effects: null, cleanups,
    dispose() { for (const cleanup of [...cleanups]) cleanup(); cleanups.clear(); },
  };
}

/**
 * The window's EffectsApi; defines window.HTMLInCanvasEffects unless it exists.
 * @experimental the effects, an extension of this library, not part of the HTML-in-Canvas standard (docs/STABILITY.md)
 * @param {Window} [win]
 * @returns {import('./contracts/types.js').EffectsApi}
 */
export function installEffects(win = window) {
  const api = createLateEffects(win, nativeSeam);
  installEffectsGlobal(win, api);
  return api;
}
