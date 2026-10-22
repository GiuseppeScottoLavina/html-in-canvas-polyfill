/**
 * Composition root: builds every module through the Services factories and wires the BUS topics between them.
 * The only place that constructs the other modules' objects.
 * Module: api-core.
 */

/** @typedef {import('../contracts/types.js').CanvasRegistryView} CanvasRegistryView */
/** @typedef {import('../contracts/types.js').EffectsDeps} EffectsDeps */
/** @typedef {import('../contracts/types.js').EffectsSeam} EffectsSeam */
/** @typedef {import('../contracts/types.js').GeometryApi} GeometryApi */
/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../contracts/types.js').InteractionTracker} InteractionTracker */
/** @typedef {import('../contracts/types.js').PatchLedger} PatchLedger */
/** @typedef {import('../contracts/types.js').SchedulerHooks} SchedulerHooks */
/** @typedef {import('../contracts/types.js').Services} Services */
/** @typedef {import('./canvas-registry.js').CoreRegistry} CoreRegistry */

import { BUS } from '../contracts/events.js';
import { createLiveLayer } from '../live/live-layer.js';
import { createRootScope } from '../live/root-scope.js';
import { installSelectorBridge } from '../live/selector-bridge.js';
import { createCapture } from '../snapshot/capture/capture.js';
import { createSnapshotStore } from '../snapshot/store/store.js';
import { createScheduler } from '../schedule/scheduler.js';
import { startObservers } from '../schedule/observers/index.js';
import { createInteractionTracker } from '../schedule/observers/interaction-tracker.js';
import { createAnimatedImages } from '../schedule/observers/animated-images.js';
import { createGeometryApi } from './geometry.js';
import { createCanvasRegistry } from './canvas-registry.js';

/**
 * The hand-over point between the core and the optional effects bundle (dist/hic-live-effects.iife.js): the core only publishes the internals the effects need
 * (env + store/scheduler/geometry/tracker) on the HicInstalled; it never imports effects code.
 * @param {HicEnv} env
 * @param {EffectsDeps} deps
 * @returns {EffectsSeam}
 */
