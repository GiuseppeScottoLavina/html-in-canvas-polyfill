// The liquid-glass input mapper against the pixels the GPU really produced (plugins/_shared/gpu-check.mjs), a moving lens, device loss,
// the demo action on the GPU, frost, and the GPU time of the pass.
import { assert } from '/test/unit/lib/t.js';
import { agreement, changedPixels, checkMapperAgainstGpu, gpuAvailable, gpuTest, markerScene, presentOnce, runActionOnGpu, until } from '/plugins/_shared/gpu-check.mjs';
import { definePlugin } from '/src/effects/plugin-abi.js';
import { UNIFORM_FLOATS, mapLensPoint, plugin, writeLensGeometry } from '/plugins/liquid-glass/index.js';
import { measureGpuTime } from '/plugins/_shared/gpu-time.mjs';

console.error(`liquid-glass gpu tests: WebGPU ${(await gpuAvailable()) ? 'available' : 'NOT available'}`);

const scene = markerScene({ w: 480, h: 320 });
/** geometry only: no colour fringes, no highlight or reflection, no shadow, no frost, so "bright" is decided by the sampled point alone */
const GEOMETRY = { pinned: true, x: 0.5, y: 0.5, size: 170, refraction: 1, dispersion: 0, highlight: 0, shadow: 0, frost: 0 };

/** The uniform block of the GEOMETRY lens at rest at (cx, cy) on the 480 x 320 scene. @param {number} cx @param {number} cy */
function lensState(cx, cy) {
  const s = new Float32Array(UNIFORM_FLOATS);
  s[0] = 480; s[1] = 320; s[2] = 480; s[3] = 320;
  writeLensGeometry(s, { cx, cy, size: GEOMETRY.size, aspect: 1.45, refraction: GEOMETRY.refraction });
  return s;
}

/** @param {ImageData} img the green channel copied into the red one (agreement() reads red) */
function greenAsRed(img) {
  const out = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  for (let i = 0; i < out.data.length; i += 4) out.data[i] = out.data[i + 1];
  return out;
}

gpuTest('a pinned lens: every presented pixel samples the source point the mapper says; identity does not (positive control)', async (t) => {
  const v = await checkMapperAgainstGpu(t, plugin, GEOMETRY, { scene });
  console.error(`liquid-glass mapper vs GPU: decided=${v.real.decided} wrong=${v.real.wrong} bright=${v.real.bright} | identity wrong=${v.identity.wrong}`);
  assert.ok(v.ok, v.why);
});

gpuTest('the oracle is sensitive to the lens geometry: the formula with the lens 12 px off disagrees', async (t) => {
  const { img, mapper } = await presentOnce(t, plugin, GEOMETRY, { scene });
  const right = lensState(240, 160);
  const off = lensState(252, 160);
  const good = agreement(img, /** @type {any} */ (mapper), scene).wrong;
  const formula = agreement(img, (p) => mapLensPoint(right, p), scene).wrong;
  const bad = agreement(img, (p) => mapLensPoint(off, p), scene).wrong;
  assert.ok(good <= 5 && formula <= 5, `the plugin's mapper ${good} and the formula ${formula} wrong px`);
  assert.ok(bad > 100, `the lens 12 px off: ${bad} wrong px`);
});

gpuTest('dispersion spreads red and blue only: the green channel stays where the mapper says', async (t) => {
  const { img, mapper } = await presentOnce(t, plugin, { ...GEOMETRY, dispersion: 1 }, { scene });
  const green = agreement(greenAsRed(img), /** @type {any} */ (mapper), scene);
  const red = agreement(img, /** @type {any} */ (mapper), scene);
  console.error(`liquid-glass dispersion 1: green wrong=${green.wrong}, red wrong=${red.wrong}`);
  assert.ok(green.wrong <= 5, `green channel: ${green.wrong} wrong px`);
  assert.ok(red.wrong > green.wrong, 'the red channel is really displaced (the fringes exist)');
});

gpuTest('a lens moving on its spring (stretched by its velocity): the newest mapper still predicts every pixel', async (t) => {
  const { rig, mappers } = await presentOnce(t, plugin, { ...GEOMETRY, pinned: false }, { scene });
  const r = rig.canvas.getBoundingClientRect();
  const t0 = performance.now();
  for (let k = 1; k <= 6; k += 1) {   // a pointer drag towards the lower right; each move asks for a frame
    rig.layerEl.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r.left + 240 + k * 30, clientY: r.top + 160 + k * 14 }));
    rig.tick(t0 + 100 + k * 16);
  }
  const img = rig.snap();
  const moving = agreement(img, /** @type {any} */ (mappers.at(-1)), scene);
  const first = agreement(img, /** @type {any} */ (mappers[0]), scene);
  console.error(`liquid-glass moving lens (${mappers.length} frames): newest wrong=${moving.wrong}, first-frame mapper wrong=${first.wrong}`);
  assert.ok(moving.wrong <= 5, `${moving.wrong} wrong px`);
  assert.ok(first.wrong > 100, 'the lens really moved: the mapper of the first frame no longer fits');
});

