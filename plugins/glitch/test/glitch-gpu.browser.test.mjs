// The glitch input mapper against the pixels the GPU really produced (plugins/_shared/gpu-check.mjs): the displacement alone with the
// shared check, then every layer on (split, sort streaks, grain, scanlines) read on the green channel, which the split does not move;
// a wrong-mapper control (the next pattern of the same burst); the ambient mode; the GPU time of the pass.
import { assert } from '/test/unit/lib/t.js';
import { agreement, checkMapperAgainstGpu, gpuAvailable, gpuTest, identity, markerScene, presentOnce } from '/plugins/_shared/gpu-check.mjs';
import { HEADER_FLOATS, PATTERN_MS, UNIFORM_FLOATS, fillGlitchFrame, mapGlitchPoint, meta, plugin } from '/plugins/glitch/index.js';
import { measurePassGpuTime } from '/plugins/_shared/gpu-time.mjs';
import { plugin as template } from '/plugins/_template/index.js';

console.error(`glitch-gpu tests: WebGPU ${(await gpuAvailable()) ? 'available' : 'NOT available'}`);

const W = 480;
const H = 320;
const scene = markerScene({ w: W, h: H });
const BURST = { mode: 'burst', intensity: 1, seed: 3 };
/** a validation error in the page: the `invalid` event the plugin listens for */
const invalid = (/** @type {any} */ rig) => rig.source.dispatchEvent(new Event('invalid'));

/** The uniform block of the burst frame `e` ms after its start, as the plugin computes it (first burst of the instance). */
function burstState(/** @type {Record<string, unknown>} */ o, /** @type {number} */ e) {
  const u = new Float32Array(UNIFORM_FLOATS);
  fillGlitchFrame(u, {
    width: W, height: H, cssWidth: W, cssHeight: H, now: 1000 + e, ready: true, mode: 'burst', intensity: 1, seed: 3, burstAt: 1000, burstSerial: 1,
    reduced: false, split: true, sort: true, noise: true, .../** @type {any} */ (o),
  });
  return u;
}

/** the image with its green channel copied into red (the shared oracle reads red; the RGB split moves red and blue, never green) */
function greenAsRed(/** @type {ImageData} */ img) {
  const out = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  for (let i = 0; i < out.data.length; i += 4) out.data[i] = out.data[i + 1];
  return out;
}

gpuTest('burst, displacement alone: the mapper predicts every presented pixel; identity does not (positive control)', async (t) => {
  const v = await checkMapperAgainstGpu(t, plugin, { ...BURST, split: false, sort: false, noise: false }, { scene, before: invalid });
  console.error(`glitch mapper vs GPU (displacement): decided=${v.real.decided} wrong=${v.real.wrong} bright=${v.real.bright} | identity wrong=${v.identity.wrong}`);
  assert.ok(v.ok, v.why);
});

gpuTest('burst, every layer on: the mapper predicts every pixel outside the sort streaks (green channel); identity does not', async (t) => {
  const { img, mapper } = await presentOnce(t, plugin, { ...BURST }, { scene, before: invalid });
  const u = burstState({}, 0);
  for (let i = 0; i < 300; i += 1) {
    const p = { x: (i * 37) % W + 0.5, y: (i * 53) % H + 0.5, width: W, height: H };
    assert.deepEqual(/** @type {any} */ (mapper)(p), mapGlitchPoint(u, p), 'the presented frame is the first pattern of the burst');
  }
  /** pixels inside a sort streak show the brightest pixel above them: the mapper makes no claim about their colour */
  const streak = (/** @type {number} */ x, /** @type {number} */ y) => {
    for (let i = 0; i < u[8]; i += 1) {
      const b = HEADER_FLOATS + 8 * i;
      if (u[b + 6] > 0.5 && x >= u[b] && y >= u[b + 1] && x < u[b + 2] && y < u[b + 3]) return true;
    }
    return false;
  };
  const green = greenAsRed(img);
  const masked = (/** @type {any} */ map) => (/** @type {any} */ p) => (streak(p.x, p.y) ? { x: -1000, y: -1000 } : map(p));
  const blank = new ImageData(new Uint8ClampedArray(green.data), W, H);
  for (let j = 0; j < H; j += 1) for (let i = 0; i < W; i += 1) if (streak(i + 0.5, j + 0.5)) blank.data[(j * W + i) * 4] = 0;
  const real = agreement(blank, masked(mapper), scene);
  const flat = agreement(blank, masked(identity), scene);
  const streaks = Array.from({ length: u[8] }, (_, i) => u[HEADER_FLOATS + 8 * i + 6]).filter((k) => k > 0.5).length;
  console.error(`glitch mapper vs GPU (all layers, green): decided=${real.decided} wrong=${real.wrong} | identity wrong=${flat.wrong}; ${streaks} sort streaks masked`);
  assert.ok(streaks > 0, 'the frame has sort streaks');
  assert.ok(real.bright > 2000 && real.wrong <= 5 && flat.wrong >= 200, `mapper ${real.wrong}, identity ${flat.wrong}`);
});

