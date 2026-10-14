import test from 'node:test';
import assert from 'node:assert/strict';
import { createPluginSet } from '../../../src/effects/effect-plugins.js';
import { definePlugin } from '../../../src/effects/plugin-abi.js';

function rig() {
  const listeners = [];
  const layer = { element: { addEventListener: (t, l) => listeners.push(['layer', t, l]), removeEventListener: (t, l) => { const i = listeners.findIndex((x) => x[2] === l && x[0] === 'layer'); if (i >= 0) listeners.splice(i, 1); } } };
  const canvas = { addEventListener: (t, l) => listeners.push(['canvas', t, l]), removeEventListener: (t, l) => { const i = listeners.findIndex((x) => x[2] === l && x[0] === 'canvas'); if (i >= 0) listeners.splice(i, 1); } };
  const env = { registry: { get: () => ({ layer }) } };
  const errors = [];
  let renders = 0;
  let gpu = { adapter: 'a1', device: 'd1', format: 'bgra8unorm' };
  const io = {
    gpu: () => gpu,
    viewport: () => ({ width: 10, height: 10, cssWidth: 10, cssHeight: 10, dpr: 1 }),
    requestRender: () => { renders += 1; },
    reportError: (error, slot, phase) => errors.push({ error, type: slot.def.type, phase }),
  };
  const set = createPluginSet(env, canvas, {}, io);
  return { set, errors, listeners, renders: () => renders, setGpu: (g) => { gpu = g; } };
}

/** A plugin that records its life. */
function recorder(log, over = {}) {
  return definePlugin({
    type: 'rec', apiVersion: 2, version: 1,
    create(ctx, options) {
      log.push(['create', ctx.device, { ...options }]);
      ctx.listen('pointerdown', () => {});
      return {
        render() {}, continuous: over.continuous,
        setOptions: (o) => log.push(['setOptions', { ...o }]),
        resize: (vp) => log.push(['resize', vp.width]),
        mountUI: (root) => { log.push(['mount', root]); return () => log.push(['unmount', root]); },
        destroy: () => log.push(['destroy']),
        ...over.instance,
      };
    },
  });
}

test('add: create gets the current device and the options; the stage appears in chain order', async () => {
  const { set } = rig();
  const log = [];
  const h1 = await set.add(recorder(log), { a: 1 });
  const h2 = await set.add(recorder(log), { a: 2 });
  assert.equal(set.count, 2);
  assert.deepEqual(log[0], ['create', 'd1', { a: 1 }]);
  assert.deepEqual(set.stages().map((s) => s.slot.handle.id), [h1.id, h2.id]);
  assert.notEqual(h1.id, h2.id);
  assert.equal(h1.type, 'rec');
});

test('a create() that throws rejects add, leaves no slot and reports phase "create"', async () => {
  const { set, errors } = rig();
  const bad = definePlugin({ type: 'bad', apiVersion: 2, version: 1, create() { throw new Error('no gpu feature'); } });
  await assert.rejects(set.add(bad), /no gpu feature/);
  assert.equal(set.count, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].phase, 'create');
});

test('an instance that violates the ABI (spatial without a mapper) is rejected and destroyed', async () => {
  const { set } = rig();
  let destroyed = 0;
  const bad = definePlugin({ type: 'sp', apiVersion: 2, version: 1, create: () => ({ render() {}, spatial: true, destroy: () => { destroyed += 1; } }) });
  await assert.rejects(set.add(bad), /captureInputMapper/);
  assert.equal(destroyed, 1);
  assert.equal(set.count, 0);
});

test('setOptions merges, freezes, and reaches the instance with the merged options', async () => {
  const { set } = rig();
  const log = [];
  const h = await set.add(recorder(log), { a: 1, b: 1 });
  h.setOptions({ b: 2 });
  assert.deepEqual(log.at(-1), ['setOptions', { a: 1, b: 2 }]);
  assert.deepEqual({ ...h.options }, { a: 1, b: 2 });
  assert.ok(Object.isFrozen(h.options));
  assert.throws(() => h.setOptions(null), TypeError);
});

test('setEnabled(false) takes the stage out of the chain; true puts it back', async () => {
  const { set } = rig();
  const h = await set.add(recorder([]));
  h.setEnabled(false);
  assert.equal(set.stages().length, 0);
  assert.equal(h.enabled, false);
  h.setEnabled(true);
  assert.equal(set.stages().length, 1);
});