gpuTest('device loss: the host re-creates the plugin on a new device and the lens is drawn and mapped again', async (t) => {
  /** @type {any[]} */ const devices = [];
  const def = definePlugin({ ...plugin, async create(/** @type {any} */ ctx, /** @type {any} */ o) { devices.push(ctx.device); return plugin.create(ctx, o); } });
  const { rig, mappers } = await presentOnce(t, def, GEOMETRY, { scene });
  const before = mappers.length;
  devices[0].destroy();
  await until(() => devices.length >= 2);
  assert.equal(devices.length, 2, 'create() ran again on a new device');
  await new Promise((ok) => setTimeout(ok, 50));
  rig.tick(performance.now() + 50);
  const img = rig.snap();
  assert.ok(mappers.length > before, 'a frame was presented after the loss');
  const v = agreement(img, /** @type {any} */ (mappers.at(-1)), scene);
  assert.ok(v.bright > scene.centres.length * 80, `the frame after the loss is drawn (${v.bright} bright px)`);
  assert.ok(v.wrong <= 5, `and its mapper fits it: ${v.wrong} wrong px`);
  assert.ok(agreement(img, (p) => mapLensPoint(lensState(240, 160), p), scene).wrong <= 5, 'with the same pinned lens as before the loss');
});

gpuTest('the demo on the GPU: the lens tours the scene, every checked frame is mapped, and it ends at rest at home', async (t) => {
  const r = await runActionOnGpu(t, plugin, { ...GEOMETRY, pinned: false }, 'demo', {}, { maxMs: 6000 });
  console.error(`liquid-glass demo: state=${r.state} frames=${r.frames} checked=${r.checked} worst wrong=${r.worst?.wrong} changed=${r.maxChanged}`);
  assert.equal(r.state, 'free');
  assert.ok(r.frames / 60 < 4.5, `${(r.frames / 60).toFixed(2)} s of frames`);
  assert.ok(r.checked >= 10 && (r.worst?.wrong ?? 99) <= 5, `the worst checked frame: ${r.worst?.wrong} wrong px`);
  assert.ok(r.maxChanged > 2000, `the lens really moved (${r.maxChanged} px changed at most)`);
  assert.ok(changedPixels(r.last, r.first) < 50, `and came back home: ${changedPixels(r.last, r.first)} px differ from the first frame`);
  assert.equal(r.handle.enabled, true);
});

gpuTest('frost blurs only what the glass shows: the page around it is untouched', async (t) => {
  const clear = await presentOnce(t, plugin, { ...GEOMETRY }, { scene });
  const frosted = await presentOnce(t, plugin, { ...GEOMETRY, frost: 1 }, { scene });
  const inside = (/** @type {number} */ i, /** @type {number} */ j) => mapLensPoint(lensState(240, 160), { x: i + 0.5, y: j + 0.5, width: 480, height: 320 });
  let changedIn = 0;
  let changedOut = 0;
  for (let j = 0; j < 320; j += 1) {
    for (let i = 0; i < 480; i += 1) {
      const k = (j * 480 + i) * 4;
      const diff = Math.abs(clear.img.data[k] - frosted.img.data[k]) + Math.abs(clear.img.data[k + 1] - frosted.img.data[k + 1]);
      const m = inside(i, j);
      const out = m.x === i + 0.5 && m.y === j + 0.5;
      if (diff > 12) { if (out) changedOut += 1; else changedIn += 1; }
    }
  }
  console.error(`liquid-glass frost: ${changedIn} px changed under the lens, ${changedOut} outside`);
  assert.ok(changedIn > 300, `frost changes the picture under the lens (${changedIn} px)`);
  assert.ok(changedOut <= 2, `and nothing outside it (${changedOut} px)`);
});

gpuTest('GPU time of the pass at the gallery size (1100 x 620 CSS px, DPR 2): well inside a 120 Hz frame', async () => {
  const r = await measureGpuTime(plugin, { refraction: 0.7, dispersion: 0.5, x: 0.5, y: 0.5 });
  console.error(`liquid-glass GPU time ${r.w}x${r.h}: ${r.meanMs.toFixed(3)} ms/frame (clear-only pass ${r.baselineMs.toFixed(3)} ms), ${r.frames} frames back to back`);
  assert.ok(r.meanMs < 2, `${r.meanMs.toFixed(3)} ms per frame`);
});
