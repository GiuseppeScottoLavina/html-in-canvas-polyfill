/**
 * The hand-over point between the core and the optional effects bundle (dist/hic-live-effects.iife.js): the core only publishes the internals the effects need
 * (env + store/scheduler/geometry/tracker) on the HicInstalled; it never imports effects code. Module: api-core.
 */

/** @typedef {import('../contracts/types.js').EffectsDeps} EffectsDeps */
/** @typedef {import('../contracts/types.js').EffectsSeam} EffectsSeam */
/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */

/**
 * @param {HicEnv} env
 * @param {EffectsDeps} deps
 * @returns {EffectsSeam}
 */
export function createEffectsSeam(env, deps) {
  /** @type {Set<() => void>} */
  const cleanups = new Set();
  return {
    env, deps, effects: null, cleanups,
    dispose() {
      for (const cleanup of [...cleanups]) cleanup();
      cleanups.clear();
    },
  };
}
