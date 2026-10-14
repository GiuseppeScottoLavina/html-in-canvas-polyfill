// Effect host on a real WebGPU device. Skipped LOUDLY (test names start with "SKIPPED: no WebGPU") when the machine has none.
import { test, assert, sleep } from '/test/unit/lib/t.js';
import { gpuAvailable, makeRig, nonDominantShare, px } from './lib/rig.mjs';
import { createEffectHost } from '/src/effects/effect-host.js';
import { createPresenter } from '/src/effects/gpu-presenter.js';
import { createEffects, createLateEffects, installEffectsGlobal } from '/src/effects/index.js';
import { EXT } from '/src/contracts/events.js';
import { definePlugin } from '/src/effects/plugin-abi.js';
import { WaterEffectPlugin } from '/src/effects/water/water-plugin.js';
import { BUS, EVENTS } from '/src/contracts/events.js';

const GPU = await gpuAvailable();
console.error(`gpu-effects host tests: WebGPU ${GPU ? 'available' : 'NOT available'}`);
const gtest = (name, fn, opts) => (GPU ? test(name, fn, opts) : test.skip(`SKIPPED: no WebGPU - ${name}`, fn));

const paint = (ctx) => {
  ctx.fillStyle = '#ff0000'; ctx.fillRect(40, 40, 120, 80);
  ctx.fillStyle = '#00ff00'; ctx.fillRect(300, 200, 100, 60);
};
const RED = (img) => px(img, 100, 80);
const isRed = (c) => c[0] > 240 && c[1] < 20 && c[2] < 20;

/** A one-pass plugin that outputs 1 - rgb of its input. */
const invertPlugin = (log = []) => definePlugin({
  type: 'invert', apiVersion: 2, version: 1, outputCapabilities: { directCanvasRenderAttachment: true },
  create(ctx) {
    log.push({ device: ctx.device });
    const { device, format } = ctx;
    const module = device.createShaderModule({ code: `
      @group(0) @binding(1) var tx : texture_2d<f32>;
      @vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4<f32> { var p = array<vec2<f32>,3>(vec2(-1.,-1.), vec2(3.,-1.), vec2(-1.,3.)); return vec4(p[i], 0., 1.); }
      @fragment fn fs(@builtin(position) pos : vec4<f32>) -> @location(0) vec4<f32> {
        let c = textureLoad(tx, vec2<i32>(pos.xy), 0); return vec4(1.0 - c.rgb, 1.0); }` });
    const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format }] } });
    return {
      render(frame) {
        const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 1, resource: frame.sourceView }] });
        const pass = frame.encoder.beginRenderPass({ colorAttachments: [{ view: frame.destinationView, loadOp: 'clear', storeOp: 'store' }] });
        pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.draw(3); pass.end();
      },
    };
  },
});

async function startHost(t, rigOpts = {}, hostOpts = {}) {
  const rig = makeRig({ paint, ...rigOpts });
  rig.commit();
  const host = await createEffectHost(rig.env, rig.deps, rig.canvas, rig.source, { interposer: false, ...hostOpts });
  t.cleanup(() => {
    host.destroy();
    const gpuErrors = rig.reports.filter((r) => r.where === 'effects:gpu-error');
    if (gpuErrors.length) throw new Error(`uncaptured GPU errors: ${gpuErrors.map((r) => r.error?.message).join(' | ')}`);
  });
  return { rig, host };
}

gtest('createHost: a canvas that already has a 2D context rejects with InvalidStateError', async () => {
  const rig = makeRig({ paint });
  rig.canvas.getContext('2d');
  rig.commit();
  const api = createEffects(rig.env, rig.deps);
  try { await api.createHost(rig.canvas, rig.source); } catch (e) { assert.equal(e.name, 'InvalidStateError'); assert.ok(/canvas-context-conflict/.test(e.message)); return; }
  assert.fail('expected a rejection');
});

