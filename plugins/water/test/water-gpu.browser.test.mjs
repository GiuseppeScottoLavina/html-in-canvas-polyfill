// The water input mapper against the pixels the GPU really produced (not against its own formula), through the shared plugin kit; the
// actions 'drop' and 'demo' through the effect handle; zero work at rest; the light (caustics and reflections) on a uniform page.
import { assert } from '/test/unit/lib/t.js';
import { agreement, changedPixels, checkMapperAgainstGpu, gpuAvailable, gpuTest, identity, markerScene, presentOnce, runActionOnGpu } from '/plugins/_shared/gpu-check.mjs';
import { CAUSTIC_DEPTH_PX } from '/plugins/water/sim.js';
import { G, GLOBALS_LENGTH, causticMesh, meta, plugin } from '/plugins/water/index.js';

console.error(`water-gpu tests: WebGPU ${(await gpuAvailable()) ? 'available' : 'NOT available'}`);

const scene = markerScene({ w: 480, h: 320 });

/** Strong drops at known places, by the plugin's own pointerdown listener. @param {any} rig */
function dropRipples(rig) {
  const r = rig.canvas.getBoundingClientRect();
  for (const [x, y] of [[150, 100], [330, 110], [210, 230], [380, 250]]) {
    rig.layerEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + x, clientY: r.top + y }));
  }
}

gpuTest('every presented pixel samples the source point the water mapper says (pixel-exact, 150k pixels), identity does not (positive control)', async (t) => {
  const v = await checkMapperAgainstGpu(t, plugin, { intensity: 1 }, { scene, before: dropRipples });
  console.error(`water mapper vs GPU: decided=${v.real.decided} wrong=${v.real.wrong} (${(v.real.share * 100).toFixed(4)}%) brightPx=${v.real.bright} | identity wrong=${v.identity.wrong} (${(v.identity.share * 100).toFixed(3)}%)`);
  assert.ok(v.ok, v.why);
  assert.ok(v.real.wrong * 40 < v.identity.wrong);
});

gpuTest('a mapper of another instant disagrees measurably: the oracle is sensitive to the simulated surface', async (t) => {
  const { img, mapper } = await presentOnce(t, plugin, { intensity: 1 }, { scene, before: dropRipples, offsetMs: 80 });
  const { mapper: later } = await presentOnce(t, plugin, { intensity: 1 }, { scene, before: dropRipples, offsetMs: 200 });
  const good = agreement(img, /** @type {any} */ (mapper), scene).wrong;
  const wrong = agreement(img, /** @type {any} */ (later), scene).wrong;
  assert.ok(wrong > 100 && wrong > good * 20, `another instant: ${wrong} wrong pixels vs ${good}`);
});

gpuTest('intensity 0: nothing is displaced and the mapper is the identity up to the border clamp', async (t) => {
  const { img, mapper } = await presentOnce(t, plugin, { intensity: 0 }, { scene, before: dropRipples });
  const real = agreement(img, /** @type {any} */ (mapper), scene);
  const flat = agreement(img, identity, scene);
  assert.ok(real.bright > 3000);
  assert.ok(real.wrong <= 5, `${real.wrong}`);
  assert.ok(flat.wrong <= 5, `intensity 0 really is the plain surface on the GPU (${flat.wrong})`);
});

gpuTest('a mapper stays valid for the frame it was captured for while later frames are presented', async (t) => {
  const { rig, img: first, mappers, at } = await presentOnce(t, plugin, { intensity: 1 }, { scene, before: dropRipples, offsetMs: 80 });
  const firstMapper = /** @type {any} */ (mappers.at(-1));
  const before = agreement(first, firstMapper, scene).wrong;
  // 50 and 100 ms after the first frame on the effect's clock (not after the readback above, whose duration varies with the JIT: 70 to 300 ms)
  for (let k = 1; k <= 2; k += 1) rig.tick(at + k * 50);
  assert.equal(agreement(first, firstMapper, scene).wrong, before, 'two newer presentations did not change what the first mapper describes');
  assert.ok(before <= 5);
  const newest = agreement(first, /** @type {any} */ (mappers.at(-1)), scene).wrong;
  assert.ok(newest > 100, 'while the newest mapper describes a different frame (positive control)');
});

