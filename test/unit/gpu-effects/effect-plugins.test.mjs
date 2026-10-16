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
  let reduced = false;
  let gpu = { adapter: 'a1', device: 'd1', format: 'bgra8unorm' };
  const io = {
    gpu: () => gpu,
    viewport: () => ({ width: 10, height: 10, cssWidth: 10, cssHeight: 10, dpr: 1 }),
    requestRender: () => { renders += 1; },
    reducedMotion: () => reduced,
    reportError: (error, slot, phase) => errors.push({ error, type: slot.def.type, phase }),
  };
  const set = createPluginSet(env, canvas, {}, io);
  return { set, errors, listeners, renders: () => renders, setGpu: (g) => { gpu = g; }, setReduced: (v) => { reduced = v; } };
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

/**
 * A plugin with actions whose runs the test finishes by hand: `runs` records each runAction call ({action, options, info, resolve,
 * reject}); settled() resolves with `state` once `rest()` is called (at once when nothing is running).
 */
function actor(log = [], over = {}) {
  /** @type {any[]} */ const runs = [];
  /** @type {((s: string) => void)[]} */ const waiters = [];
  const st = { state: 'idle', moving: false, instances: 0 };
  const def = definePlugin({
    type: 'actor', apiVersion: 2, version: 1, actions: ['go', 'stop'],
    create(ctx) {
      st.instances += 1;
      st.context = ctx;
      const me = st.instances;
      return {
        render() {},
        runAction(action, options, info) {
          log.push(['run', me, action]);
          st.moving = true;
          return new Promise((resolve, reject) => runs.push({ action, options, info, resolve, reject, instance: me }));
        },
        settled() { return st.moving ? new Promise((r) => waiters.push(r)) : st.state; },
        mountUI(root, ui) { st.ui = ui; },
        destroy() { log.push(['destroy', me]); },
        ...over,
      };
    },
  });
  const rest = (state) => { st.state = state; st.moving = false; for (const r of waiters.splice(0)) r(state); };
  return { def, runs, st, rest };
}

test('actions: the handle lists them; trigger runs the instance with frozen options and the reduced-motion reading, and resolves with its state', async () => {
  const r = rig();
  const a = actor();
  const h = await r.set.add(a.def);
  assert.deepEqual([...h.actions], ['go', 'stop']);
  const before = r.renders();
  const p = h.trigger('go', { speed: 2 });
  assert.equal(a.runs.length, 1, 'runAction is called synchronously: triggers keep their order');
  assert.equal(r.renders(), before + 1, 'a frame is requested');
  assert.deepEqual({ ...a.runs[0].options }, { speed: 2 });
  assert.ok(Object.isFrozen(a.runs[0].options));
  assert.deepEqual(a.runs[0].info, { reducedMotion: false });
  a.runs[0].resolve('gone');
  assert.equal(await p, 'gone');
  r.setReduced(true);
  const q = h.trigger('stop');
  assert.deepEqual(a.runs[1].info, { reducedMotion: true }, 'prefers-reduced-motion is read at each trigger');
  assert.deepEqual({ ...a.runs[1].options }, {}, 'no options: an empty object');
  a.runs[1].resolve(undefined);
  assert.equal(await q, null, 'a plugin that resolves nothing: null');
});

test('trigger: an unknown action, a plugin without actions and bad options are TypeErrors that name what is accepted', async () => {
  const r = rig();
  const h = await r.set.add(actor().def);
  await assert.rejects(h.trigger('jump'), (e) => e instanceof TypeError && /unknown action "jump" of the plugin "actor"; its actions are 'go', 'stop'/.test(e.message));
  await assert.rejects(h.trigger(/** @type {any} */ (undefined)), /unknown action undefined/);
  await assert.rejects(h.trigger('go', /** @type {any} */ (5)), /options.*must be an object/);
  await assert.rejects(h.trigger('go', /** @type {any} */ (null)), TypeError);
  const plain = await r.set.add(recorder([]));
  assert.deepEqual([...plain.actions], []);
  await assert.rejects(plain.trigger('go'), (e) => e instanceof TypeError && /the plugin "rec" declares no actions/.test(e.message));
  await assert.rejects(plain.settled(), (e) => e instanceof TypeError && /settled: the plugin "rec" declares no actions/.test(e.message));
  assert.equal(r.errors.length, 0, 'a page error is a rejection, not an effecterror');
});

test('trigger: a newer trigger resolves the older one with null at once, also when the plugin finishes the older one later', async () => {
  const r = rig();
  const a = actor();
  const h = await r.set.add(a.def);
  const first = h.trigger('go');
  const second = h.trigger('stop');
  assert.equal(await first, null, 'superseded');
  a.runs[0].resolve('late');
  a.runs[1].resolve('stopped');
  assert.equal(await second, 'stopped');
  const third = h.trigger('go');
  a.runs[2].resolve(null);
  assert.equal(await third, null, 'superseded inside the plugin (its own submit, setOptions): the plugin resolves null');
});