gtest('createHost: a source that is not an eligible drawable rejects with InvalidStateError; bad arguments are TypeErrors', async () => {
  const rig = makeRig({ paint });
  const api = createEffects(rig.env, rig.deps);
  const stranger = document.createElement('div');
  try { await api.createHost(rig.canvas, stranger); assert.fail('resolved'); } catch (e) { assert.equal(e.name, 'InvalidStateError'); }
  await assert.rejects(api.createHost({}, rig.source), TypeError);
  await assert.rejects(api.createHost(rig.canvas, {}), TypeError);
  await assert.rejects(api.createHost(rig.canvas, rig.source, 5), TypeError);
});

test('createHost without WebGPU rejects with HicUnsupportedError("effect-plugins") and reports it (works without a GPU)', async (t) => {
  const rig = makeRig({ paint });
  rig.commit();
  Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
  t.cleanup(() => { delete navigator.gpu; });
  try { await createEffectHost(rig.env, rig.deps, rig.canvas, rig.source, {}); assert.fail('resolved'); } catch (e) {
    assert.equal(e.name, 'NotSupportedError');
    assert.equal(e.feature, 'effect-plugins');
  }
  assert.ok(rig.reports.some((r) => r.unsupported?.feature === 'effect-plugins'), 'reported through the reporter');
  assert.equal(rig.hookCount(), 0, 'a failed start leaves no frame hook behind');
});

test('a scheduler tick while the GPU is still opening does not touch the missing presenter (works without a GPU)', async (t) => {
  // the frame hook is registered by the constructor, the presenter only exists after the async adapter/device request: a tick in between threw
  // "Cannot read properties of null (reading 'syncSize')" into effects:frame (seen in most runs of examples/water-form)
  const rig = makeRig({ paint });
  rig.commit();
  let release = () => {};
  Object.defineProperty(navigator, 'gpu', { value: { requestAdapter: () => new Promise((resolve) => { release = () => resolve(null); }) }, configurable: true });
  t.cleanup(() => { delete navigator.gpu; });
  const pending = createEffectHost(rig.env, rig.deps, rig.canvas, rig.source, {}).then(() => null, (e) => e);
  await sleep(20);
  assert.equal(rig.hookCount(), 1, 'the hook is registered while the presenter is still opening');
  assert.equal(rig.tick(), false, 'nothing to render yet');
  assert.equal(rig.reports.filter((r) => r.where === 'effects:frame').length, 0, `no effects:frame error: ${rig.reports.map((r) => r.error?.message).join(' | ')}`);
  release();
  const e = await pending;
  assert.equal(e?.feature, 'effect-plugins', 'the start still rejects as unsupported when the adapter is missing');
});

gtest('a plugin-less host shows the source (passthrough) and paints the dark water colour where the source is transparent', async (t) => {
  const { rig, host } = await startHost(t);
  rig.tick();
  const img = rig.snap();
  assert.ok(isRed(RED(img)), `red inside the red rect, got ${RED(img)}`);
  const bg = px(img, 5, 5);
  assert.ok(bg[2] > bg[0] && bg[3] === 255 && bg[0] < 12, `dark blue background, got ${bg}`);
  assert.ok(nonDominantShare(img) > 0.05);
  assert.equal(host.stats().frames, 1);
});

gtest('uploads only when the source version advanced; an idle frame is not rendered', async (t) => {
  const { rig, host } = await startHost(t);
  assert.equal(rig.tick(), false);
  assert.equal(host.stats().uploads, 1);
  assert.equal(rig.tick(), false, 'nothing changed: nothing to do, the loop may sleep');
  assert.equal(host.stats().frames, 1);
  assert.equal(host.stats().uploads, 1);
  rig.commit({ x: 0, y: 0, width: 50, height: 50 }, (ctx) => { ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 0, 40, 40); });
  rig.tick();
  assert.equal(host.stats().uploads, 2);
  assert.equal(host.stats().frames, 2);
  assert.equal(host.stats().sourceVersion, 2);
  const img = rig.snap();
  assert.deepEqual(px(img, 20, 20).slice(0, 3), [0, 0, 255]);
  assert.ok(isRed(RED(img)), 'the part of the surface outside the dirty rect survived the partial upload');
});

