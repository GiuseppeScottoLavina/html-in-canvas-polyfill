import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUS } from '../../../src/contracts/events.js';
import { compose, composeNative, defaultServices } from '../../../src/api/compose.js';
import { buildReport } from '../../../src/api/report.js';
import { fakeEnv } from './_fake-env.mjs';

/** Services that record how they were built and what was called on them. */
function fakeServices() {
  /** @type {string[]} */ const calls = [];
  const store = { forget: (/** @type {any} */ r) => calls.push(`store.forget:${r.id}`), dispose: () => calls.push('store.dispose') };
  const scheduler = { register: (/** @type {any} */ r) => calls.push(`scheduler.register:${r.id}`), unregister: (/** @type {any} */ r) => calls.push(`scheduler.unregister:${r.id}`), dispose: () => calls.push('scheduler.dispose') };
  const roots = { dispose: () => calls.push('roots.dispose'), roots: () => [] };
  const effects = { dispose: () => calls.push('effects.dispose') };
  const tracker = { snapshot() {}, setMappedTarget() {}, onChange: () => () => {} };
  /** @type {any} */
  const seen = {};
  const services = /** @type {any} */ ({
    createRootScope: (/** @type {any} */ env, /** @type {any} */ ledger) => { seen.ledger = ledger; calls.push('createRootScope'); return roots; },
    createLiveLayer: () => { throw new Error('layer factory is not called by compose itself'); },
    installSelectorBridge: (/** @type {any} */ env, /** @type {any} */ ledger) => { seen.bridgeLedger = ledger; calls.push('installSelectorBridge'); return () => calls.push('bridge.remove'); },
    createCapture: () => { calls.push('createCapture'); return () => { throw new Error('unused'); }; },
    createSnapshotStore: (/** @type {any} */ env, /** @type {any} */ capture, /** @type {any} */ extras) => { seen.capture = capture; seen.storeExtras = extras; calls.push('createSnapshotStore'); return store; },
    createScheduler: (/** @type {any} */ env, /** @type {any} */ s, /** @type {any} */ hooks) => { seen.schedulerStore = s; seen.hooks = hooks; calls.push('createScheduler'); return scheduler; },
    createInteractionTracker: () => { calls.push('createInteractionTracker'); return tracker; },
    startObservers: (/** @type {any} */ env, /** @type {any} */ t, /** @type {any} */ ledger) => { seen.observerTracker = t; seen.observerLedger = ledger; calls.push('startObservers'); return () => calls.push('observers.stop'); },
    createEffects: (/** @type {any} */ env, /** @type {any} */ deps) => { seen.effectDeps = deps; calls.push('createEffects'); return effects; },
  });
  return { services, calls, seen, store, scheduler, roots, effects, tracker };
}

test('defaultServices has every factory of Services', () => {
  const keys = Object.keys(defaultServices()).sort();
  assert.deepEqual(keys, ['createCapture', 'createEffects', 'createInteractionTracker', 'createLiveLayer', 'createRootScope', 'createScheduler', 'createSnapshotStore', 'installSelectorBridge', 'startObservers']);
});

test('compose wires the factories in dependency order and fills the env slots', () => {
  const { env } = fakeEnv();
  const f = fakeServices();
  const hooks = { firePaint() {} };
  const ledger = /** @type {any} */ ({ marker: 1 });
  const composed = compose(env, f.services, hooks, ledger);
  assert.deepEqual(f.calls, ['createRootScope', 'createCapture', 'createInteractionTracker', 'createSnapshotStore', 'createScheduler', 'startObservers', 'installSelectorBridge', 'createEffects']);
  assert.equal(f.seen.ledger, ledger, 'the root scope patches through the install ledger');
  assert.equal(f.seen.schedulerStore, f.store);
  assert.equal(f.seen.hooks, hooks);
  assert.equal(f.seen.observerTracker, f.tracker);
  assert.equal(f.seen.observerLedger, ledger, 'the stylesheet observer patches through the install ledger');
  assert.equal(f.seen.storeExtras.interaction, f.tracker, 'the store reads hover/focus/caret phase from the tracker');
  assert.equal(f.seen.effectDeps.store, f.store);
  assert.equal(f.seen.effectDeps.scheduler, f.scheduler);
  assert.equal(f.seen.effectDeps.tracker, f.tracker);
  assert.equal(f.seen.effectDeps.geometry, composed.geometry);
  assert.equal(env.store, /** @type {any} */ (f.store));
  assert.equal(env.scheduler, /** @type {any} */ (f.scheduler));
  assert.equal(env.roots, /** @type {any} */ (f.roots));
  assert.equal(env.registry, /** @type {any} */ (composed.registry));
  assert.equal(typeof env.adopt, 'function');
  assert.equal(composed.effects, /** @type {any} */ (f.effects));
});

