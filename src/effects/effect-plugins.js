/**
 * The plugins of one effect host: creation, handles, option/enable/UI state, re-creation after device loss.
 * Module: gpu-effects (src/effects/**).
 */

import { invalidState, typeError } from '../contracts/errors.js';
import { buildPluginContext, definePlugin, validateInstance } from './plugin-abi.js';

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
 */

/** @typedef {{instance: EffectPluginInstance, def: EffectPluginDefinition, slot: Slot}} Stage */

/**
 * What the plugin set needs from its host.
 * @typedef {Object} PluginHostIo
 * @property {() => {adapter: any, device: any, format: string}} gpu  the CURRENT device (changes after a device loss)
 * @property {() => EffectViewport} viewport
 * @property {() => void} requestRender
 * @property {(error: unknown, slot: Slot, phase: string) => void} reportError  effecterror + report entry; does not throw
 */

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
    io.reportError(error, slot, phase);
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
        try {
          slot.instance = await createInstance(slot);
          for (const m of slot.mounts) mountOn(slot, m);
        } catch (error) {
          fail(slot, error, 'recreate');
        }
      }
      stageCache = null;
    },

    destroy() {
      closed = true;
      for (const slot of [...slots]) removeSlot(slot);
    },
  };
}