gtest('a partial upload copies only the dirty rect (spy on the real queue)', async (t) => {
  const { rig } = await startHost(t);
  rig.tick();
  const sizes = [];
  const orig = GPUQueue.prototype.copyExternalImageToTexture;
  GPUQueue.prototype.copyExternalImageToTexture = function (src, dst, size) { sizes.push([size[0] ?? size.width, size[1] ?? size.height]); return orig.call(this, src, dst, size); };
  t.cleanup(() => { GPUQueue.prototype.copyExternalImageToTexture = orig; });
  rig.commit({ x: 200, y: 100, width: 30, height: 20 }, (ctx) => { ctx.fillStyle = '#ffffff'; ctx.fillRect(200, 100, 30, 20); });
  rig.tick();
  assert.equal(sizes.length, 1);
  assert.ok(sizes[0][0] <= 34 && sizes[0][1] <= 24, `copied ${sizes[0]}`);
  rig.commit(null);
  rig.tick();
  assert.deepEqual(sizes[1], [480, 320], 'no dirty rect: full copy');
});

gtest('frame cap: a frame that is not due is not rendered and the host asks to be called again', async (t) => {
  const { rig, host } = await startHost(t);
  rig.tick();
  rig.commit();
  assert.equal(rig.tick(performance.now(), false, 30), true, 'pending work, not due: keep the tick running');
  assert.equal(host.stats().frames, 1);
  assert.equal(rig.tick(performance.now(), true, 30), false);
  assert.equal(host.stats().frames, 2);
});

gtest('a continuous plugin keeps the hook alive every due frame, and the frame event reports the cap', async (t) => {
  const { rig, host } = await startHost(t);
  const handle = await host.addPlugin(WaterEffectPlugin, { intensity: 0.3 });
  const events = [];
  rig.canvas.addEventListener(EVENTS.EFFECT_FRAME, (e) => events.push(e.detail));
  for (let i = 0; i < 5; i += 1) assert.equal(rig.tick(performance.now(), true, 60), true);
  assert.equal(events.length, 5);
  assert.equal(events[4].frameCap, 60);
  assert.equal(events[4].frameIndex, 4);
  assert.equal(events[4].sourceVersion, 1);
  handle.setEnabled(false);
  rig.tick();
  assert.equal(rig.tick(), false, 'no continuous plugin left: the loop may sleep');
});

gtest('plugin chain: one inverts the source, two invert back (ping-pong textures)', async (t) => {
  const { rig, host } = await startHost(t);
  const one = await host.addPlugin(invertPlugin());
  rig.tick();
  let img = rig.snap();
  assert.deepEqual(RED(img).slice(0, 3), [0, 255, 255], 'inverted red');
  await host.addPlugin(invertPlugin());
  rig.tick();
  img = rig.snap();
  assert.ok(isRed(RED(img)), `inverted twice is the source again, got ${RED(img)}`);
  one.remove();
  assert.equal(host.pluginCount, 1);
  rig.tick();
  img = rig.snap();
  assert.deepEqual(RED(img).slice(0, 3), [0, 255, 255]);
});

gtest('a plugin that throws in render: effecterror, report entry, NOTHING is submitted (the canvas keeps its last frame), the plugin is dropped, later frames still render', async (t) => {
  const { rig, host } = await startHost(t);
  rig.tick();
  let n = 0;
  const events = [];
  rig.canvas.addEventListener(EVENTS.EFFECT_ERROR, (e) => events.push(e.detail));
  const bad = definePlugin({ type: 'bad', apiVersion: 2, version: 1, create: () => ({ render() { n += 1; throw new Error('shader exploded'); } }) });
  const handle = await host.addPlugin(bad);
  let submits = 0;
  const orig = GPUQueue.prototype.submit;
  GPUQueue.prototype.submit = function (...a) { submits += 1; return orig.apply(this, a); };
  t.cleanup(() => { GPUQueue.prototype.submit = orig; });
  rig.tick();
  assert.equal(n, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'bad');
  assert.equal(events[0].phase, 'render');
  assert.ok(/exploded/.test(events[0].error.message));
  assert.equal(rig.reports.filter((r) => r.where === 'effects:bad:render').length, 1);
  assert.equal(handle.enabled, false);
  assert.equal(submits, 0, 'the failed frame was not submitted: the previously presented frame stays on screen');
  rig.commit();
  rig.tick();
  assert.equal(n, 1, 'dropped plugin is not called again');
  assert.equal(submits, 1);
  assert.ok(isRed(RED(rig.snap())));
});

