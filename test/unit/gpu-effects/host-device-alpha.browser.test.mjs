// EffectHostOptions.device (a GPUDevice the page owns, or a function that returns the current one) and EffectHostOptions.alphaMode ('premultiplied': the
// canvas is not an opaque rectangle). Asked for by a library built on the polyfill: several hosts sharing one device, and dialogs or popovers drawn through an
// effect, whose transparent corners must show the page. Skipped LOUDLY without WebGPU.
import { test, assert, sleep } from '/test/unit/lib/t.js';
import { gpuAvailable, makeRig, px } from './lib/rig.mjs';
import { createEffectHost } from '/src/effects/effect-host.js';
import { createEffects } from '/src/effects/index.js';
import { definePlugin } from '/src/effects/plugin-abi.js';
import { EVENTS } from '/src/contracts/events.js';

const GPU = await gpuAvailable();
const gtest = (name, fn, opts) => (GPU ? test(name, fn, opts) : test.skip(`SKIPPED: no WebGPU - ${name}`, fn));

/** an opaque red rect, a half-transparent rect of a colour whose wrong premultiplication shows, and nothing elsewhere */
const paint = (ctx) => {
  ctx.fillStyle = '#ff0000'; ctx.fillRect(40, 40, 120, 80);
  ctx.fillStyle = 'rgba(100, 200, 50, 0.5)'; ctx.fillRect(300, 200, 100, 60);
};

/** A pass that copies its input (textureLoad), recording the context it was created with. */
const copyPlugin = (log = []) => definePlugin({
  type: 'copy', apiVersion: 2, version: 1, outputCapabilities: { directCanvasRenderAttachment: true },
  create(ctx) {
    log.push(ctx);
    const { device, format } = ctx;
    const module = device.createShaderModule({ code: `
      @group(0) @binding(1) var tx : texture_2d<f32>;
      @vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4<f32> { var p = array<vec2<f32>,3>(vec2(-1.,-1.), vec2(3.,-1.), vec2(-1.,3.)); return vec4(p[i], 0., 1.); }
      @fragment fn fs(@builtin(position) pos : vec4<f32>) -> @location(0) vec4<f32> { return textureLoad(tx, vec2<i32>(pos.xy), 0); }` });
    const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format }] } });
    return {
      render(frame) {
        const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 1, resource: frame.sourceView }] });
        const pass = frame.encoder.beginRenderPass({ colorAttachments: [{ view: frame.destinationView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
        pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.draw(3); pass.end();
      },
    };
  },
});

async function newDevice() { return (await navigator.gpu.requestAdapter()).requestDevice(); }

async function startHost(t, hostOpts = {}) {
  const rig = makeRig({ paint });
  rig.commit();
  const host = await createEffectHost(rig.env, rig.deps, rig.canvas, rig.source, { interposer: false, ...hostOpts });
  t.cleanup(() => host.destroy());
  return { rig, host };
}

/** resolves true when `device` is lost within `ms` */
const lostWithin = (device, ms) => Promise.race([device.lost.then(() => true), sleep(ms).then(() => false)]);
const near = (a, b, tol = 3) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

gtest("alphaMode 'premultiplied': what the source leaves transparent is transparent, a half-transparent colour keeps its colour; the default is opaque", async (t) => {
  for (const plugin of [null, copyPlugin()]) {
    const { rig, host } = await startHost(t, { alphaMode: 'premultiplied' });
    if (plugin) await host.addPlugin(plugin);
    rig.tick();
    const img = rig.snap();
    assert.equal(rig.canvas.getContext('webgpu').getConfiguration?.()?.alphaMode ?? 'premultiplied', 'premultiplied');
    assert.equal(px(img, 5, 5)[3], 0, `transparent where the source is (${plugin ? 'a plugin' : 'passthrough'}): ${px(img, 5, 5)}`);
    assert.ok(near(px(img, 100, 80), [255, 0, 0, 255]), `opaque red: ${px(img, 100, 80)}`);
    assert.ok(near(px(img, 350, 230), [100, 200, 50, 128]), `half-transparent, the same colour (premultiplied once): ${px(img, 350, 230)}`);
    host.destroy();
  }
  const { rig } = await startHost(t);
  rig.tick();
  assert.equal(px(rig.snap(), 5, 5)[3], 255, 'opaque by default');
});

