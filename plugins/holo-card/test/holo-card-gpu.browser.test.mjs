// The holo-card input mapper against the pixels the GPU really produced (plugins/_shared/gpu-check.mjs), a card tilting on its spring,
// device loss, and the GPU time of the pass.
import { assert } from '/test/unit/lib/t.js';
import { agreement, checkMapperAgainstGpu, gpuAvailable, gpuTest, markerScene, presentOnce, until } from '/plugins/_shared/gpu-check.mjs';
import { definePlugin } from '/src/effects/plugin-abi.js';
import { UNIFORM_FLOATS, mapCardPoint, plugin, writeCardPose } from '/plugins/holo-card/index.js';
import { measureGpuTime } from '/plugins/_shared/gpu-time.mjs';

console.error(`holo-card gpu tests: WebGPU ${(await gpuAvailable()) ? 'available' : 'NOT available'}`);

const scene = markerScene({ w: 480, h: 320 });
/** geometry only: no foil, no glare, so "bright" is decided by the sampled point alone. Idle sway gives a tilted pose at the first frame. */
const GEOMETRY = { tilt: 30, foil: 0, glare: 0, idle: true };

gpuTest('a tilted card: every presented pixel samples the source point the perspective mapper says; identity does not (positive control)', async (t) => {
  // the card is drawn at 0.86 of the canvas and tilted, so markers are smaller than painted: "markers visible" share 0.6 instead of 0.8
  const v = await checkMapperAgainstGpu(t, plugin, GEOMETRY, { scene, minBrightShare: 0.6 });
  console.error(`holo-card mapper vs GPU: decided=${v.real.decided} wrong=${v.real.wrong} bright=${v.real.bright} | identity wrong=${v.identity.wrong}`);
  assert.ok(v.ok, v.why);
});

gpuTest('the oracle is sensitive to the pose: the flat card (no tilt, same scale) disagrees with the tilted pixels', async (t) => {
  const { img, mapper } = await presentOnce(t, plugin, GEOMETRY, { scene });
  const flat = new Float32Array(UNIFORM_FLOATS);
  flat[2] = 480; flat[3] = 320;
  writeCardPose(flat, 0, 0, 0.86, 480, 320);
  const good = agreement(img, /** @type {any} */ (mapper), scene).wrong;
  const bad = agreement(img, (p) => mapCardPoint(flat, p), scene).wrong;
  assert.ok(good <= 5, `the plugin's mapper: ${good} wrong px`);
  assert.ok(bad > 100, `the flat card: ${bad} wrong px`);
});

gpuTest('the card tilting on its spring towards the pointer: the newest mapper still predicts every pixel', async (t) => {
  const { rig, mappers } = await presentOnce(t, plugin, { ...GEOMETRY, idle: false }, { scene });
  const r = rig.canvas.getBoundingClientRect();
  const t0 = performance.now();
  for (let k = 1; k <= 6; k += 1) {   // the pointer moves to the lower right; each move asks for a frame
    rig.layerEl.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r.left + 240 + k * 35, clientY: r.top + 160 + k * 22 }));
    rig.tick(t0 + 100 + k * 16);
  }
  const img = rig.snap();
  const moving = agreement(img, /** @type {any} */ (mappers.at(-1)), scene);
  const first = agreement(img, /** @type {any} */ (mappers[0]), scene);
  console.error(`holo-card tilting (${mappers.length} frames): newest wrong=${moving.wrong}, first-frame mapper wrong=${first.wrong}`);
  assert.ok(moving.wrong <= 5, `${moving.wrong} wrong px`);
  assert.ok(first.wrong > 100, 'the card really moved: the mapper of the first frame no longer fits');
});

gpuTest('device loss: the host re-creates the plugin on a new device and the card is drawn and mapped again', async (t) => {
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
  assert.ok(v.bright > scene.centres.length * 50, `the frame after the loss is drawn (${v.bright} bright px)`);
  assert.ok(v.wrong <= 5, `and its mapper fits it: ${v.wrong} wrong px`);
});

gpuTest('GPU time of the pass at the gallery size (1100 x 620 CSS px, DPR 2): well inside a 120 Hz frame', async () => {
  const r = await measureGpuTime(plugin, {});
  console.error(`holo-card GPU time ${r.w}x${r.h}: ${r.meanMs.toFixed(3)} ms/frame (clear-only pass ${r.baselineMs.toFixed(3)} ms), ${r.frames} frames back to back`);
  assert.ok(r.meanMs < 2, `${r.meanMs.toFixed(3)} ms per frame`);
});
