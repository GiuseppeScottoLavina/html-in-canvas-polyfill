// Off-screen pause of the effect host (ADR-G) on a real WebGPU device. Skipped LOUDLY (test names start with "SKIPPED: no WebGPU") when
// the machine has none. Visibility is driven either by the real IntersectionObserver (the canvas really moved out of the viewport) or by a
// scripted one (window.IntersectionObserver replaced for the test), so each step is deterministic.
import { test, assert, frames, sleep } from '/test/unit/lib/t.js';
import { gpuAvailable, makeRig, px } from './lib/rig.mjs';
import { createEffectHost } from '/src/effects/effect-host.js';
import { definePlugin } from '/src/effects/plugin-abi.js';
import { EVENTS } from '/src/contracts/events.js';

const GPU = await gpuAvailable();
console.error(`gpu-effects pause tests: WebGPU ${GPU ? 'available' : 'NOT available'}`);
const gtest = (name, fn, opts) => (GPU ? test(name, fn, opts) : test.skip(`SKIPPED: no WebGPU - ${name}`, fn));

const RED = '#ff0000';
const BLUE = '#0000ff';
const fill = (color) => (ctx, w, h) => { ctx.fillStyle = color; ctx.fillRect(0, 0, w, h); };

/** A one-pass plugin that copies its input; `continuous` as asked; records the frames it rendered; optional actions. */
function copyPlugin(log, { continuous = true, action = null } = {}) {
  return definePlugin({
    type: 'copy', apiVersion: 2, version: 1, outputCapabilities: { directCanvasRenderAttachment: true },
    ...(action ? { actions: ['run'] } : {}),
    create(ctx) {
      const { device, format } = ctx;
      const module = device.createShaderModule({ code: `
        @group(0) @binding(1) var tx : texture_2d<f32>;
        @vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4<f32> { var p = array<vec2<f32>,3>(vec2(-1.,-1.), vec2(3.,-1.), vec2(-1.,3.)); return vec4(p[i], 0., 1.); }
        @fragment fn fs(@builtin(position) pos : vec4<f32>) -> @location(0) vec4<f32> { return vec4(textureLoad(tx, vec2<i32>(pos.xy), 0).rgb, 1.0); }` });
      const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format }] } });
      // the action: runs `action.ms` on the frame clock from the first frame that renders it, then resolves 'done' (like the transition plugins)
      let run = null;
      const waiters = [];
      const instance = {
        continuous,
        render(frame) {
          log.push({ now: frame.now, delta: frame.delta, version: frame.sourceVersion });
          if (run) {
            if (Number.isNaN(run.t0)) run.t0 = frame.now;
            if (frame.now - run.t0 >= action.ms) { const r = run; run = null; r.resolve('done'); for (const w of waiters.splice(0)) w('done'); }
            else ctx.requestRender();
          }
          const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 1, resource: frame.sourceView }] });
          const pass = frame.encoder.beginRenderPass({ colorAttachments: [{ view: frame.destinationView, loadOp: 'clear', storeOp: 'store' }] });
          pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.draw(3); pass.end();
        },
      };
      if (action) {
        instance.runAction = () => new Promise((resolve) => { run?.resolve(null); run = { t0: NaN, resolve }; });
        instance.settled = () => (run ? new Promise((r) => waiters.push(r)) : 'idle');
      }
      return instance;
    },
  });
}

/** Replace window.IntersectionObserver by a scripted one for this test; `emit(visible)` delivers a report to every live observer. */
function scriptedObserver(t) {
  const real = window.IntersectionObserver;
  const live = [];
  class Scripted {
    constructor(cb, options) { this.cb = cb; this.options = options; this.disconnected = false; live.push(this); }
    observe(el) { this.el = el; }
    unobserve() {}
    disconnect() { this.disconnected = true; }
    takeRecords() { return []; }
  }
  window.IntersectionObserver = /** @type {any} */ (Scripted);
  t.cleanup(() => { window.IntersectionObserver = real; });
  return {
    live,
    // a report of the canvas far below the viewport, or where it is
    emit(visible) {
      for (const o of live) {
        if (o.disconnected) continue;
        const box = visible ? o.el.getBoundingClientRect() : new DOMRect(0, innerHeight * 10, 100, 100);
        o.cb([{ isIntersecting: visible, target: o.el, boundingClientRect: box }], o);
      }
    },
  };
}

async function startHost(t, paint = fill(RED)) {
  const rig = makeRig({ paint });
  rig.commit();
  const host = await createEffectHost(rig.env, rig.deps, rig.canvas, rig.source, { interposer: false });
  t.cleanup(() => {
    host.destroy();
    const gpuErrors = rig.reports.filter((r) => r.where === 'effects:gpu-error');
    if (gpuErrors.length) throw new Error(`uncaptured GPU errors: ${gpuErrors.map((r) => r.error?.message).join(' | ')}`);
  });
  return { rig, host };
}

/** Run the host's frame hook every animation frame for `ms`, as the scheduler does when it is woken; returns how many hook calls returned true. */
async function drive(rig, ms) {
  const end = performance.now() + ms;
  let keep = 0;
  while (performance.now() < end) {
    await frames(1);
    if (rig.tick(performance.now()) === true) keep += 1;
  }
  return keep;
}