gtest('a plugin that throws AFTER taking the canvas texture does not blank the canvas (the frame is drawn again without it)', async (t) => {
  const { rig, host } = await startHost(t);
  const late = definePlugin({
    type: 'late', apiVersion: 2, version: 1, outputCapabilities: { directCanvasRenderAttachment: true },
    create: () => ({ render(frame) { const p = frame.encoder.beginRenderPass({ colorAttachments: [{ view: frame.destinationView, loadOp: 'clear', storeOp: 'store' }] }); p.end(); throw new Error('late failure'); } }),
  });
  await host.addPlugin(late);
  rig.tick();
  const img = rig.snap();
  assert.ok(isRed(RED(img)), `source visible, got ${RED(img)}`);
  assert.equal(host.stats().pluginErrors, 1);
});

gtest('a spatial plugin without captureInputMapper is rejected by addPlugin and leaves the host usable', async (t) => {
  const { rig, host } = await startHost(t);
  const bad = definePlugin({ type: 'sp', apiVersion: 2, version: 1, create: () => ({ render() {}, spatial: true }) });
  await assert.rejects(host.addPlugin(bad), /captureInputMapper/);
  assert.equal(host.pluginCount, 0);
  rig.tick();
  assert.ok(isRed(RED(rig.snap())));
});

gtest('a v1 plugin definition runs through the adapter and sees sourceSnapshotSerial', async (t) => {
  const { rig, host } = await startHost(t);
  const seen = [];
  const v1 = definePlugin({
    type: 'v1', apiVersion: 1, version: 1,
    create: (ctx) => { seen.push(['ctx', ctx.apiVersion]); return { render(frame) { seen.push(['frame', frame.sourceSnapshotSerial, frame.sourceVersion]); } }; },
  });
  await host.addPlugin(v1);
  rig.tick();
  assert.deepEqual(seen, [['ctx', 1], ['frame', 1, 1]]);
});

gtest('resize: the backing store follows the content box, plugins get resize(), the source geometry gets a fill transform', async (t) => {
  const { rig, host } = await startHost(t);
  const sizes = [];
  await host.addPlugin(definePlugin({ type: 'sz', apiVersion: 2, version: 1, create: () => ({ render() {}, resize: (vp) => sizes.push([vp.width, vp.height]) }) }));
  rig.tick();
  assert.deepEqual(sizes.at(-1), [480, 320]);
  rig.record.contentBox = { width: 240, height: 160, gridScaleX: 1, gridScaleY: 1 };
  rig.canvas.style.width = '240px'; rig.canvas.style.height = '160px';
  rig.bus.emit(BUS.RESIZE, { record: rig.record });
  rig.tick();
  assert.deepEqual([rig.canvas.width, rig.canvas.height], [240, 160]);
  assert.deepEqual(sizes.at(-1), [240, 160]);
  const updates = rig.geometry.calls.filter((c) => c[0] === 'update');
  assert.ok(updates.length >= 2, 'the identity fill is applied too (the source must be in the drawn list to be hit-testable), then the new fill');
  assert.ok(Math.abs(updates[0][1].canvasTransform.a - 1) < 1e-6, 'identity fill first');
  const update = updates.at(-1);
  assert.ok(Math.abs(update[1].canvasTransform.a - 0.5) < 1e-6 && Math.abs(update[1].canvasTransform.d - 0.5) < 1e-6);
});

/** N-02: console.warn once per host when the drawn source and the canvas differ by more than 1 css px; silent when they match */
async function sizeWarnings(t, canvasCss) {
  const warns = [];
  const original = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); };
  t.cleanup(() => { console.warn = original; });
  const { rig } = await startHost(t);
  if (canvasCss) {
    rig.record.contentBox = { width: canvasCss[0], height: canvasCss[1], gridScaleX: 1, gridScaleY: 1 };
    rig.canvas.style.width = `${canvasCss[0]}px`; rig.canvas.style.height = `${canvasCss[1]}px`;
  }
  rig.tick(); rig.tick(); rig.bus.emit(BUS.RESIZE, { record: rig.record }); rig.tick();
  return warns;
}