gpuTest('zero work at rest: no frame without a change; drops render until the surface is flat again, then nothing, and the frame at rest is the still picture', async (t) => {
  const { rig, host, img: still } = await presentOnce(t, plugin, { intensity: 1 }, { scene });
  let now = performance.now() + 200;
  const tick = (/** @type {number} */ n) => { for (let i = 0; i < n; i += 1) { rig.tick(now); now += 1000 / 60; } };
  const f0 = host.stats().frames;
  tick(30);
  assert.equal(host.stats().frames, f0, 'at rest the host renders nothing (30 frame ticks)');
  dropRipples(rig);
  tick(30);
  const moving = host.stats().frames - f0;
  assert.ok(moving >= 29, `control: after the drops it renders every tick (${moving} of 30)`);
  for (let i = 0; i < 400; i += 1) {
    const before = host.stats().frames;
    tick(1);
    if (host.stats().frames === before) break;
  }
  const settledAt = host.stats().frames;
  tick(30);
  assert.equal(host.stats().frames, settledAt, `at rest again after ${settledAt - f0} frames: no frame in 30 ticks`);
  assert.ok((settledAt - f0) / 60 < 5, `four strong drops at intensity 1 settled within 5 s of the frame clock (${((settledAt - f0) / 60).toFixed(2)} s)`);
  const after = rig.snap();
  assert.ok(changedPixels(after, still) <= 2, `the frame at rest is the still picture again (${changedPixels(after, still)} px differ)`);
});

gpuTest('the light: on a uniform page drops make caustics and reflections (the brightness spreads); with light 0 they do not (positive control: the displacement alone shows nothing there)', async (t) => {
  const grey = { w: 480, h: 320, paint(/** @type {CanvasRenderingContext2D} */ ctx) { ctx.fillStyle = '#7f7f7f'; ctx.fillRect(0, 0, 480, 320); } };
  const spread = async (/** @type {number} */ light) => {
    const { img } = await presentOnce(t, plugin, { intensity: 1, light }, { scene: /** @type {any} */ (grey), before: dropRipples, offsetMs: 160 });
    let lo = 255, hi = 0;
    for (let i = 0; i < img.data.length; i += 4) { const g = img.data[i + 1]; lo = Math.min(lo, g); hi = Math.max(hi, g); }
    return { lo, hi };
  };
  const lit = await spread(1);
  const dark = await spread(0);
  console.error(`water light: green channel ${lit.lo}..${lit.hi} with light 1, ${dark.lo}..${dark.hi} with light 0`);
  assert.ok(lit.hi - lit.lo > 40, `caustics and highlights spread the brightness: ${lit.lo}..${lit.hi}`);
  assert.ok(dark.hi - dark.lo < 12, `without the light only the absorption varies a little: ${dark.lo}..${dark.hi}`);
});

gpuTest('the action drop through the effect handle: a drop moves pixels centred on its point, the frame agrees with its mapper, it resolves calm', async (t) => {
  const { rig, handle, mappers } = await presentOnce(t, plugin, { intensity: 1 }, { scene });
  let now = performance.now() + 100;
  const tick = (/** @type {number} */ n = 1) => { for (let i = 0; i < n; i += 1) { rig.tick(now); now += 50; } };
  const later = () => new Promise((r) => setTimeout(r, 0));
  assert.equal(await handle.settled(), 'calm', 'calm at once: nothing moves before any input');
  tick();
  const quiet = rig.snap();
  tick(5);
  const quietLater = rig.snap();
  const idle = changedPixels(quietLater, quiet);
  let state = null;
  handle.trigger('drop', { point: { x: 240, y: 160 }, strength: 2 }).then((v) => { state = v; });
  tick(5);
  const img = rig.snap();
  const moved = changedPixels(img, quietLater);
  // a drop rings out as a train of rings around its point: the displacement of the frame (its mapper, which the same test holds to the
  // pixels below) is centred on it. The point is the centre of the canvas, so that the reflections in the four walls are symmetric too
  // (the Node tests check that a drop falls at any point it is given)
  const m = /** @type {any} */ (mappers.at(-1));
  let wsum = 0, sx = 0, sy = 0;
  for (let y = 2; y < 320; y += 4) for (let x = 2; x < 480; x += 4) {
    if (Math.hypot(x - 240, y - 160) > 150) continue;
    const q = m({ x, y, width: 480, height: 320 }), d = Math.hypot(q.x - x, q.y - y);
    wsum += d; sx += d * x; sy += d * y;
  }
  const cx = sx / Math.max(1e-9, wsum), cy = sy / Math.max(1e-9, wsum);
  console.error(`water action: idle drift ${idle} px in 250 ms, the drop ${moved} px, its displacement centred at (${cx.toFixed(1)}, ${cy.toFixed(1)})`);
  assert.equal(idle, 0, 'nothing moves at rest');
  assert.ok(moved > 500 && wsum > 100 && Math.hypot(cx - 240, cy - 160) < 4, `the drop moved pixels: ${moved}, displaced around (${cx.toFixed(1)}, ${cy.toFixed(1)}), its point (240, 160)`);
  const a = agreement(img, /** @type {any} */ (mappers.at(-1)), scene);
  assert.ok(a.wrong <= 5, `the frame of the drop disagrees with its mapper on ${a.wrong} px`);
  for (let i = 0; i < 120 && state === null; i += 1) { tick(); await later(); }
  assert.equal(state, 'calm', 'it resolves once the surface is flat again');
});