gtest('the plugin context says the alpha mode', async (t) => {
  const log = [];
  const { host } = await startHost(t, { alphaMode: 'premultiplied' });
  await host.addPlugin(copyPlugin(log));
  const { host: plain } = await startHost(t);
  await plain.addPlugin(copyPlugin(log));
  assert.deepEqual(log.map((c) => c.alphaMode), ['premultiplied', 'opaque']);
});

gtest('options.device: two hosts share the page\'s GPUDevice (the plugins get it, the adapter is null); destroy() leaves it alive and usable', async (t) => {
  const device = await newDevice();
  t.cleanup(() => device.destroy());
  const log = [];
  const a = await startHost(t, { device });
  const b = await startHost(t, { device });
  await a.host.addPlugin(copyPlugin(log));
  await b.host.addPlugin(copyPlugin(log));
  a.rig.tick(); b.rig.tick();
  assert.ok(log.every((c) => c.device === device && c.adapter === null), 'both plugins on the given device');
  assert.equal(px(a.rig.snap(), 100, 80)[0], 255);
  a.host.destroy(); b.host.destroy();
  assert.equal(await lostWithin(device, 100), false, 'not destroyed by the hosts');
  device.pushErrorScope('validation');
  device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST });
  assert.equal(await device.popErrorScope(), null, 'still usable');
});

gtest('options.device as a GPUDevice that is lost: effecterror (recover) names it, the host keeps its last frame and asks for nothing', async (t) => {
  const device = await newDevice();
  const { rig, host } = await startHost(t, { device });
  await host.addPlugin(copyPlugin());
  rig.tick();
  const errors = [];
  rig.canvas.addEventListener(EVENTS.EFFECT_ERROR, (e) => errors.push(/** @type {any} */ (e).detail));
  device.destroy();
  for (let i = 0; i < 100 && errors.length === 0; i += 1) await sleep(10);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].phase, 'recover');
  assert.ok(/options\.device was lost/.test(String(errors[0].error?.message)), String(errors[0].error?.message));
  assert.equal(host.stats().deviceLosses, 1);
});

gtest('options.device as a function: called at creation and again after a loss; the plugin is created again on the new device and the host draws', async (t) => {
  const devices = [];
  const provider = async () => { const d = await newDevice(); devices.push(d); return d; };
  t.cleanup(() => { for (const d of devices) d.destroy(); });
  const log = [];
  const { rig, host } = await startHost(t, { device: provider });
  await host.addPlugin(copyPlugin(log));
  rig.tick();
  assert.equal(devices.length, 1);
  devices[0].destroy();
  for (let i = 0; i < 200 && log.length < 2; i += 1) await sleep(10);
  assert.equal(devices.length, 2, 'asked again');
  assert.equal(log[1].device, devices[1], 'the plugin on the new device');
  rig.tick();
  assert.equal(px(rig.snap(), 100, 80)[0], 255, 'draws again');
  assert.equal(host.stats().deviceLosses, 1);
});

gtest('options.device as a function that returns the lost device again: effecterror (recover), nothing drawn on a dead device', async (t) => {
  const device = await newDevice();
  const { rig, host } = await startHost(t, { device: () => device });
  rig.tick();
  const errors = [];
  rig.canvas.addEventListener(EVENTS.EFFECT_ERROR, (e) => errors.push(/** @type {any} */ (e).detail));
  device.destroy();
  for (let i = 0; i < 100 && errors.length === 0; i += 1) await sleep(10);
  assert.equal(errors[0]?.phase, 'recover');
  assert.ok(/returned the GPUDevice that was lost/.test(String(errors[0]?.error?.message)), String(errors[0]?.error?.message));
  void host;
});

gtest('bad options.device and options.alphaMode are TypeErrors; a function that returns no device rejects with a TypeError', async () => {
  const rig = makeRig({ paint });
  rig.commit();
  const api = createEffects(rig.env, rig.deps);
  for (const device of [null, 42, {}, { createTexture: 1 }]) await assert.rejects(api.createHost(rig.canvas, rig.source, { device }), TypeError);
  for (const alphaMode of ['straight', '', null]) await assert.rejects(api.createHost(rig.canvas, rig.source, { alphaMode }), TypeError);
  await assert.rejects(api.createHost(rig.canvas, rig.source, { device: () => ({}) }), TypeError);
});
