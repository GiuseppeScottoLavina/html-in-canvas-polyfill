/**
 * HicEnv factory (dependency-injection root).
 * Module: api-core.
 */

import { MARK } from '../contracts/events.js';

/** @typedef {import('../contracts/types.js').Bus} Bus */
/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../contracts/types.js').Reporter} Reporter */
/** @typedef {import('../contracts/types.js').ResolvedOptions} ResolvedOptions */

/** Slots compose.js fills after construction. Reading one earlier is a wiring bug and must fail loudly, not return undefined. */
const LATE_SLOTS = /** @type {const} */ (['registry', 'store', 'scheduler', 'roots', 'adopt']);

/** @param {object} env @param {string} name */
function defineLateSlot(env, name) {
  /** @type {unknown} */
  let value;
  let assigned = false;
  Object.defineProperty(env, name, {
    enumerable: true,
    configurable: false,
    get() {
      if (!assigned) throw new Error(`[hic-live-polyfill] env.${name} was read before compose() assigned it (read it at call time, never inside a factory)`);
      return value;
    },
    set(v) { value = v; assigned = true; },
  });
}

/**
 * Create the env. `registry`, `store`, `scheduler`, `roots`, `adopt` are assigned by compose.js before any canvas is mounted
 * (until then reading them throws); install() seals the object after compose.
 * @param {Window} win
 * @param {ResolvedOptions} options
 * @param {Bus} bus
 * @param {Reporter} reporter
 * @param {Document} [doc] defaults to win.document (the `document` install option can name another one)
 * @returns {HicEnv}
 */
export function createEnv(win, options, bus, reporter, doc = win.document) {
  const env = {
    window: win,
    document: doc,
    options,
    bus,
    reporter,
    now: () => win.performance.now(),
    isManagedLayerNode: (/** @type {Element} */ el) => el.nodeType === 1
      && (el.hasAttribute(MARK.NODE_ATTR) || el.hasAttribute(MARK.LAYER_ATTR) || el.localName === MARK.LAYER_TAG),
  };
  for (const name of LATE_SLOTS) defineLateSlot(env, name);
  return /** @type {HicEnv} */ (/** @type {unknown} */ (env));
}