gpuTest('the action demo: rain changes the picture, every checked frame agrees with its mapper, it resolves calm within about 4 s at the default intensity and ends at rest', async (t) => {
  const r = await runActionOnGpu(t, plugin, { ...meta.defaults }, 'demo', {}, { scene, stepMs: 1000 / 60, maxMs: 7000, checkEvery: 6 });
  const ms = (r.frames * 1000) / 60;
  console.error(`water demo: ${r.frames} frames (${Math.round(ms)} ms), max changed ${r.maxChanged} px, worst mapper disagreement ${r.worst?.wrong} px of ${r.worst?.decided} (${r.checked} frames checked)`);
  assert.equal(r.state, 'calm');
  assert.ok(ms < 4600, `the demo ends at rest after ${Math.round(ms)} ms`);
  assert.ok(r.maxChanged > 1500, `it rains: ${r.maxChanged} px changed`);
  assert.ok(r.worst && r.worst.wrong <= 5, `input follows the pixels while it rains: ${r.worst?.wrong} px disagree`);
  assert.ok(changedPixels(r.last, r.first) <= 2, 'it ends at rest: the last frame is the still picture');
}, { timeout: 20000 });   // about 150 frames on the frame clock, and the mapper of every 6th judged on 150,000 pixels (each through up to 96 drop sources)

/**
 * The light that the picture reads on the page, as numbers: the plugin's caustic texture (r16float texels), made readable (COPY_SRC) where
 * the plugin creates it, and the light of still water (1) outside the box where it holds the light (the uniform LIGHT_BOX of the last
 * frame: the picture reads 1 there too). @param {any} t
 */
function captureCaustics(t) {
  const proto = /** @type {any} */ (globalThis).GPUDevice.prototype;
  const original = proto.createTexture;
  const queue = /** @type {any} */ (globalThis).GPUQueue.prototype;
  const writeBuffer = queue.writeBuffer;
  /** @type {{tex: any, dev: any, w: number, h: number}|null} */ let caustic = null;
  /** @type {Float32Array|null} */ let globals = null;
  proto.createTexture = function (/** @type {any} */ d) {
    if (d?.label !== 'hic-water-effect-caustics') return original.call(this, d);
    const tex = original.call(this, { ...d, usage: d.usage | GPUTextureUsage.COPY_SRC });
    caustic = { tex, dev: this, w: d.size.width, h: d.size.height };
    return tex;
  };
  queue.writeBuffer = function (/** @type {any} */ buffer, /** @type {any[]} */ ...rest) {
    if (buffer?.label === 'hic-water-effect-globals' && rest[1] instanceof Float32Array && rest[1].length === GLOBALS_LENGTH) globals = rest[1].slice();
    return writeBuffer.call(this, buffer, ...rest);
  };
  t.cleanup(() => { proto.createTexture = original; queue.writeBuffer = writeBuffer; });
  const read = async () => {
    const c = /** @type {{tex: any, dev: any, w: number, h: number}} */ (caustic);
    if (!c) throw new Error('the plugin made no caustic texture');
    const bytesPerRow = Math.ceil((c.w * 2) / 256) * 256;
    const buf = c.dev.createBuffer({ size: bytesPerRow * c.h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = c.dev.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: c.tex }, { buffer: buf, bytesPerRow }, { width: c.w, height: c.h });
    c.dev.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const half = new Uint16Array(buf.getMappedRange().slice(0));
    buf.unmap();
    const f16 = (/** @type {number} */ h) => { const e = (h >> 10) & 31, m = h & 1023, s = h & 0x8000 ? -1 : 1; return e === 0 ? s * m * 2 ** -24 : s * (1 + m / 1024) * 2 ** (e - 15); };
    const v = new Float32Array(c.w * c.h);
    const g = /** @type {Float32Array} */ (globals);
    const [x0, y0, x1, y1] = g.subarray(G.LIGHT_BOX, G.LIGHT_BOX + 4);
    const tx = g[G.CSS] / c.w, ty = g[G.CSS + 1] / c.h;
    let outside = 0;
    for (let y = 0; y < c.h; y += 1) for (let x = 0; x < c.w; x += 1) {
      const px = (x + 0.5) * tx, py = (y + 0.5) * ty;
      const held = px >= x0 && px <= x1 && py >= y0 && py <= y1;
      if (!held) outside += 1;
      v[y * c.w + x] = held ? f16(half[(y * bytesPerRow) / 2 + x]) : 1;
    }
    return { w: c.w, h: c.h, v, outside };
  };
  /** the plugin has made its caustic texture */
  read.made = () => caustic !== null;
  return read;
}

