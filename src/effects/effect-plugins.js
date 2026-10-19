/**
 * The plugins of one effect host: creation, handles, option/enable/UI state, actions (trigger / settled), re-creation after device loss.
 * Module: gpu-effects (src/effects/**).
 *
 * Actions (API-CONTRACT 7.3.1): handle.trigger(action, options) validates the name against the definition's `actions`, resolves the
 * handle's previous pending trigger with null (superseded), calls instance.runAction and resolves with the state it resolves. A pending
 * trigger also resolves null when the plugin is removed, disabled or failed, or its instance is destroyed by a GPU device loss.
 * handle.settled() waits on instance.settled(); its waiters survive a device loss (they wait on the re-created instance) and resolve null
 * on removal, disable or failure.
 */

import { invalidState, typeError } from '../contracts/errors.js';
import { buildPluginContext, definePlugin, validateInstance } from './plugin-abi.js';

/** @typedef {import('../contracts/types.js').EffectActionState} EffectActionState */
/** @typedef {import('../contracts/types.js').EffectHandle} EffectHandle */
/** @typedef {import('../contracts/types.js').EffectPluginDefinition} EffectPluginDefinition */
/** @typedef {import('../contracts/types.js').EffectPluginInstance} EffectPluginInstance */
/** @typedef {import('../contracts/types.js').EffectViewport} EffectViewport */
/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */

/**
 * @typedef {Object} Slot
 * @property {string} id
 * @property {EffectPluginDefinition} def
 * @property {Readonly<Record<string, unknown>>} options
 * @property {boolean} enabled
 * @property {boolean} failed
 * @property {boolean} removed
 * @property {EffectPluginInstance|null} instance
 * @property {Set<() => void>} removers  listeners added through context.listen
 * @property {Set<{root: Element, dispose: (() => void)|null}>} mounts
 * @property {EffectHandle} handle
 * @property {((state: EffectActionState) => void)|null} pending  resolves the newest trigger() of the handle that has not settled
 * @property {Set<(state: EffectActionState) => void>} waiters  settled() calls that wait
 * @property {number} generation  bumped when the instance is torn down: answers of an older instance are ignored
 * @property {Promise<void>|null} recreating  set while the instance is created again after a device loss
 */

/** @typedef {{instance: EffectPluginInstance, def: EffectPluginDefinition, slot: Slot}} Stage */

/**
 * What the plugin set needs from its host.
 * @typedef {Object} PluginHostIo
 * @property {() => {adapter: any, device: any, format: string}} gpu  the CURRENT device (changes after a device loss)
 * @property {() => EffectViewport} viewport
 * @property {() => void} requestRender
 * @property {() => boolean} reducedMotion  prefers-reduced-motion: reduce, now
 * @property {(error: unknown, slot: Slot, phase: string) => void} reportError  effecterror + report entry; does not throw
 * @property {() => void} [onWait]  a trigger() or settled() promise started waiting (a paused host must keep advancing it)
 */

const NO_ACTIONS = Object.freeze(/** @type {string[]} */ ([]));

/**
 * @param {HicEnv} env
 * @param {HTMLCanvasElement} canvas
 * @param {Element} source
 * @param {PluginHostIo} io
 */