test('trigger: a plugin error rejects with that error and leaves the plugin running; a failing trigger of the plugin itself is reported', async () => {
  const r = rig();
  const a = actor();
  const h = await r.set.add(a.def);
  const p = h.trigger('go');
  a.runs[0].reject(new RangeError('too fast'));
  await assert.rejects(p, RangeError);
  assert.equal(h.enabled, true);
  assert.equal(r.errors.length, 0);
  const thrower = actor([], { runAction() { throw new TypeError('bad point'); } });
  const t = await r.set.add(thrower.def);
  await assert.rejects(t.trigger('go'), /bad point/);
  assert.equal(t.enabled, true, 'a throwing runAction does not disable the plugin');
  h.mountUI({});
  const own = a.st.ui.trigger('go');
  a.runs.at(-1).reject(new Error('plugin bug'));
  await assert.rejects(own, /plugin bug/);
  await Promise.resolve();
  assert.deepEqual(r.errors.map((e) => [e.type, e.phase]), [['actor', 'action']], 'the UI trigger failed: reported, since nobody awaits it');
  const ctxRun = a.st.context.trigger('nope');
  await assert.rejects(ctxRun, /unknown action/);
  await Promise.resolve();
  assert.equal(r.errors.length, 2, 'the context trigger of the plugin itself is reported too');
});

test('the plugin\'s own triggers (context.trigger, ui.trigger) go through the handle: they supersede a page trigger', async () => {
  const r = rig();
  const a = actor();
  const h = await r.set.add(a.def);
  h.mountUI({});
  const page = h.trigger('go');
  const ui = a.st.ui.trigger('stop');
  assert.equal(await page, null);
  a.runs[1].resolve('stopped');
  assert.equal(await ui, 'stopped');
  const page2 = h.trigger('go');
  const own = a.st.context.trigger('stop');
  assert.equal(await page2, null);
  a.runs[3].resolve('stopped');
  assert.equal(await own, 'stopped');
});

test('settled: waits on the instance, resolves with its state; at once when nothing moves', async () => {
  const r = rig();
  const a = actor();
  const h = await r.set.add(a.def);
  assert.equal(await h.settled(), 'idle', 'nothing moves');
  h.trigger('go');
  let seen = null;
  const s = h.settled().then((v) => { seen = v; });
  await Promise.resolve();
  assert.equal(seen, null);
  a.rest('far');
  await s;
  assert.equal(seen, 'far');
});

test('removal: the pending trigger and every settled() waiter resolve null; later calls reject (trigger) or resolve null (settled)', async () => {
  const r = rig();
  const a = actor();
  const h = await r.set.add(a.def);
  const p = h.trigger('go');
  const s = h.settled();
  h.remove();
  assert.equal(await p, null);
  assert.equal(await s, null);
  a.runs[0].resolve('late');
  await assert.rejects(h.trigger('go'), (e) => e.name === 'InvalidStateError' && /removed/.test(e.message));
  assert.equal(await h.settled(), null);
  const b = actor();
  const h2 = await r.set.add(b.def);
  const p2 = h2.trigger('go');
  r.set.destroy();
  assert.equal(await p2, null, 'host.destroy() removes every plugin');
});

test('disable and failure: the pending trigger and the waiters resolve null; trigger then rejects, settled resolves null', async () => {
  const r = rig();
  const a = actor();
  const h = await r.set.add(a.def);
  const p = h.trigger('go');
  const s = h.settled();
  h.setEnabled(false);
  assert.equal(await p, null);
  assert.equal(await s, null);
  await assert.rejects(h.trigger('go'), /disabled/);
  assert.equal(await h.settled(), null);
  h.setEnabled(true);
  const q = h.trigger('go');
  const w = h.settled();
  r.set.fail(r.set.stages()[0].slot, new Error('render threw'));
  assert.equal(await q, null);
  assert.equal(await w, null);
  await assert.rejects(h.trigger('go'), (e) => e.name === 'InvalidStateError' && /failed/.test(e.message));
});

test('device loss: the pending trigger resolves null; settled() waits on the re-created instance; a trigger during the re-creation runs on the new instance', async () => {
  const r = rig();
  const log = [];
  const a = actor(log);
  const h = await r.set.add(a.def);
  const p = h.trigger('go');
  const s = h.settled();
  r.setGpu({ adapter: 'a2', device: 'd2', format: 'bgra8unorm' });
  const recreating = r.set.recreate();
  const during = h.trigger('stop');
  assert.equal(await p, null, 'the action died with the old device');
  await recreating;
  assert.equal(a.st.instances, 2);
  assert.deepEqual(log.filter((l) => l[0] === 'run').map((l) => [l[1], l[2]]), [[1, 'go'], [2, 'stop']], 'the trigger made during the re-creation ran on the new instance');
  let seen = 'pending';
  s.then((v) => { seen = v; });
  a.runs[0].resolve('old');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(seen, 'pending', 'the waiter does not take the answer of the destroyed instance');
  a.runs[1].resolve('stopped');
  a.rest('stopped');
  assert.equal(await during, 'stopped');
  assert.equal(await s, 'stopped', 'the waiter got the state of the re-created instance');
});