function createEffectsSeam(env, deps) {
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

/**
 * The production Services (also the type-level conformance check of every factory signature against contracts/types.js Services).
 * @returns {Services}
 */
export function defaultServices() {
  return { createLiveLayer, createRootScope, installSelectorBridge, createCapture, createSnapshotStore, createScheduler, startObservers, createEffects: createEffectsSeam, createInteractionTracker };
}

/**
 * An object that throws a clear error on any property access or call (the services a native-mode install does not have).
 * @param {string} name
 * @param {string} cause
 * @returns {any}
 */
export function unavailable(name, cause) {
  const fail = () => {
    throw new Error(`[hic-live-polyfill] service "${name}" is not available: ${cause}`);
  };
  return new Proxy(function standIn() {}, {
    get: (_target, prop) => (typeof prop === 'symbol' || prop === 'then' ? undefined : fail()),
    set: fail,
    apply: fail,
  });
}

/**
 * Tear down in order, one failing disposer never stops the others.
 * @param {HicEnv} env
 * @param {Array<[string, unknown]>} parts  [name, object with dispose()] in teardown order
 */
function disposeAll(env, parts) {
  for (const [name, part] of parts) {
    if (!part) continue;
    try { /** @type {{dispose?: () => void}} */ (part).dispose?.(); } catch (err) { env.reporter.caught(err, `dispose.${name}`); }
  }
}

/**
 * Create the root scope, registry, capture, store, scheduler, observers and effects; assign env.roots/env.registry/env.adopt/env.store/env.scheduler;
 * subscribe: CANVAS_MOUNTED -> scheduler.register, CANVAS_UNMOUNTING -> scheduler.unregister + store.forget (the store also subscribes itself; forget is idempotent).
 * Drawable, resize, DPR and geometry topics are consumed by the modules that own them (store, effects, observers), not re-routed here.
 * @param {HicEnv} env
 * @param {Services} services
 * @param {SchedulerHooks} hooks
 * @param {PatchLedger} ledger  the install's ledger (the root scope patches attachShadow through it)
 * @returns {{effects: EffectsSeam, geometry: GeometryApi, registry: import('./canvas-registry.js').CoreRegistry, dispose: () => void}}
 */
export function compose(env, services, hooks, ledger) {
  // Everything created so far, so that a throwing factory unwinds the part that already runs (observers, intervals, listeners) instead of leaking it.
  /** @type {Partial<{roots: unknown, registry: CoreRegistry, animatedImages: unknown, store: unknown, scheduler: unknown, effects: unknown, stopObservers: unknown, stopBridge: unknown, offResources: (() => void)|undefined, offs: Array<() => void>}>} */
  const made = {};
  const teardown = () => {
    // Records first: unmounting restores the children while scheduler and store still exist to be told.
    try { made.registry?.dispose(); } catch (err) { env.reporter.caught(err, 'dispose.registry'); }
    for (const off of made.offs ?? []) off();
    made.offResources?.();
    for (const [name, stop] of /** @type {Array<[string, unknown]>} */ ([['selector-bridge', made.stopBridge], ['observers', made.stopObservers]])) {
      if (typeof stop !== 'function') continue;
      try { stop(); } catch (err) { env.reporter.caught(err, `dispose.${name}`); }
    }
    disposeAll(env, [['effects', made.effects], ['scheduler', made.scheduler], ['store', made.store], ['animated-images', made.animatedImages], ['roots', made.roots]]);
    for (const key of Object.keys(made)) delete (/** @type {Record<string, unknown>} */ (made))[key];
  };
  try {
    return wire(env, services, hooks, ledger, made, teardown);
  } catch (err) {
    teardown();
    throw err;
  }
}

/**
 * The body of compose(); every created part is recorded in `made` the moment it exists.
 * @param {HicEnv} env
 * @param {Services} services
 * @param {SchedulerHooks} hooks
 * @param {PatchLedger} ledger
 * @param {Record<string, any>} made
 * @param {() => void} dispose
 * @returns {{effects: EffectsSeam, geometry: GeometryApi, registry: CoreRegistry, dispose: () => void}}
 */
function wire(env, services, hooks, ledger, made, dispose) {
  const roots = (made.roots = services.createRootScope(env, ledger));
  env.roots = roots;
  const registry = (made.registry = createCanvasRegistry(env, (e, record) => services.createLiveLayer(e, record)));
  env.registry = registry;
  env.adopt = (canvas) => { registry.ensure(canvas); };
  env.animatedImages = made.animatedImages = createAnimatedImages(env);
  const capture = services.createCapture(env);
  const tracker = services.createInteractionTracker(env, capture);
  const resources = capture.resources;
  const store = (made.store = services.createSnapshotStore(env, capture, { resources, interaction: tracker, textOverlay: capture.textOverlay, scrollPlan: capture.scrollPlan, caretOf: capture.caretOf }));
  env.store = store;
  const scheduler = (made.scheduler = services.createScheduler(env, store, hooks));
  env.scheduler = scheduler;
  made.stopObservers = services.startObservers(env, tracker, ledger);
  made.stopBridge = services.installSelectorBridge(env, ledger);
  const geometry = createGeometryApi(env);
  const effects = (made.effects = services.createEffects(env, { store, scheduler, geometry, tracker }));

  // A resource that was missing at capture time arrived: the tile that held a placeholder is rebuilt (CaptureResult.complete was false).
  made.offResources = resources?.onReady(() => {
    for (const record of registry.all()) if (record.state === 'active') scheduler.damage(record, 'resource', null, null);
  });

  made.offs = [
    env.bus.on(BUS.CANVAS_MOUNTED, ({ record }) => scheduler.register(record)),
    env.bus.on(BUS.CANVAS_UNMOUNTING, ({ record }) => { scheduler.unregister(record); store.forget(record); }),
  ];
  return { effects, geometry, registry, dispose };
}

/** @type {CanvasRegistryView} */
const NO_CANVASES = Object.freeze({
  get: () => undefined,
  all: () => [],
  ownerOfDrawable: () => undefined,
  logicalCanvasAncestor: () => null,
});

/** @type {InteractionTracker} */
const NO_INTERACTION = Object.freeze({
  snapshot: () => ({ hover: new Set(), active: new Set(), focus: null, focusVisible: false, caretVisible: false }),
  setMappedTarget: () => {},
  onChange: () => () => {},
});

/**
 * Modes native and native-bridged: no layer, no snapshots, no scheduler. Only the effects seam is built; the effects bundle then reads the native implementation
 * through its native source provider and finds no record for any canvas.
 * @param {HicEnv} env
 * @param {Services} services
 * @returns {{effects: EffectsSeam, dispose: () => void}}
 */
export function composeNative(env, services) {
  const absent = (/** @type {string} */ name) => unavailable(name, 'the browser renders HTML-in-Canvas natively, so the polyfill runs no snapshot pipeline');
  env.roots = absent('roots');
  env.registry = NO_CANVASES;
  env.adopt = () => {};
  env.store = absent('store');
  env.scheduler = absent('scheduler');
  const effects = services.createEffects(env, { store: env.store, scheduler: env.scheduler, geometry: absent('geometry'), tracker: NO_INTERACTION });
  return { effects, dispose: () => disposeAll(env, [['effects', effects]]) };
}