export function createPluginSet(env, canvas, source, io) {
  /** @type {Slot[]} */
  const slots = [];
  /** @type {Stage[]|null} */
  let stageCache = null;
  let serial = 0;
  let closed = false;

  /** @param {Slot} slot */
  function makeContext(slot) {
    const { adapter, device, format } = io.gpu();
    return buildPluginContext(slot.def, {
      canvas, source, adapter, device, format,
      requestRender: io.requestRender,
      trigger: (action, options) => ownTrigger(slot, action, options),
      viewport: io.viewport,
      // Pointer events land on the live layer (a sibling of the canvas), not on the canvas, so listen on both.
      listen(type, listener, options) {
        const layer = env.registry.get(canvas)?.layer?.element ?? null;
        const targets = layer ? [canvas, layer] : [canvas];
        for (const t of targets) t.addEventListener(type, listener, options);
        const remove = () => {
          for (const t of targets) t.removeEventListener(type, listener, options);
          slot.removers.delete(remove);
        };
        slot.removers.add(remove);
        return remove;
      },
    });
  }

  /** @param {Slot} slot */
  async function createInstance(slot) {
    const raw = await slot.def.create(makeContext(slot), slot.options);
    try {
      const instance = validateInstance(raw, slot.def);
      if (closed || slot.removed) throw invalidState('the effect host was destroyed while the plugin was being created');
      return instance;
    } catch (error) {
      try { /** @type {any} */ (raw)?.destroy?.(); } catch { /* best effort */ }
      throw error;
    }
  }

  /** @param {Slot} slot @param {string} phase @param {() => void} fn */
  function guarded(slot, phase, fn) {
    try { fn(); } catch (error) { fail(slot, error, phase); }
  }

  /** @param {Slot} slot @param {unknown} error @param {string} phase */
  function fail(slot, error, phase) {
    slot.failed = true;
    stageCache = null;
    release(slot);
    io.reportError(error, slot, phase);
  }

  /** The pending trigger and every settled() waiter of `slot` resolve null (removed, disabled, failed). @param {Slot} slot */
  function release(slot) {
    dropPending(slot);
    for (const resolve of [...slot.waiters]) { slot.waiters.delete(resolve); resolve(null); }
  }

  /** @param {Slot} slot */
  function dropPending(slot) {
    const resolve = slot.pending;
    slot.pending = null;
    resolve?.(null);
  }

  /** Wait on the current instance's settled() for `resolve` (a waiter of an instance torn down meanwhile is attached again by recreate). @param {Slot} slot @param {(state: EffectActionState) => void} resolve */
  function attach(slot, resolve) {
    const instance = slot.instance;
    if (!instance) return;
    const generation = slot.generation;
    const done = (/** @type {EffectActionState|undefined} */ state) => { if (slot.generation === generation && slot.waiters.delete(resolve)) resolve(state ?? null); };
    const failed = (/** @type {unknown} */ error) => { io.reportError(error, slot, 'settled'); done(null); };
    try { Promise.resolve(instance.settled?.()).then(done, failed); } catch (error) { failed(error); }
  }

  /** @param {Slot} slot @param {string} method */
  function declared(slot, method) {
    const names = slot.def.actions ?? NO_ACTIONS;
    if (!names.length) throw typeError(`${method}: the plugin "${slot.def.type}" declares no actions`);
    return names;
  }

  /**
   * handle.trigger (API-CONTRACT 7.3.1). Synchronous up to runAction, so triggers keep their order.
   * @param {Slot} slot @param {unknown} action @param {unknown} options
   * @returns {Promise<EffectActionState>}
   */
  async function trigger(slot, action, options) {
    const names = declared(slot, 'trigger');
    if (typeof action !== 'string' || !names.includes(action)) {
      throw typeError(`trigger: unknown action ${JSON.stringify(action) ?? String(action)} of the plugin "${slot.def.type}"; its actions are ${names.map((n) => `'${n}'`).join(', ')}`);
    }
    if (options !== undefined && (options === null || typeof options !== 'object')) throw typeError('trigger: `options` must be an object');
    if (!slot.instance && slot.recreating && !slot.removed) await slot.recreating;
    if (slot.removed) throw invalidState('trigger: the plugin was removed');
    if (slot.failed) throw invalidState(`trigger: the plugin "${slot.def.type}" failed and was disabled (see the effecterror event)`);
    if (!slot.enabled) throw invalidState('trigger: the plugin is disabled (setEnabled(false))');
    const instance = slot.instance;
    if (!instance) throw invalidState('trigger: the plugin is not created yet');
    dropPending(slot);
    const result = instance.runAction?.(action, Object.freeze({ ...options }), Object.freeze({ reducedMotion: io.reducedMotion() }));
    io.requestRender();
    return new Promise((resolve, reject) => {
      const mine = (/** @type {EffectActionState} */ state) => { if (slot.pending === mine) slot.pending = null; resolve(state); };
      slot.pending = mine;
      io.onWait?.();
      Promise.resolve(result).then(
        (state) => { if (slot.pending === mine) mine(state ?? null); },
        (error) => { if (slot.pending === mine) { slot.pending = null; reject(error); } },
      );
    });
  }

  /** A trigger from the plugin itself (its UI, a submit): nobody awaits it, so a failure is reported. @param {Slot} slot @param {string} action @param {Record<string, unknown>} [options] */
  function ownTrigger(slot, action, options) {
    const run = trigger(slot, action, options);
    run.catch((error) => io.reportError(error, slot, 'action'));
    return run;
  }

  /** @param {Slot} slot @returns {Promise<EffectActionState>} */
  function settled(slot) {
    try { declared(slot, 'settled'); } catch (error) { return Promise.reject(error); }
    if (slot.removed || slot.failed || !slot.enabled) return Promise.resolve(null);
    return new Promise((resolve) => { slot.waiters.add(resolve); attach(slot, resolve); io.onWait?.(); });
  }

  /** @param {Slot} slot @param {{root: Element, dispose: (() => void)|null}} mount */
  function mountOn(slot, mount) {
    const instance = slot.instance;
    if (!instance || typeof instance.mountUI !== 'function') return;
    const ui = {
      canvas,
      getOptions: () => slot.options,
      setOptions: (/** @type {Record<string, unknown>} */ patch) => slot.handle.setOptions(patch),
      requestRender: io.requestRender,
      trigger: (/** @type {string} */ action, /** @type {Record<string, unknown>|undefined} */ options) => ownTrigger(slot, action, options),
    };
    const dispose = instance.mountUI(mount.root, ui);
    mount.dispose = typeof dispose === 'function' ? dispose : null;
  }

  /** @param {Slot} slot */
  function unmountAll(slot) {
    for (const m of slot.mounts) {
      const d = m.dispose;
      m.dispose = null;
      try { d?.(); } catch (error) { io.reportError(error, slot, 'mountUI-dispose'); }
    }
  }

  /** Drop the live instance (UI, listeners, destroy()) but keep the slot. @param {Slot} slot */
  function teardownInstance(slot) {
    slot.generation += 1;
    dropPending(slot);
    unmountAll(slot);
    for (const remove of [...slot.removers]) remove();
    const instance = slot.instance;
    slot.instance = null;
    stageCache = null;
    try { instance?.destroy?.(); } catch (error) { io.reportError(error, slot, 'destroy'); }
  }

  /** @param {Slot} slot */
  function removeSlot(slot) {
    if (slot.removed) return;
    slot.removed = true;
    const at = slots.indexOf(slot);
    if (at >= 0) slots.splice(at, 1);
    teardownInstance(slot);
    release(slot);
    slot.mounts.clear();
    stageCache = null;
    io.requestRender();
  }

  /** @param {Slot} slot @returns {EffectHandle} */
  function makeHandle(slot) {
    return {
      get id() { return slot.id; },
      get type() { return slot.def.type; },
      get options() { return slot.options; },
      get enabled() { return slot.enabled && !slot.failed; },
      setOptions(patch) {
        if (!patch || typeof patch !== 'object') throw typeError('setOptions: patch must be an object');
        slot.options = Object.freeze({ ...slot.options, ...patch });
        if (slot.instance) guarded(slot, 'setOptions', () => slot.instance?.setOptions?.(slot.options));
        io.requestRender();
      },
      setEnabled(enabled) {
        slot.enabled = !!enabled;
        if (enabled) slot.failed = false;
        else release(slot);
        stageCache = null;
        io.requestRender();
      },
      mountUI(root) {
        if (slot.removed) throw invalidState('the plugin was removed');
        const mount = { root, dispose: /** @type {(() => void)|null} */ (null) };
        mountOn(slot, mount);
        slot.mounts.add(mount);
        return () => {
          if (!slot.mounts.delete(mount)) return;
          const d = mount.dispose;
          mount.dispose = null;
          d?.();
        };
      },
      get actions() { return slot.def.actions ?? NO_ACTIONS; },
      trigger: (action, options) => trigger(slot, action, options),
      settled: () => settled(slot),
      remove() { removeSlot(slot); },
    };
  }

  return {
    get count() { return slots.length; },

    /**
     * @param {EffectPluginDefinition} defIn
     * @param {Record<string, unknown>} [options]
     * @returns {Promise<EffectHandle>}
     */
    async add(defIn, options = {}) {
      if (closed) throw invalidState('the effect host was destroyed');
      const def = definePlugin(defIn);
      if (!options || typeof options !== 'object') throw typeError('addPlugin: options must be an object');
      /** @type {Slot} */
      const slot = {
        id: `${def.type}-${++serial}`, def, options: Object.freeze({ ...options }),
        enabled: true, failed: false, removed: false, instance: null,
        removers: new Set(), mounts: new Set(), handle: /** @type {any} */ (null),
        pending: null, waiters: new Set(), generation: 0, recreating: null,
      };
      slot.handle = makeHandle(slot);
      slots.push(slot);
      try {
        slot.instance = await createInstance(slot);
      } catch (error) {
        removeSlot(slot);
        io.reportError(error, slot, 'create');
        throw error;
      }
      stageCache = null;
      io.requestRender();
      return slot.handle;
    },

    /** Enabled, created and not failed, in chain order. */
    stages() {
      stageCache ??= slots.flatMap((s) => (s.instance && s.enabled && !s.failed ? [{ instance: s.instance, def: s.def, slot: s }] : []));
      return stageCache;
    },
    hasContinuous() { return this.stages().some((s) => s.instance.continuous === true); },
    /** Some trigger() or settled() promise has not resolved yet (the paused host keeps rendering slowly until it has). */
    unsettled() { return slots.some((s) => s.pending !== null || s.waiters.size > 0); },
    /** @param {Slot} slot @param {unknown} error */
    fail(slot, error) { fail(slot, error, 'render'); },
    /** @param {EffectViewport} vp */
    resize(vp) {
      for (const s of this.stages()) if (s.instance.resize) guarded(s.slot, 'resize', () => s.instance.resize?.(vp));
    },

    /** After a device loss: destroy every instance, create it again on the new device with its latest options, re-mount its UI. */
    async recreate() {
      for (const slot of [...slots]) {
        if (slot.removed || slot.failed) continue;
        teardownInstance(slot);
        const again = async () => {
          try {
            slot.instance = await createInstance(slot);
            for (const m of slot.mounts) mountOn(slot, m);
            for (const resolve of slot.waiters) attach(slot, resolve);
          } catch (error) {
            fail(slot, error, 'recreate');
          }
        };
        slot.recreating = again();
        await slot.recreating;
        slot.recreating = null;
      }
      stageCache = null;
    },

    destroy() {
      closed = true;
      for (const slot of [...slots]) removeSlot(slot);
    },
  };
}