const greyScene = { w: 480, h: 320, paint(/** @type {CanvasRenderingContext2D} */ ctx) { ctx.fillStyle = '#7f7f7f'; ctx.fillRect(0, 0, 480, 320); } };

gpuTest('the caustics conserve the light: a drop gathers the sunlight on the page into lines more than 3 times as bright and leaves troughs darker, while the light on the canvas stays 1 on average (within 3 %)', async (t) => {
  const read = captureCaustics(t);
  const { rig, handle } = await presentOnce(t, plugin, { intensity: 1 }, { scene: /** @type {any} */ (greyScene) });
  let now = performance.now() + 100;
  handle.trigger('drop', { point: { x: 240, y: 160 }, strength: 2 });
  for (let i = 0; i < 30; i += 1) { rig.tick(now); now += 1000 / 120; }
  const c = await read();
  let sum = 0, max = 0, min = Infinity;
  for (const x of c.v) { sum += x; max = Math.max(max, x); min = Math.min(min, x); }
  const mean = sum / c.v.length;
  console.error(`water caustics: ${c.w} x ${c.h} texels (${c.outside} outside the drawn region: 1), mean ${mean.toFixed(4)}, min ${min.toFixed(3)}, max ${max.toFixed(2)}`);
  assert.ok(Math.abs(mean - 1) < 0.03, `the light is conserved: mean ${mean}`);
  assert.ok(max > 3 && min < 0.6, `it gathers into lines (max ${max}) and leaves troughs darker (min ${min})`);
}, { timeout: 20000 });

/** The centre of a drop's caustic rings (the centroid of |light - 1| over the whole canvas: the drop is the only disturbance), 250 ms after a tap at `at`. @param {any} t @param {Record<string, unknown>} options */
async function causticCentre(t, options, at, r = Infinity) {
  const read = captureCaustics(t);
  const { rig } = await presentOnce(t, plugin, { intensity: 1, ...options }, { scene: /** @type {any} */ (greyScene) });
  const box = rig.canvas.getBoundingClientRect();
  rig.layerEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: box.left + at.x, clientY: box.top + at.y }));
  let now = performance.now() + 100;
  for (let i = 0; i < 30; i += 1) { rig.tick(now); now += 1000 / 120; }
  const c = await read();
  let w = 0, sx = 0, sy = 0;
  for (let y = 0; y < c.h; y += 1) for (let x = 0; x < c.w; x += 1) {
    if (Math.hypot(x + 0.5 - at.x, y + 0.5 - at.y) > r) continue;
    const d = Math.abs(c.v[y * c.w + x] - 1);
    w += d; sx += d * (x + 0.5); sy += d * (y + 0.5);
  }
  return { x: sx / w, y: sy / w, weight: w };
}

gpuTest('a tap\'s caustic rings are centred on the tap (within 1 css px); control: light from an oblique direction (an injected offset) shifts them by more than 10 px and fails the check', async (t) => {
  const at = { x: 170, y: 140 };
  const c = await causticCentre(t, {}, at);
  const off = Math.hypot(c.x - at.x, c.y - at.y);
  console.error(`water caustic centre: (${c.x.toFixed(2)}, ${c.y.toFixed(2)}) for a tap at (${at.x}, ${at.y}): ${off.toFixed(2)} px`);
  assert.ok(c.weight > 50 && off < 1, `the rings are centred on the tap: ${off.toFixed(2)} px off`);
  // the positive control: the same shader with the light of round 3 (from the window, up and to the left)
  const code = await (await fetch('/plugins/water/water.wgsl')).text();
  const oblique = code.replace('const LIGHT_DIR : vec3<f32> = vec3<f32>(0.0, 0.0, 1.0);', 'const LIGHT_DIR : vec3<f32> = vec3<f32>(-0.20, -0.19, 0.96);');
  assert.notEqual(oblique, code, 'the control changes the light');
  const k = await causticCentre(t, { shader: oblique }, at);
  const offK = Math.hypot(k.x - at.x, k.y - at.y);
  console.error(`water caustic centre, control (oblique light): ${offK.toFixed(2)} px off`);
  assert.ok(offK > 10, `control: an oblique light shifts the rings (${offK.toFixed(2)} px), so the check can fail`);
}, { timeout: 20000 });

