// The CRT input mapper against the pixels the GPU really produced (plugins/_shared/gpu-check.mjs), device loss, and the GPU time.
import { assert } from '/test/unit/lib/t.js';
import { agreement, checkMapperAgainstGpu, gpuAvailable, gpuTest, markerScene, presentOnce } from '/plugins/_shared/gpu-check.mjs';
import { definePlugin } from '/src/effects/plugin-abi.js';
import { UNIFORM_FLOATS, bezelWidth, cornerRadius, mapCrtPoint, plugin } from '/plugins/crt/index.js';
import { measureGpuTime } from '/plugins/_shared/gpu-time.mjs';

console.error(`crt gpu tests: WebGPU ${(await gpuAvailable()) ? 'available' : 'NOT available'}`);

const scene = markerScene({ w: 480, h: 320 });
/** geometry only: no glow halo, no misconvergence fringes, no flicker, so "bright" is decided by the sampled point alone */
const GEOMETRY = { curvature: 0.6, scanlines: 0.6, glow: 0, flicker: 0, misconvergence: 0 };

/** The uniform block (geometry part) for a 480 x 320 frame at `curvature`. @param {number} curvature */
function crtState(curvature) {
  const s = new Float32Array(UNIFORM_FLOATS);
  s[0] = 480; s[1] = 320; s[2] = 480; s[3] = 320; s[4] = curvature * 0.5; s[5] = bezelWidth(480, 320); s[6] = cornerRadius(480, 320);
  return s;
}

/** @param {ImageData} img the green channel copied into the red one (agreement() reads red) */
function greenAsRed(img) {
  const out = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  for (let i = 0; i < out.data.length; i += 4) out.data[i] = out.data[i + 1];
  return out;
}

gpuTest('every presented pixel samples the source point the barrel mapper says; identity does not (positive control)', async (t) => {
  // The screen shows the WHOLE source inside the bezel, so every marker is drawn smaller: about 0.80 of the painted area is bright at
  // curvature 0.6 (2818 of 3500 px, headless Chrome 154, Apple M1 Max), right at the kit's default 0.8. The share is 0.7; the other two
  // conditions are the kit's.
  const v = await checkMapperAgainstGpu(t, plugin, GEOMETRY, { scene, minBrightShare: 0.7 });
  console.error(`crt mapper vs GPU: decided=${v.real.decided} wrong=${v.real.wrong} bright=${v.real.bright} | identity wrong=${v.identity.wrong}`);
  assert.ok(v.ok, v.why);
});

gpuTest('the oracle is sensitive to the curvature: the formula at curvature 0.4 instead of 0.6 disagrees', async (t) => {
  const { img, mapper } = await presentOnce(t, plugin, GEOMETRY, { scene });
  const good = agreement(img, /** @type {any} */ (mapper), scene).wrong;
  const formula = agreement(img, (p) => mapCrtPoint(crtState(0.6), p), scene).wrong;
  const bad = agreement(img, (p) => mapCrtPoint(crtState(0.4), p), scene).wrong;
  assert.ok(good <= 5 && formula <= 5, `the plugin's mapper ${good} and the formula ${formula} wrong px`);
  assert.ok(bad > 100, `curvature 0.4: ${bad} wrong px`);
});

gpuTest('with the full look (default glow, misconvergence, scanlines) the green channel still agrees with the mapper inside the screen', async (t) => {
  const { img, mapper } = await presentOnce(t, plugin, { curvature: 1, flicker: 0 }, { scene });
  // the glow halo brightens the dark around each marker, so judge only pixels whose source point is more than 4 px from a marker edge
  const green = agreement(greenAsRed(img), /** @type {any} */ (mapper), scene, 4);
  console.error(`crt full look: green wrong=${green.wrong} of ${green.decided}`);
  assert.ok(green.wrong <= 5, `${green.wrong} wrong px`);
});

gpuTest('flicker and rolling bar animate brightness only: two instants of the animation share one mapper', async (t) => {
  const a = await presentOnce(t, plugin, { ...GEOMETRY, flicker: 1 }, { scene, offsetMs: 80 });
  const b = await presentOnce(t, plugin, { ...GEOMETRY, flicker: 1 }, { scene, offsetMs: 2900 });
  const wa = agreement(a.img, /** @type {any} */ (a.mapper), scene).wrong;
  const wb = agreement(b.img, /** @type {any} */ (a.mapper), scene).wrong;
  assert.ok(wa <= 5 && wb <= 5, `${wa} / ${wb} wrong px`);
});

gpuTest('device loss: the host re-creates the plugin on a new device and the screen is drawn and mapped again', async (t) => {
  /** @type {any[]} */ const devices = [];
  const def = definePlugin({ ...plugin, async create(/** @type {any} */ ctx, /** @type {any} */ o) { devices.push(ctx.device); return plugin.create(ctx, o); } });
  const { rig, mappers } = await presentOnce(t, def, GEOMETRY, { scene });
  const before = mappers.length;
  devices[0].destroy();
  const until = performance.now() + 5000;
  while (devices.length < 2 && performance.now() < until) await new Promise((ok) => setTimeout(ok, 20));
  assert.equal(devices.length, 2, 'create() ran again on a new device');
  await new Promise((ok) => setTimeout(ok, 50));
  rig.tick(performance.now() + 50);
  const img = rig.snap();
  assert.ok(mappers.length > before, 'a frame was presented after the loss');
  const v = agreement(img, /** @type {any} */ (mappers.at(-1)), scene);
  assert.ok(v.bright > scene.centres.length * 60, `the frame after the loss is drawn (${v.bright} bright px)`);
  assert.ok(v.wrong <= 5, `and its mapper fits it: ${v.wrong} wrong px`);
});

gpuTest('GPU time of the pass at the gallery size (1100 x 620 CSS px, DPR 2): well inside a 120 Hz frame', async () => {
  const r = await measureGpuTime(plugin, {});
  console.error(`crt GPU time ${r.w}x${r.h}: ${r.meanMs.toFixed(3)} ms/frame (clear-only pass ${r.baselineMs.toFixed(3)} ms), ${r.frames} frames back to back`);
  assert.ok(r.meanMs < 2, `${r.meanMs.toFixed(3)} ms per frame`);
});
