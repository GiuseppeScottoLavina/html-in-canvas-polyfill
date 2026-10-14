/**
 * window.HTMLInCanvasEffects (EffectsApi) and its installation.
 * Module: gpu-effects (src/effects/**).
 */

import { EXT } from '../contracts/events.js';
import { invalidState, typeError } from '../contracts/errors.js';
import { createEffectHost } from './effect-host.js';
import { NO_TARGET, isNoTarget } from './no-target.js';
import { definePlugin } from './plugin-abi.js';

/** @typedef {import('../contracts/types.js').EffectHost} EffectHost */
/** @typedef {import('../contracts/types.js').EffectsApi} EffectsApi */
/** @typedef {import('../contracts/types.js').EffectsSeam} EffectsSeam */
/** @typedef {import('../contracts/types.js').GeometryApi} GeometryApi */
/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../contracts/types.js').InteractionTracker} InteractionTracker */
/** @typedef {import('../contracts/types.js').Scheduler} Scheduler */
/** @typedef {import('../contracts/types.js').SnapshotStore} SnapshotStore */

/**
 * Builds the EffectsApi: definePlugin (plugin-abi.js) and createHost (effect-host.js). Does not touch the window.
 * @param {HicEnv} env
 * @param {{store: SnapshotStore, scheduler: Scheduler, geometry: GeometryApi, tracker: InteractionTracker}} deps
 * @returns {EffectsApi}
 */
export function createEffects(env, deps) {
  /** @type {Set<EffectHost>} */
  const hosts = new Set();
  const win = /** @type {any} */ (env.window);
  return Object.freeze({
    version: /** @type {const} */ (2),
    definePlugin,
    NO_TARGET,
    isNoTarget,
    async createHost(canvas, source, options) {
      if (!(canvas instanceof win.HTMLCanvasElement)) throw typeError('createHost: `canvas` must be an HTMLCanvasElement');
      if (!(source instanceof win.Element)) throw typeError('createHost: `source` must be an Element');
      if (options !== undefined && (options === null || typeof options !== 'object')) throw typeError('createHost: `options` must be an object');
      const host = await createEffectHost(env, deps, canvas, source, options);
      hosts.add(host);
      return Object.freeze({
        get pluginCount() { return host.pluginCount; },
        addPlugin: host.addPlugin,
        stats: host.stats,
        destroy() { hosts.delete(host); host.destroy(); },
      });
    },
    dispose() {
      for (const host of [...hosts]) host.destroy();
      hosts.clear();
    },
  });
}

/**
 * The EffectsApi of a window, bound late: every call looks the installed core up (EXT.INSTALLED_KEY -> EXT.EFFECTS_SEAM_KEY), so the effects bundle can load before
 * install() ran, and after uninstall() createHost rejects instead of touching a dead install. Hosts are destroyed by the core's uninstall (seam.cleanups).
 * @param {Window} win
 * @returns {EffectsApi}
 */
export function createLateEffects(win) {
  const seamOf = () => /** @type {EffectsSeam|undefined} */ (/** @type {any} */ (win)[EXT.INSTALLED_KEY]?.[EXT.EFFECTS_SEAM_KEY]);
  return Object.freeze({
    version: /** @type {const} */ (2),
    definePlugin,
    NO_TARGET,
    isNoTarget,
    async createHost(canvas, source, options) {
      const seam = seamOf();
      if (!seam) throw invalidState('HTMLInCanvasEffects needs the installed polyfill: load the core bundle first and let it install (or call install())');
      if (!seam.effects) {
        const effects = (seam.effects = createEffects(seam.env, seam.deps));
        seam.cleanups.add(() => effects.dispose());
      }
      return seam.effects.createHost(canvas, source, options);
    },
    dispose() { seamOf()?.effects?.dispose(); },
  });
}

/**
 * Define window.HTMLInCanvasEffects (frozen) unless already present; returns the remover.
 * @param {Window} win
 * @param {EffectsApi} api
 * @returns {() => void}
 */
export function installEffectsGlobal(win, api) {
  const target = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (win));
  if (EXT.EFFECTS_GLOBAL in target) return () => {};
  Object.defineProperty(win, EXT.EFFECTS_GLOBAL, { value: api, configurable: true, writable: false, enumerable: false });
  return () => {
    if (target[EXT.EFFECTS_GLOBAL] === api) delete target[EXT.EFFECTS_GLOBAL];
  };
}
