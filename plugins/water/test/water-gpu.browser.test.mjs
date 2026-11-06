// The water input mapper against the pixels the GPU really produced (not against its own formula), through the shared plugin kit; the
// actions 'drop' and 'demo' through the effect handle; zero work at rest; the light (caustics and reflections) on a uniform page.
import { assert } from '/test/unit/lib/t.js';
import { agreement, changedPixels, checkMapperAgainstGpu, gpuAvailable, gpuTest, identity, markerScene, presentOnce, runActionOnGpu } from '/plugins/_shared/gpu-check.mjs';
import { meta, plugin } from '/plugins/water/index.js';

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
 * The plugin's caustic texture, made readable (COPY_SRC) where the plugin creates it, then read back as numbers (r16float texels).
 * @param {any} t
 */
function captureCaustics(t) {
  const proto = /** @type {any} */ (globalThis).GPUDevice.prototype;
  const original = proto.createTexture;
  /** @type {{tex: any, dev: any, w: number, h: number}|null} */ let caustic = null;
  proto.createTexture = function (/** @type {any} */ d) {
    if (d?.label !== 'hic-water-effect-caustics') return original.call(this, d);
    const tex = original.call(this, { ...d, usage: d.usage | GPUTextureUsage.COPY_SRC });
    caustic = { tex, dev: this, w: d.size.width, h: d.size.height };
    return tex;
  };
  t.cleanup(() => { proto.createTexture = original; });
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
    for (let y = 0; y < c.h; y += 1) for (let x = 0; x < c.w; x += 1) v[y * c.w + x] = f16(half[(y * bytesPerRow) / 2 + x]);
    return { w: c.w, h: c.h, v };
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
  console.error(`water caustics: ${c.w} x ${c.h} texels, mean ${mean.toFixed(4)}, min ${min.toFixed(3)}, max ${max.toFixed(2)}`);
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