test('a failing plugin is dropped from the chain, reported, and can be re-enabled', async () => {
  const { set, errors } = rig();
  const h = await set.add(recorder([]));
  const stage = set.stages()[0];
  set.fail(stage.slot, new Error('boom'));
  assert.equal(set.stages().length, 0);
  assert.equal(h.enabled, false);
  assert.deepEqual(errors.map((e) => e.phase), ['render']);
  h.setEnabled(true);
  assert.equal(set.stages().length, 1, 'setEnabled(true) clears the failed flag');
});

test('hasContinuous reflects enabled continuous plugins only', async () => {
  const { set } = rig();
  const a = await set.add(recorder([], { continuous: true }));
  await set.add(recorder([], { continuous: false }));
  assert.equal(set.hasContinuous(), true);
  a.setEnabled(false);
  assert.equal(set.hasContinuous(), false);
});

test('listen registers on the canvas AND the layer, and removal on remove() undoes both', async () => {
  const { set, listeners } = rig();
  const h = await set.add(recorder([]));
  assert.deepEqual(listeners.map((l) => l[0]).sort(), ['canvas', 'layer']);
  h.remove();
  assert.equal(listeners.length, 0);
  assert.equal(set.count, 0);
});

test('mountUI: mounts now, returns a disposer, remove() disposes mounted UI, destroy() runs once', async () => {
  const { set } = rig();
  const log = [];
  const h = await set.add(recorder(log));
  const root = { id: 'root' };
  const dispose = h.mountUI(root);
  assert.deepEqual(log.at(-1), ['mount', root]);
  dispose();
  assert.deepEqual(log.at(-1), ['unmount', root]);
  dispose();
  assert.equal(log.filter((l) => l[0] === 'unmount').length, 1, 'a second dispose is a no-op');
  h.mountUI(root);
  h.remove();
  assert.equal(log.filter((l) => l[0] === 'unmount').length, 2);
  assert.equal(log.filter((l) => l[0] === 'destroy').length, 1);
  assert.throws(() => h.mountUI(root), /removed/);
});

test('recreate (device loss): every plugin is created again on the NEW device with its LATEST options, UI re-mounted', async () => {
  const r = rig();
  const log = [];
  const h = await r.set.add(recorder(log), { level: 1 });
  h.mountUI({ id: 'ui' });
  h.setOptions({ level: 5 });
  log.length = 0;
  r.setGpu({ adapter: 'a2', device: 'd2', format: 'bgra8unorm' });
  await r.set.recreate();
  assert.deepEqual(log.map((l) => l[0]), ['unmount', 'destroy', 'create', 'mount']);
  assert.deepEqual(log.find((l) => l[0] === 'create'), ['create', 'd2', { level: 5 }]);
  assert.equal(r.set.stages().length, 1);
});

test('recreate skips a failed plugin and isolates a plugin that fails to come back', async () => {
  const r = rig();
  let calls = 0;
  const flaky = definePlugin({ type: 'flaky', apiVersion: 2, version: 1, create() { calls += 1; if (calls > 1) throw new Error('lost again'); return { render() {} }; } });
  await r.set.add(flaky);
  const good = await r.set.add(recorder([]));
  await r.set.recreate();
  assert.equal(r.set.stages().length, 1);
  assert.equal(r.set.stages()[0].slot.handle.id, good.id);
  assert.deepEqual(r.errors.map((e) => e.phase), ['recreate']);
});

test('resize reaches every enabled instance; a throwing resize disables only that plugin', async () => {
  const r = rig();
  const log = [];
  await r.set.add(recorder(log));
  await r.set.add(recorder([], { instance: { resize() { throw new Error('bad resize'); } } }));
  r.set.resize({ width: 640 });
  assert.deepEqual(log.filter((l) => l[0] === 'resize'), [['resize', 640]]);
  assert.equal(r.set.stages().length, 1);
  assert.equal(r.errors[0].phase, 'resize');
});

test('destroy tears everything down and add() afterwards rejects', async () => {
  const { set } = rig();
  const log = [];
  await set.add(recorder(log));
  set.destroy();
  assert.equal(set.count, 0);
  assert.equal(log.filter((l) => l[0] === 'destroy').length, 1);
  await assert.rejects(set.add(recorder(log)), /destroyed/);
});
