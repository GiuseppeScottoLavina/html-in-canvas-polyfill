// GPU time of the disintegrate pass per frame, measured with timestamp queries on the plugin's own pass (frame.profiling.timestampWrites,
// the hook the water plugin also honours), at the gallery canvas size at DPR 2 (1100x620 css = 2200x1240 backing px), frames 8.33 ms apart
// (120 Hz) through a whole play (out, then in), plus the wall time of the frame that also makes the background estimate (two small passes,
// once while the page does not change). It asserts the p95 of the moving frames stays under half of the 120 Hz budget (8.33 ms per frame for
// everything the GPU does). Chrome quantises timestamps (100 us without developer features), so small passes read coarse.
import { assert } from '/test/unit/lib/t.js';
import { gpuTest } from '/plugins/_shared/gpu-check.mjs';
import { plugin, trigger } from '/plugins/disintegrate/index.js';

const CSS = { w: 1100, h: 620 }, DPR = 2, W = CSS.w * DPR, H = CSS.h * DPR;

/** @param {number[]} xs @param {number} q */
const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

gpuTest('GPU time per frame at 2200x1240, 120 Hz steps through a whole play', async () => {
  const adapter = /** @type {any} */ (await navigator.gpu.requestAdapter());
  const timestamps = adapter.features.has('timestamp-query');
  const device = await adapter.requestDevice({ requiredFeatures: timestamps ? ['timestamp-query'] : [] });
  const format = navigator.gpu.getPreferredCanvasFormat();
  const U = /** @type {any} */ (globalThis).GPUTextureUsage;
  const src = device.createTexture({ size: [W, H], format: 'rgba8unorm', usage: U.TEXTURE_BINDING | U.COPY_DST | U.RENDER_ATTACHMENT });
  const paint = new OffscreenCanvas(W, H);
  const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (paint.getContext('2d'));
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#16324f'); grad.addColorStop(1, '#3b1d5a');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#e8f6ff'; ctx.font = 'bold 80px sans-serif';
  for (let y = 120; y < H; y += 160) ctx.fillText('Touch the interface. Every field is HTML.', 60, y);
  device.queue.copyExternalImageToTexture({ source: paint }, { texture: src }, [W, H]);
  const dst = device.createTexture({ size: [W, H], format, usage: U.RENDER_ATTACHMENT });
  const canvas = document.createElement('canvas');
  const context = /** @type {any} */ ({ apiVersion: 2, adapter, device, format, canvas, source: document.createElement('div'), requestRender() {}, listen: () => () => {}, viewport: () => ({ width: W, height: H, cssWidth: CSS.w, cssHeight: CSS.h, dpr: DPR }) });
  const inst = await plugin.create(context, { duration: 1000, durationIn: 1000, intro: false });
  const FRAMES = 320;
  const querySet = timestamps ? device.createQuerySet({ type: 'timestamp', count: FRAMES * 2 }) : null;
  const B = /** @type {any} */ (globalThis).GPUBufferUsage;
  const resolve = timestamps ? device.createBuffer({ size: FRAMES * 16, usage: B.QUERY_RESOLVE | B.COPY_SRC }) : null;
  const read = timestamps ? device.createBuffer({ size: FRAMES * 16, usage: B.MAP_READ | B.COPY_DST }) : null;
  const view = { s: src.createView(), d: dst.createView() };
  /** @type {string[]} */ const phase = [];
  /** @type {number[]} */ const cpu = [];
  /** @type {number[]} */ const wall = [];
  /** @type {number[]} */ const birthWall = [];
  const t0 = performance.now();
  let index = 0;
  for (let i = 0; i < FRAMES; i += 1) {
    if (i === 20) trigger(canvas, 'play');
    const real = device.createCommandEncoder();
    let births = 0;   // frames that also make the background estimate (two small passes before the frame's own)
    const encoder = new Proxy(real, { get: (target, key) => (key === 'beginRenderPass' ? (/** @type {any} */ d) => { if (!d.timestampWrites && !('timestampWrites' in d)) births += 1; return target.beginRenderPass(d); } : typeof target[key] === 'function' ? target[key].bind(target) : target[key]) });
    const k = i;
    const frame = {
      now: t0 + i * 8.33, delta: 8.33, frameIndex: i, frameCap: 0, sourceVersion: 1, width: W, height: H, cssWidth: CSS.w, cssHeight: CSS.h, dpr: DPR,
      sourceReady: true, encoder, sourceTexture: src, sourceView: view.s, destinationTexture: dst, destinationView: view.d,
      profiling: querySet ? { timestampWrites: () => ({ querySet, beginningOfPassWriteIndex: 2 * k, endOfPassWriteIndex: 2 * k + 1 }) } : undefined,
    };
    const c0 = performance.now();
    inst.render(/** @type {any} */ (frame));
    cpu.push(performance.now() - c0);
    phase.push(inst.continuous ? 'moving' : 'idle');
    if (births) await device.queue.onSubmittedWorkDone();   // the frames before it are done: what follows is this frame's own work
    const w0 = performance.now();
    device.queue.submit([real.finish()]);
    if (!querySet || births) await device.queue.onSubmittedWorkDone();
    wall.push(performance.now() - w0);
    if (births) birthWall.push(performance.now() - w0);
    index += 1;
  }
  /** @type {number[]} */ let gpu = [];
  if (querySet && resolve && read) {
    const encoder = device.createCommandEncoder();
    encoder.resolveQuerySet(querySet, 0, index * 2, resolve, 0);
    encoder.copyBufferToBuffer(resolve, 0, read, 0, index * 16);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(/** @type {any} */ (globalThis).GPUMapMode.READ);
    const ns = new BigInt64Array(read.getMappedRange());
    gpu = Array.from({ length: index }, (_, i) => Number(ns[2 * i + 1] - ns[2 * i]) / 1e6);
    read.unmap();
  } else gpu = wall;
  const pick = (/** @type {string} */ p) => gpu.filter((_, i) => phase[i] === p && i > 2);
  const moving = pick('moving'), idle = pick('idle');
  const fmt = (/** @type {number[]} */ xs) => `p50 ${pct(xs, 0.5).toFixed(3)} p95 ${pct(xs, 0.95).toFixed(3)} max ${Math.max(...xs).toFixed(3)} ms (n=${xs.length})`;
  console.error(`disintegrate GPU ${timestamps ? 'timestamp-query' : 'onSubmittedWorkDone (upper bound)'} ${W}x${H}: moving ${fmt(moving)}; idle ${fmt(idle)}; CPU render() ${fmt(cpu)}; adapter ${adapter.info?.vendor ?? ''} ${adapter.info?.architecture ?? ''}`);
  console.error(`disintegrate frames that also make the background estimate (submit to done, wall clock): ${birthWall.map((x) => x.toFixed(2)).join(', ')} ms`);
  assert.ok(moving.length > 200 && moving.every(Number.isFinite), 'measured the moving frames');
  assert.equal(birthWall.length, 1, 'the background was estimated once: the page did not change during the play');
  assert.ok(pct(moving, 0.95) < 8.33 / 2, `p95 ${pct(moving, 0.95)} ms: more than half of a 120 Hz frame`);
  inst.destroy();
  device.destroy();
}, { timeout: 30000 });