gtest('N-02: a source of another size than the canvas warns once per host, with both sizes', async (t) => {
  const warns = await sizeWarnings(t, [240, 160]);
  assert.equal(warns.length, 1, `one warning: ${warns.join(' | ')}`);
  assert.ok(/source is 480x320 CSS px but the canvas is 240x160/.test(warns[0]) && /EFFECTS-PLUGINS/.test(warns[0]));
});

gtest('N-02: no warning when the source has the canvas size (also within 1 px)', async (t) => {
  assert.deepEqual(await sizeWarnings(t, null), []);
  assert.deepEqual(await sizeWarnings(t, [480.8, 319.4]), []);
});

gtest('DPR is capped by maxDpr', async (t) => {
  const { rig } = await startHost(t, {}, { maxDpr: 1.5 });
  const dpr = devicePixelRatio;
  rig.tick();
  assert.equal(rig.canvas.width, Math.round(480 * Math.min(dpr, 1.5)));
});

gtest('destroy: unregisters the hook, clears the geometry, stops plugins; the canvas keeps a webgpu context', async (t) => {
  const { rig, host } = await startHost(t);
  let destroyed = 0;
  await host.addPlugin(definePlugin({ type: 'd', apiVersion: 2, version: 1, create: () => ({ render() {}, destroy: () => { destroyed += 1; } }) }));
  assert.equal(rig.hookCount(), 1);
  host.destroy();
  host.destroy();
  assert.equal(rig.hookCount(), 0);
  assert.equal(destroyed, 1);
  assert.equal(rig.canvas.getContext('2d'), null, 'a webgpu canvas cannot become 2d again (documented)');
  await assert.rejects(host.addPlugin(invertPlugin()), /destroyed/);
});

gtest('device loss: one report entry, the plugin is created again on the new device, the canvas is non-blank within 3 frames', async (t) => {
  const log = [];
  const { rig, host } = await startHost(t);
  await host.addPlugin(invertPlugin(log));
  rig.tick();
  assert.deepEqual(RED(rig.snap()).slice(0, 3), [0, 255, 255]);
  log[0].device.destroy();
  let recovered = false;
  let ticksAfter = 0;
  for (let i = 0; i < 200 && !recovered; i += 1) {
    await sleep(10);
    recovered = log.length === 2;
  }
  assert.ok(recovered, 'plugin.create ran again');
  assert.notEqual(log[1].device, log[0].device, 'on a new device');
  for (; ticksAfter < 3; ticksAfter += 1) {
    rig.tick();
    const img = rig.snap();
    if (nonDominantShare(img) > 0.05 && RED(img)[1] > 200) break;
  }
  assert.ok(ticksAfter < 3, `non-blank inverted frame within 3 frames after recovery, took ${ticksAfter}`);
  assert.equal(rig.reports.filter((r) => r.where === 'effects:device-lost').length, 1);
  assert.equal(host.stats().deviceLosses, 1);
});

gtest('repeated device loss: the host gives up after 3 losses in the window and keeps the last frame', async (t) => {
  const log = [];
  const { rig, host } = await startHost(t);
  await host.addPlugin(invertPlugin(log));
  rig.tick();
  const errors = [];
  rig.canvas.addEventListener(EVENTS.EFFECT_ERROR, (e) => errors.push(e.detail));
  for (let loss = 1; loss <= 4; loss += 1) {
    const dev = log.at(-1).device;
    dev.destroy();
    for (let i = 0; i < 100 && (loss < 4 ? log.length < loss + 1 : errors.length === 0); i += 1) await sleep(10);
  }
  assert.ok(errors.some((e) => e.phase === 'recover'), 'effecterror(host/recover) after the fourth loss');
  assert.equal(host.stats().deviceLosses, 4);
});