test('a mounted canvas is registered with the scheduler, an unmounting one is unregistered and forgotten', () => {
  const { env, bus } = fakeEnv();
  const f = fakeServices();
  compose(env, f.services, { firePaint() {} }, /** @type {any} */ ({}));
  f.calls.length = 0;
  bus.emit(BUS.CANVAS_MOUNTED, { record: { id: 7 } });
  bus.emit(BUS.CANVAS_UNMOUNTING, { record: { id: 7 } });
  assert.deepEqual(f.calls, ['scheduler.register:7', 'scheduler.unregister:7', 'store.forget:7']);
});

test('dispose: records first, then bridge, observers, effects, scheduler, store, roots; subscriptions are gone', () => {
  const { env, bus } = fakeEnv();
  const f = fakeServices();
  const composed = compose(env, f.services, { firePaint() {} }, /** @type {any} */ ({}));
  f.calls.length = 0;
  composed.dispose();
  assert.deepEqual(f.calls, ['bridge.remove', 'observers.stop', 'effects.dispose', 'scheduler.dispose', 'store.dispose', 'roots.dispose']);
  bus.emit(BUS.CANVAS_MOUNTED, { record: { id: 1 } });
  assert.equal(f.calls.includes('scheduler.register:1'), false);
});

test('one failing disposer never stops the others and is recorded', () => {
  const { env } = fakeEnv();
  const f = fakeServices();
  f.effects.dispose = () => { throw new Error('effects blew up'); };
  const composed = compose(env, f.services, { firePaint() {} }, /** @type {any} */ ({}));
  f.calls.length = 0;
  composed.dispose();
  assert.ok(f.calls.includes('scheduler.dispose') && f.calls.includes('store.dispose') && f.calls.includes('roots.dispose'));
  const report = buildReport(env, { version: 't', mode: 'polyfill', native: /** @type {any} */ ({ present: [], missing: [], legacyNames: [], gaps: [] }) });
  assert.ok(report.errors.some((e) => e.name === 'dispose.effects' && /effects blew up/.test(e.message)));
});

test('a factory that throws propagates (nothing is tolerated or replaced by a stand-in)', () => {
  const { env } = fakeEnv();
  const f = fakeServices();
  f.services.createCapture = () => { throw new TypeError('real bug'); };
  assert.throws(() => compose(env, f.services, { firePaint() {} }, /** @type {any} */ ({})), /real bug/);
});

test('composeNative: no registry records, no store/scheduler, effects built with inert deps', () => {
  const { env } = fakeEnv();
  const f = fakeServices();
  const composed = composeNative(env, f.services);
  assert.deepEqual(f.calls, ['createEffects'], 'nothing but the effects is built');
  assert.equal(env.registry.get(/** @type {any} */ ({})), undefined);
  assert.deepEqual(env.registry.all(), []);
  assert.equal(env.registry.ownerOfDrawable(/** @type {any} */ ({})), undefined);
  assert.throws(() => env.store.version, /service "store" is not available.*natively/s);
  assert.throws(() => f.seen.effectDeps.geometry.update, /service "geometry"/);
  assert.deepEqual([...f.seen.effectDeps.tracker.snapshot().hover], []);
  env.adopt(/** @type {any} */ ({}));
  composed.dispose();
  assert.deepEqual(f.calls, ['createEffects', 'effects.dispose']);
});