gpuTest('with light 0 no caustic texture is made; the light turned on by setOptions makes it at once, and the next drop gathers the light into lines that conserve it (control: the same check that finds the texture after the option change)', async (t) => {
  const read = captureCaustics(t);
  const { rig, handle } = await presentOnce(t, plugin, { intensity: 1, light: 0 }, { scene: /** @type {any} */ (greyScene) });
  let now = performance.now() + 100;
  for (let i = 0; i < 4; i += 1) { rig.tick(now); now += 1000 / 120; }
  assert.ok(!read.made(), 'light 0: no caustic texture after the first frames');
  handle.setOptions({ light: 1 });
  assert.ok(read.made(), 'control: setOptions turning the light on made it at once, before the next frame');
  handle.trigger('drop', { point: { x: 240, y: 160 }, strength: 2 });
  for (let i = 0; i < 30; i += 1) { rig.tick(now); now += 1000 / 120; }
  const c = await read();
  let sum = 0, max = 0;
  for (const x of c.v) { sum += x; max = Math.max(max, x); }
  const mean = sum / c.v.length;
  console.error(`water caustics after the light came on: ${c.w} x ${c.h}, mean ${mean.toFixed(4)}, max ${max.toFixed(2)}`);
  assert.ok(Math.abs(mean - 1) < 0.03 && max > 3, `the caustics work after the late allocation: mean ${mean}, max ${max}`);
}, { timeout: 20000 });

/** Pixels that differ at all between two frames, and the largest channel difference. @param {ImageData} a @param {ImageData} b */
function exactDiff(a, b) {
  let n = 0, max = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
    if (d > 0) n += 1;
    max = Math.max(max, d);
  }
  return { n, max };
}

/**
 * Frames of the plugin alone at exact times (no host, no real-time clock): its own device, an offscreen source and destination, a drop at
 * `at` (css px) by the action, then render(frame) at `times` ms after it; the read-back pixels of each frame (rgba8).
 * @param {Record<string, unknown>} options @param {{x: number, y: number}} at @param {number[]} times @param {Record<string, unknown>} [drop]  options of the action
 */