gtest('water through the host: non-blank, source visible, typing (a new source version) reaches the pixels', async (t) => {
  const { rig, host } = await startHost(t);
  await host.addPlugin(WaterEffectPlugin, { intensity: 0.5 });
  rig.tick();
  let img = rig.snap();
  assert.ok(nonDominantShare(img) > 0.1);
  const red1 = img.data.slice();
  rig.commit(null, (ctx) => { ctx.fillStyle = '#ff0000'; ctx.fillRect(40, 40, 120, 80); ctx.fillStyle = '#ffffff'; ctx.fillRect(300, 40, 100, 60); });
  rig.tick();
  img = rig.snap();
  let changed = 0;
  for (let i = 0; i < red1.length; i += 4) if (Math.abs(red1[i] - img.data[i]) + Math.abs(red1[i + 1] - img.data[i + 1]) > 60) changed += 1;
  assert.ok(changed > 3000, `the new white rect (6000 px) is visible, ${changed} px changed`);
});

gtest('installEffectsGlobal defines a frozen api once and removes only its own', async (t) => {
  const rig = makeRig({ paint });
  const api = createEffects(rig.env, rig.deps);
  const win = {};
  const off = installEffectsGlobal(win, api);
  assert.equal(win.HTMLInCanvasEffects, api);
  assert.ok(Object.isFrozen(api));
  assert.equal(api.version, 2);
  const other = createEffects(rig.env, rig.deps);
  const off2 = installEffectsGlobal(win, other);
  assert.equal(win.HTMLInCanvasEffects, api, 'an existing global is not replaced');
  off2();
  assert.equal(win.HTMLInCanvasEffects, api);
  off();
  assert.equal('HTMLInCanvasEffects' in win, false);
});

gtest('api.dispose destroys every host it created', async (t) => {
  const rig = makeRig({ paint });
  rig.commit();
  const api = createEffects(rig.env, rig.deps);
  const host = await api.createHost(rig.canvas, rig.source, { interposer: false });
  assert.equal(rig.hookCount(), 1);
  api.dispose();
  assert.equal(rig.hookCount(), 0);
  host.destroy();
});

gtest('createPresenter alone: sizes the canvas, passthrough chain, reports the lost device through the hook', async (t) => {
  const rig = makeRig({ paint });
  rig.commit();
  const lost = [];
  const p = await createPresenter(rig.canvas, { maxDpr: 1 }, { cssSize: () => ({ width: 200, height: 100 }), devicePixelRatio: () => 1, onLost: (i) => lost.push(i) });
  t.cleanup(() => p.dispose());
  assert.equal(p.syncSize(), false, 'createPresenter already synced the size');
  assert.deepEqual([rig.canvas.width, rig.canvas.height], [200, 100]);
  assert.equal(p.uploadSource({ size: () => ({ width: 480, height: 320, cssWidth: 480, cssHeight: 320 }), upload: (device, tex) => { device.queue.copyExternalImageToTexture({ source: rig.surface }, { texture: tex }, [480, 320]); return 7; } }), 7);
  assert.equal(p.sourceReady(), true);
  p.device.destroy();
  await sleep(50);
  assert.equal(lost.length, 1);
  assert.equal(lost[0].reason, 'destroyed');
});

test('createLateEffects binds to the installed core late: no install rejects, a seam is used once and its cleanup destroys the hosts', async () => {
  const rig = makeRig({ paint });
  const win = /** @type {any} */ ({});
  const api = createLateEffects(win);
  assert.equal(api.version, 2);
  assert.equal(typeof api.definePlugin, 'function');
  await assert.rejects(api.createHost(rig.canvas, rig.source), /needs the installed polyfill/);
  const seam = { env: rig.env, deps: rig.deps, effects: null, cleanups: new Set() };
  win[EXT.INSTALLED_KEY] = { [EXT.EFFECTS_SEAM_KEY]: seam };
  await assert.rejects(api.createHost(/** @type {any} */ ({}), rig.source), TypeError);
  const first = seam.effects;
  assert.ok(first, 'the per-install API is created on first use');
  await assert.rejects(api.createHost(/** @type {any} */ ({}), rig.source), TypeError);
  assert.equal(seam.effects, first, 'and kept');
  assert.equal(seam.cleanups.size, 1);
  api.dispose();
  win[EXT.INSTALLED_KEY] = undefined;
  await assert.rejects(api.createHost(rig.canvas, rig.source), /needs the installed polyfill/);
});