gpuTest('a mapper of the next pattern of the same burst is measurably wrong on this frame (wrong-mapper control)', async (t) => {
  const options = { ...BURST, split: false, sort: false, noise: false };
  const { img, mapper } = await presentOnce(t, plugin, options, { scene, before: invalid });
  const next = burstState(options, PATTERN_MS);
  const good = agreement(img, /** @type {any} */ (mapper), scene).wrong;
  const wrong = agreement(img, (p) => mapGlitchPoint(next, p), scene).wrong;
  console.error(`glitch: this pattern's mapper ${good} wrong px, the next pattern's ${wrong}`);
  assert.ok(good <= 5 && wrong >= 200, `this pattern ${good}, next pattern ${wrong}`);
});

gpuTest('ambient: whatever the instant (micro-glitch or not), the presented frame agrees with its mapper', async (t) => {
  for (const offsetMs of [80, 400, 900]) {
    const { img, mapper } = await presentOnce(t, plugin, { ...meta.defaults }, { scene, offsetMs });
    const real = agreement(img, /** @type {any} */ (mapper), scene);
    assert.ok(real.bright > 2000 && real.wrong <= 5, `ambient at +${offsetMs} ms: ${real.wrong} wrong px`);
  }
});

/** Wraps a definition: records every created instance's device and counts destroy() calls (device-loss tests). @param {any} def */
function lossSpy(def) {
  const log = { devices: /** @type {any[]} */ ([]), destroyed: 0 };
  const spy = Object.freeze({
    ...def,
    async create(/** @type {any} */ ctx, /** @type {any} */ o) {
      log.devices.push(ctx.device);
      const inst = await def.create(ctx, o);
      return { ...inst, destroy() { log.destroyed += 1; inst.destroy?.(); } };
    },
  });
  return { spy, log };
}

gpuTest('device loss mid-burst: the host re-creates the plugin on a new device, the old instance is destroyed, the new one presents frames that agree with its mapper', async (t) => {
  const { spy, log } = lossSpy(plugin);
  const { rig, mappers } = await presentOnce(t, spy, { ...BURST, split: false, sort: false, noise: false }, { scene, before: invalid });
  log.devices[0].destroy();
  for (let i = 0; i < 300 && log.devices.length < 2; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.equal(log.devices.length, 2, 'create() ran again');
  assert.equal(log.destroyed, 1, 'the old instance (observer, listeners) was destroyed');
  rig.source.dispatchEvent(new Event('invalid'));   // the validation hook of the new instance works (a burst on its next frame)
  rig.tick(performance.now() + 300);
  const img = rig.snap();
  const real = agreement(img, /** @type {any} */ (mappers.at(-1)), scene);
  const id = agreement(img, identity, scene);
  assert.ok(real.bright > 2000 && real.wrong <= 5 && id.wrong >= 200, `after recovery: mapper ${real.wrong}, identity ${id.wrong}`);
});

gpuTest('GPU time of the pass at 2200x1240 (1100x620 CSS px, DPR 2), 240 burst frames with every layer on; the template pass as baseline', async () => {
  const base = await measurePassGpuTime(template, { offset: 24 });
  // the clock advances 2 ms per frame so that all 240 measured frames fall inside the 520 ms burst (the most expensive frames)
  const m = await measurePassGpuTime(plugin, { ...BURST }, { clockMs: 2, before: (_canvas, instance) => instance.setOptions({ ...BURST, trigger: 1 }) });
  if (!m || !base) { console.error('glitch GPU time: timestamp-query not available, NOT measured'); return; }
  console.error(`glitch GPU time (${m.adapter}): back-to-back ${m.throughputMs.toFixed(3)} ms/frame (template ${base.throughputMs.toFixed(3)}); pass timestamps median ${m.medianMs.toFixed(3)} ms, p95 ${m.p95Ms.toFixed(3)} ms, max ${m.maxMs.toFixed(3)} ms; template pass median ${base.medianMs.toFixed(3)} ms, p95 ${base.p95Ms.toFixed(3)} ms (${m.width}x${m.height}, 120 Hz budget ${m.budgetMs.toFixed(2)} ms)`);
  assert.ok(m.p95Ms < m.budgetMs / 2 && m.throughputMs < m.budgetMs / 2, `p95 ${m.p95Ms} ms / back-to-back ${m.throughputMs} ms: more than half of the 120 Hz frame`);
});