gtest('paused: a continuous plugin renders nothing, a new source version is not uploaded; the resume renders at once an up-to-date frame on the running clock', async (t) => {
  const io = scriptedObserver(t);
  const { rig, host } = await startHost(t);
  const log = [];
  await host.addPlugin(copyPlugin(log));
  assert.equal(rig.tick(), true, 'continuous: the loop keeps running');
  assert.equal(host.stats().frames, 1);
  assert.equal(host.stats().paused, false);
  io.emit(false);
  assert.equal(host.stats().paused, true);
  assert.equal(host.stats().pauses, 1);
  for (let i = 0; i < 6; i += 1) assert.equal(rig.tick(), false, 'paused: the hook lets the loop sleep');
  rig.commit(null, fill(BLUE));
  assert.equal(rig.tick(), false, 'a new source version while paused: still nothing');
  assert.equal(host.stats().frames, 1, 'no frame while paused');
  assert.equal(host.stats().uploads, 1, 'no upload while paused');
  assert.equal(host.stats().offscreenFrames, 0);
  await sleep(120);
  const wakes = rig.scheduler.wakes;
  io.emit(true);
  assert.ok(rig.scheduler.wakes > wakes, 'the resume wakes the loop at once');
  const now = performance.now();
  assert.equal(rig.tick(now), true, 'the first frame after the resume renders, and the loop runs again');
  const img = rig.snap();
  assert.deepEqual(px(img, 100, 100).slice(0, 3), [0, 0, 255], 'the frame shows the source as it is now (blue), not the red of before the pause');
  assert.equal(host.stats().uploads, 2);
  const last = log.at(-1);
  assert.equal(last.now, now, 'frame.now is the time of the frame: the clock kept running during the pause');
  assert.ok(last.delta >= 120, `delta is the real gap since the last presented frame (${last.delta} ms)`);
  assert.equal(host.stats().paused, false);
});

gtest('the canvas really out of the viewport (real IntersectionObserver): no frames; positive control without IntersectionObserver: frames; partly visible: frames', async (t) => {
  const counts = {};
  for (const variant of ['observer', 'no observer (control)', 'partly visible']) {
    const real = window.IntersectionObserver;
    if (variant.startsWith('no observer')) window.IntersectionObserver = undefined;
    let rig, host;
    try {
      ({ rig, host } = await startHost(t));
      await host.addPlugin(copyPlugin([]));
    } finally { window.IntersectionObserver = real; }
    rig.root.style.position = 'absolute';
    rig.root.style.left = '0px';
    rig.root.style.top = variant === 'partly visible' ? `${innerHeight - 100}px` : `${innerHeight * 4}px`;
    await drive(rig, 150);   // the observer's first report
    const before = host.stats().frames;
    await drive(rig, 400);
    counts[variant] = { frames: host.stats().frames - before, paused: host.stats().paused };
    host.destroy();
  }
  assert.equal(counts.observer.frames, 0, `off-screen: no frame (${JSON.stringify(counts)})`);
  assert.equal(counts.observer.paused, true);
  assert.ok(counts['no observer (control)'].frames > 5, `control: without the observer the off-screen canvas renders (${JSON.stringify(counts)})`);
  assert.ok(counts['partly visible'].frames > 5 && !counts['partly visible'].paused, `partly visible: renders normally (${JSON.stringify(counts)})`);
});

gtest('a trigger while paused still settles: its promise resolves, at about 10 frames per second, and settled() too; then the loop sleeps again', async (t) => {
  const io = scriptedObserver(t);
  const { rig, host } = await startHost(t);
  const log = [];
  const handle = await host.addPlugin(copyPlugin(log, { continuous: true, action: { ms: 400 } }));
  rig.tick();
  io.emit(false);
  rig.tick();
  const t0 = performance.now();
  let result;
  const p = handle.trigger('run').then((s) => { result = s; return s; });
  const settled = handle.settled();
  while (result === undefined && performance.now() - t0 < 3000) await drive(rig, 50);
  const took = performance.now() - t0;
  assert.equal(result, 'done', 'the trigger resolved while the canvas could not be seen');
  assert.equal(await settled, 'done', 'settled() resolved too');
  assert.ok(took >= 400 && took < 1000, `it took the action's own duration on the frame clock (${Math.round(took)} ms)`);
  const off = host.stats().offscreenFrames;
  assert.ok(off >= 3 && off <= 12, `about 10 frames per second while paused, not 60-120 (${off} frames in ${Math.round(took)} ms)`);
  assert.equal(await p, 'done');
  const after = host.stats().frames;
  await drive(rig, 300);
  assert.equal(host.stats().frames, after, 'settled: nothing renders any more while paused');
});

gtest('settled() called while paused on an action that started while visible still resolves', async (t) => {
  const io = scriptedObserver(t);
  const { rig, host } = await startHost(t);
  const handle = await host.addPlugin(copyPlugin([], { continuous: false, action: { ms: 250 } }));
  rig.tick();
  const p = handle.trigger('run');
  rig.tick();   // the action starts on this frame
  io.emit(false);
  let state;
  handle.settled().then((s) => { state = s; });
  const t0 = performance.now();
  while (state === undefined && performance.now() - t0 < 2000) await drive(rig, 50);
  assert.equal(state, 'done');
  assert.equal(await p, 'done');
});

gtest('destroy while paused: the observer is disconnected and a pending settle frame never runs', async (t) => {
  const io = scriptedObserver(t);
  const { rig, host } = await startHost(t);
  const handle = await host.addPlugin(copyPlugin([], { action: { ms: 1000 } }));
  rig.tick();
  io.emit(false);
  const p = handle.trigger('run');
  host.destroy();
  assert.ok(io.live.every((o) => o.disconnected), 'disconnected');
  assert.equal(await p, null, 'the pending trigger resolves null on destroy (unchanged rule)');
  const errors = [];
  rig.canvas.addEventListener(EVENTS.EFFECT_FRAME, () => errors.push('frame after destroy'));
  await sleep(250);
  assert.equal(rig.tick(), undefined, 'the hook is gone');
  assert.deepEqual(errors, []);
});
