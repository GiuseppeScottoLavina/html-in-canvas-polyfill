// The CRT input mapper against the pixels the GPU really produced (plugins/_shared/gpu-check.mjs), with the interlaced fields on (both
// fields, the combing of a moved source), device loss, and the GPU time.
import { assert } from '/test/unit/lib/t.js';
import { agreement, checkMapperAgainstGpu, gpuAvailable, gpuTest, markerScene, presentOnce } from '/plugins/_shared/gpu-check.mjs';
import { definePlugin } from '/src/effects/plugin-abi.js';
import { FIELD_HZ, UNIFORM_FLOATS, bezelWidth, cornerRadius, mapCrtPoint, plugin } from '/plugins/crt/index.js';
import { measureGpuTime } from '/plugins/_shared/gpu-time.mjs';

console.error(`crt gpu tests: WebGPU ${(await gpuAvailable()) ? 'available' : 'NOT available'}`);

const scene = markerScene({ w: 480, h: 320 });
/** geometry only: no glow halo, no misconvergence fringes, no flicker, so "bright" is decided by the sampled point alone */
const GEOMETRY = { curvature: 0.6, scanlines: 0.6, glow: 0, flicker: 0, misconvergence: 0, interlace: true };

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
  // curvature 0.6 without interlace (2818 of 3500 px, headless Chrome 154, Apple M1 Max). Interlaced, every other line is the previous
  // field at about 0.7 of the brightness, and each line samples the source at its own centre, so the partly covered edge pixels of a
  // marker fall under the "bright" threshold more often: 2365 of 3500 px (0.68; Chrome 155, 2026-10-14). The share is 0.6; the other two
  // conditions (mapper at most 5 wrong px, identity at least 200) are the kit's, and interlace is ON here (the gallery default).
  const v = await checkMapperAgainstGpu(t, plugin, GEOMETRY, { scene, minBrightShare: 0.6 });
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

gpuTest('interlace: the two fields are visibly different pictures (alternating lines) and the one mapper predicts both; interlace off presents the same geometry', async (t) => {
  const { rig, img, mapper } = await presentOnce(t, plugin, GEOMETRY, { scene });
  const t0 = performance.now() + 500;
  rig.tick(t0);
  const a = rig.snap();
  rig.tick(t0 + 1000 / FIELD_HZ);
  const b = rig.snap();
  let differ = 0;
  for (let i = 0; i < a.data.length; i += 4) if (Math.abs(a.data[i] - b.data[i]) > 24) differ += 1;
  const wa = agreement(a, /** @type {any} */ (mapper), scene);
  const wb = agreement(b, /** @type {any} */ (mapper), scene);
  console.error(`crt interlace: ${differ} px differ between consecutive fields; mapper wrong ${wa.wrong} / ${wb.wrong} (bright ${wa.bright} / ${wb.bright})`);
  assert.ok(differ > 600, `consecutive fields differ on ${differ} px`);
  assert.ok(wa.wrong <= 5 && wb.wrong <= 5 && agreement(img, /** @type {any} */ (mapper), scene).wrong <= 5, `${wa.wrong} / ${wb.wrong} wrong px`);
  const off = await presentOnce(t, plugin, { ...GEOMETRY, interlace: false }, { scene });
  assert.ok(agreement(off.img, /** @type {any} */ (mapper), scene).wrong <= 5, 'the mapper of the interlaced frame also fits the progressive one');
});

gpuTest('interlace combing: right after the source moves, the old field still shows it where it was; one field later the picture has caught up', async (t) => {
  const moved = markerScene({ w: 480, h: 320, first: { x: 66, y: 40 } });
  const { rig, mapper } = await presentOnce(t, plugin, GEOMETRY, { scene });
  const t0 = performance.now() + 500;
  rig.tick(t0);                                   // the history now holds `scene`
  rig.commit(null, moved.paint);                  // the markers move 6 px to the right
  rig.tick(t0 + 1000 / FIELD_HZ);
  const comb = rig.snap();
  rig.tick(t0 + 2000 / FIELD_HZ);
  const caught = rig.snap();
  /** bright pixels whose source point is inside a marker of `inScene` and clearly outside every marker of `outScene` */
  const only = (/** @type {ImageData} */ img, /** @type {any} */ inScene, /** @type {any} */ outScene) => {
    let n = 0;
    for (let j = 0; j < img.height; j += 1) {
      for (let i = 0; i < img.width; i += 1) {
        const m = /** @type {any} */ (mapper)({ x: i + 0.5, y: j + 0.5, width: img.width, height: img.height });
        if (img.data[(j * img.width + i) * 4] > 110 && inScene.distance(m.x, m.y) < -1.25 && outScene.distance(m.x, m.y) > 1.25) n += 1;
      }
    }
    return n;
  };
  const oldInComb = only(comb, scene, moved), newInComb = only(comb, moved, scene), oldLater = only(caught, scene, moved), newLater = only(caught, moved, scene);
  console.error(`crt combing: moved frame old-only ${oldInComb} px, new-only ${newInComb} px; one field later old-only ${oldLater}, new-only ${newLater}`);
  assert.ok(oldInComb > 150 && newInComb > 150, 'the moved frame combs: lines of the old position and of the new one');
  assert.ok(oldLater <= 5 && newLater > 300, 'one field later only the new position is drawn');
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