async function framesAt(options, at, times, drop = {}) {
  const W = 480, H = 320, dev = await (await navigator.gpu.requestAdapter()).requestDevice();
  const U = GPUTextureUsage;
  const src = dev.createTexture({ size: [W, H], format: 'rgba8unorm', usage: U.TEXTURE_BINDING | U.COPY_DST });
  const px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) { const k = (y * W + x) * 4; px[k] = (x * 5) & 255; px[k + 1] = (y * 3) & 255; px[k + 2] = ((x ^ y) * 7) & 255; px[k + 3] = 255; }
  dev.queue.writeTexture({ texture: src }, px, { bytesPerRow: W * 4 }, [W, H]);
  const dst = dev.createTexture({ size: [W, H], format: 'rgba8unorm', usage: U.RENDER_ATTACHMENT | U.COPY_SRC });
  const canvas = { clientWidth: W, clientHeight: H, clientLeft: 0, clientTop: 0, ownerDocument: document, getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }) };
  // Every clock the plugin reads is the same in every call: performance.now() is held at one fixed instant while the plugin is created (its
  // start: the uniform TIME) and while the drop falls (the drop's clock; its first frame aligns the steps to the frame times, the later ones
  // follow exactly), and the frames are at fixed times after it. So every call uploads bit-identical uniforms and fields (otherwise a slower
  // first call puts one more step into its first frame, and TIME differs by the time the creation took).
  const now = performance.now, held = 100000;
  performance.now = () => held;
  /** @type {any} */ let inst;
  try {
    inst = /** @type {any} */ (await plugin.create(/** @type {any} */ ({ apiVersion: 2, device: dev, format: 'rgba8unorm', canvas, requestRender() {}, listen: () => () => {}, viewport: () => ({}) }), /** @type {any} */ (options)));
    inst.runAction('drop', { point: at, ...drop }, { reducedMotion: false });
  } finally { performance.now = now; }
  const frame = (/** @type {any} */ encoder, /** @type {number} */ t) => ({ now: t, width: W, height: H, cssWidth: W, cssHeight: H, dpr: 1, sourceReady: true, encoder, sourceTexture: src, sourceView: src.createView(), destinationTexture: dst, destinationView: dst.createView() });
  const t0 = held + 4.2;
  const out = [];
  for (const dt of times) {
    const e = dev.createCommandEncoder();
    inst.render(frame(e, t0 + dt));
    const row = Math.ceil((W * 4) / 256) * 256;
    const buf = dev.createBuffer({ size: row * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    e.copyTextureToBuffer({ texture: dst }, { buffer: buf, bytesPerRow: row }, [W, H]);
    dev.queue.submit([e.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(buf.getMappedRange());
    const data = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y += 1) data.set(mapped.subarray(y * row, y * row + W * 4), y * W * 4);
    buf.unmap();
    out.push({ data });
  }
  inst.destroy();
  dev.destroy();
  return out;
}

gpuTest('the shader skips the B-spline where the field is exactly flat (outside its box) and changes no pixel: a pebble in a corner, frames at exact times from the first until the rings cover the canvas, against the same shader without the skip (light 0: the refraction alone, whose frames are reproducible; the caustics add up overlapping triangles, whose order of blending this GPU may vary); control: a box of one cell changes thousands of pixels', async () => {
  const code = await (await fetch('/plugins/water/water.wgsl')).text();
  const skip = '  if (any(hi < live.xy) || any(lo > live.zw)) { return s; }';
  assert.ok(code.includes(skip), 'the shader has the skip');
  const noSkip = code.replace(skip, '');
  const shortBox = code.replace('let live = vec4<i32>(globals.live_box);', 'let live = vec4<i32>(globals.live_box.xyxy);');
  assert.notEqual(shortBox, code, 'the control changes the box');
  // a corner: the box takes in the ghost cells of two walls
  const at = { x: 14, y: 12 }, times = [75, 117, 450, 1200];
  const shipped = await framesAt({ intensity: 1, light: 0, shader: code }, at, times);
  const plain = await framesAt({ intensity: 1, light: 0, shader: noSkip }, at, times);
  const again = await framesAt({ intensity: 1, light: 0, shader: code }, at, times);
  const short = await framesAt({ intensity: 1, light: 0, shader: shortBox }, at, times);
  const diffs = shipped.map((img, k) => exactDiff(/** @type {any} */ (img), /** @type {any} */ (plain[k])));
  const repeat = shipped.map((img, k) => exactDiff(/** @type {any} */ (img), /** @type {any} */ (again[k])));
  const control = shipped.map((img, k) => exactDiff(/** @type {any} */ (img), /** @type {any} */ (short[k])));
  console.error(`water box skip: differing pixels per frame ${diffs.map((d) => `${d.n} (max ${d.max})`).join(', ')} of ${480 * 320}; the same shader twice ${repeat.map((d) => d.n).join(', ')}; control (a box of one cell) ${control.map((d) => d.n).join(', ')}`);
  assert.ok(repeat.every((d) => d.n === 0), 'the frames are reproducible');
  const motion = [1, 2, 3].map((k) => exactDiff(/** @type {any} */ (shipped[0]), /** @type {any} */ (shipped[k])).n);
  assert.ok(motion.every((n) => n > 2000), `the rings move: ${motion} pixels change after the first frame`);
  assert.ok(diffs.every((d) => d.n === 0), `the skip changes no pixel: ${JSON.stringify(diffs)}`);
  assert.ok(control.every((d) => d.n > 500), `control: a box of one cell changes pixels: ${JSON.stringify(control)}`);
}, { timeout: 30000 });

/**
 * Frames of framesAt with the shipped shader and the caustic region changed through its uniforms and the pass's draw, and for each frame
 * the light box that the plugin set (css px [x0, y0, x1, y1]: the moving surface, its spill and a rim) and the moving area (the field's box
 * and the B-spline's reach). `whole`: the whole mesh from its first column and
 * row, the texture read everywhere (the pass before the region existed); `wider`: the same with 4 more columns per strip beyond the right
 * edge of the texture, triangles that light nothing (the GPU's own variance under a change of the draw alone); `trim`: the region 3 rows
 * short at its top and its bottom; `nospill`: only the moving area drawn and read, the light it sends beyond it dropped (the controls).
 * The same shader module in every case. @param {Record<string, unknown>} options @param {{x: number, y: number}} at @param {number[]} times
 * @param {'shipped'|'whole'|'wider'|'trim'|'nospill'} how @param {Record<string, unknown>} [drop]
 */
async function framesDrawn(options, at, times, how, drop = {}) {
  const pass = /** @type {any} */ (globalThis).GPURenderPassEncoder.prototype;
  const queue = /** @type {any} */ (globalThis).GPUQueue.prototype;
  const draw = pass.draw, writeBuffer = queue.writeBuffer, writeTexture = queue.writeTexture;
  const mesh = causticMesh(480, 320, CAUSTIC_DEPTH_PX);
  /** what the plugin uploads, as it made it (before the changes below): its uniforms and its field, hashed per upload */
  /** @type {string[]} */ const uploads = [];
  const hash = (/** @type {ArrayBufferView} */ d) => { const u = new Uint8Array(d.buffer, d.byteOffset, d.byteLength); let x = 2166136261; for (let i = 0; i < u.length; i += 1) x = Math.imul(x ^ u[i], 16777619); return (x >>> 0).toString(16); };
  /** @type {number[][]} */ const areas = [];
  /** @type {number[][]} */ const boxes = [];
  /** @type {number[]} */ let cut = [];
  pass.draw = function (/** @type {number} */ n, /** @type {number} */ k = 1, /** @type {number} */ v0 = 0, /** @type {number} */ i0 = 0) {
    if (n === 3 || how === 'shipped') return draw.call(this, n, k, v0, i0);
    if (how === 'trim') return draw.call(this, n, Math.max(0, k - 6), v0, i0);
    if (how === 'nospill') return draw.call(this, 2 * (cut[2] - cut[0] + 1), cut[3] - cut[1], v0, i0);
    return draw.call(this, 2 * (mesh.columns + 1 + (how === 'wider' ? 4 : 0)), mesh.rows, v0, i0);
  };
  queue.writeBuffer = function (/** @type {any} */ buffer, /** @type {number} */ offset, /** @type {any} */ data, /** @type {any[]} */ ...rest) {
    if (buffer?.label === 'hic-water-effect-globals' && data instanceof Float32Array) uploads.push(`u${hash(data)}`);
    if (buffer?.label === 'hic-water-effect-globals' && data instanceof Float32Array && data[G.CAUSTICS] > 0.5) {
      const cx = data[G.CSS] / data[G.GRID], cy = data[G.CSS + 1] / data[G.GRID + 1], b = data.subarray(G.BOX, G.BOX + 4);
      const area = [(b[0] - 2 - 3) * cx, (b[1] - 2 - 3) * cy, (b[2] - 2 + 4) * cx, (b[3] - 2 + 4) * cy];
      areas.push(area);
      boxes.push([...data.subarray(G.LIGHT_BOX, G.LIGHT_BOX + 4)]);
      data = data.slice();
      if (how === 'trim') data[G.MESH_FROM + 1] += 3;
      else if (how === 'nospill') {
        const col = (/** @type {number} */ x) => Math.min(mesh.columns, Math.max(0, Math.round((x + mesh.margin) / 2)));
        const row = (/** @type {number} */ y) => Math.min(mesh.rows, Math.max(0, Math.round((y + mesh.margin) / 2)));
        cut = [col(area[0]), row(area[1]), col(area[2]), row(area[3])];
        data.set([cut[0], cut[1]], G.MESH_FROM);
        data.set([-mesh.margin + 2 * cut[0] + 3, -mesh.margin + 2 * cut[1] + 3, -mesh.margin + 2 * cut[2] - 3, -mesh.margin + 2 * cut[3] - 3], G.LIGHT_BOX);
      } else if (how !== 'shipped') { data.set([-1e9, -1e9, 1e9, 1e9], G.LIGHT_BOX); data.set([0, 0], G.MESH_FROM); }
    }
    return writeBuffer.call(this, buffer, offset, data, ...rest);
  };
  queue.writeTexture = function (/** @type {any} */ dst, /** @type {any} */ data, /** @type {any[]} */ ...rest) {
    if (dst?.texture?.label === 'hic-water-effect-height-field') uploads.push(`f${hash(data)}`);
    return writeTexture.call(this, dst, data, ...rest);
  };
  try { return { frames: await framesAt(options, at, times, drop), areas, boxes, uploads: uploads.join(' ') }; } finally { pass.draw = draw; queue.writeBuffer = writeBuffer; queue.writeTexture = writeTexture; }
}

/** Differing pixels of two frames outside and inside a css px area (a frame is 480 x 320 css px at DPR 1). @param {any} a @param {any} b @param {number[]} area */
function diffAround(a, b, area) {
  const out = { n: 0, max: 0 }, inside = { n: 0, max: 0 };
  for (let y = 0; y < 320; y += 1) for (let x = 0; x < 480; x += 1) {
    const i = (y * 480 + x) * 4;
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
    if (!d) continue;
    const r = x + 0.5 >= area[0] && x + 0.5 <= area[2] && y + 0.5 >= area[1] && y + 0.5 <= area[3] ? inside : out;
    r.n += 1; r.max = Math.max(r.max, d);
  }
  return { out, inside };
}

gpuTest('the caustic pass draws only the region that can differ from still water, and the frames are those of the whole pass: a pebble, light 1, intensity 1 and 0.3, frames at exact times from the first until its rings cover most of the canvas, against the whole mesh read everywhere. Every run uploads bit-identical uniforms and fields. Outside the light box less 2 px (still water, and the rim of the region) the frames are bit-identical; inside it, where the moving surface and its spilled light are, this GPU varies the caustics with the shape of the draw alone and from run to run, and the region changes them no more than that variance (triangles that light nothing, or the same draw again); controls: a region 3 rows short changes pixels outside, the region without the spill several times more inside than that variance', async () => {
  const code = await (await fetch('/plugins/water/water.wgsl')).text();
  assert.ok(code.includes('all(light_at >= globals.light_box.xy) && all(light_at <= globals.light_box.zw)'), 'the shader reads the caustic texture only inside the light box');
  assert.ok(code.includes('let origin = vec2<u32>(globals.mesh_from);'), 'the pass draws the mesh from mesh_from');
  const at = { x: 300, y: 130 }, times = [17, 75, 117, 250, 450, 800];
  const fmt = (/** @type {{n: number, max: number}[]} */ x) => x.map((y) => `${y.n} (max ${y.max})`).join(', ');
  for (const intensity of [1, 0.3]) {
    const o = { intensity, light: 1 };
    const shipped = await framesDrawn(o, at, times, 'shipped');
    const whole = await framesDrawn(o, at, times, 'whole');
    const again = await framesDrawn(o, at, times, 'whole');
    const wider = await framesDrawn(o, at, times, 'wider');
    const trim = await framesDrawn(o, at, times, 'trim');
    const nospill = await framesDrawn(o, at, times, 'nospill');
    const zone = shipped.boxes.map((b) => [b[0] + 2, b[1] + 2, b[2] - 2, b[3] - 2]);
    const vs = (/** @type {any} */ p, /** @type {any} */ q) => p.frames.map((/** @type {any} */ img, /** @type {number} */ k) => diffAround(img, q.frames[k], zone[k]));
    const diffs = vs(shipped, whole), repeat = vs(whole, again), inert = vs(wider, whole), cTrim = vs(trim, shipped), cSpill = vs(nospill, whole);
    console.error(`water caustic region, intensity ${intensity}: light boxes ${zone.map((z) => z.map(Math.round).join(' ')).join(' | ')}; against the whole pass, outside the box ${fmt(diffs.map((x) => x.out))}, inside ${fmt(diffs.map((x) => x.inside))} of ${480 * 320}; the whole pass twice ${fmt(repeat.map((x) => ({ n: x.out.n + x.inside.n, max: Math.max(x.out.max, x.inside.max) })))}; with triangles that light nothing: outside ${fmt(inert.map((x) => x.out))}, inside ${fmt(inert.map((x) => x.inside))}; controls: 3 rows short, outside ${cTrim.map((x) => x.out.n)}; without the spill, inside ${cSpill.map((x) => x.inside.n)}`);
    const motion = [1, 2, 3, 4, 5].map((k) => exactDiff(shipped.frames[0], shipped.frames[k]).n);
    assert.ok(motion.every((n) => n > 2000), `the rings move: ${motion}`);
    // every run uploads the very same uniforms and fields (the clock is held): what differs between them is the GPU's alone
    assert.ok(shipped.uploads.length > 0 && [whole, again, wider, trim, nospill].every((r) => r.uploads === shipped.uploads), 'every run uploads bit-identical uniforms and fields');
    // the same draw with the same uploads twice: this GPU adds up the caustic lines in an order that varies from run to run too (0 to 93
    // pixels by up to 3 levels measured on the Mac, more under load); outside the light box, where no triangles overlap, never
    assert.ok(repeat.every((x) => x.out.n === 0), `the whole pass twice: no pixel differs outside the light box: ${fmt(repeat.map((x) => x.out))}`);
    assert.ok(inert.every((x) => x.out.n === 0), 'the GPU\'s own variance stays inside the light box');
    assert.ok(diffs.every((x) => x.out.n === 0), `outside the light box the region changes no pixel: ${fmt(diffs.map((x) => x.out))}`);
    // the GPU's variance inside the box: a change of the draw alone, or the same draw again, whichever is larger
    const most = Math.max(...inert.map((x) => x.inside.n), ...repeat.map((x) => x.inside.n)), deepest = Math.max(...inert.map((x) => x.inside.max), ...repeat.map((x) => x.inside.max));
    assert.ok(diffs.every((x) => x.inside.n <= Math.max(10, 1.5 * most) && x.inside.max <= Math.max(2, 1.5 * deepest)), `inside it no more than the GPU's own variance: ${fmt(diffs.map((x) => x.inside))} vs ${fmt(inert.map((x) => x.inside))}`);
    // (where the box reaches beyond the canvas at the top and the bottom, the rows the control leaves out light nothing on it)
    const inCanvas = zone.map((z) => z[1] > 0 || z[3] < 320);
    assert.ok(inCanvas.filter(Boolean).length >= 2 && cTrim.every((x, k) => !inCanvas[k] || x.out.n > 100), `control: a region 3 rows short changes pixels outside the box: ${cTrim.map((x) => x.out.n)}`);
    if (intensity === 1) assert.ok(cSpill.some((x, k) => x.inside.n > 3 * inert[k].inside.n + 100), `control: without the spill, several times the GPU's variance changes: ${cSpill.map((x) => x.inside.n)} vs ${inert.map((x) => x.inside.n)}`);
  }
}, { timeout: 60000 });

