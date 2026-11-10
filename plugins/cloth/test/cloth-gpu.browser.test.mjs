// The cloth plugin on the real GPU (headless Chrome, the real effects host): its input mapper against the pixels the GPU produced
// (plugins/_shared/gpu-check.mjs), with the identity and the mapper of a frame a few steps earlier as controls; the cloth at rest is the
// page, pixel for pixel; each action through the effect handle; a device loss while the cloth is held; and the GPU time.
import { assert } from '/test/unit/lib/t.js';
import { agreement, changedPixels, checkMapperAgainstGpu, gpuAvailable, gpuTest, identity, lossSpy, markerScene, presentOnce, runActionOnGpu, until } from '/plugins/_shared/gpu-check.mjs';
import { isNoTarget, meta, plugin, stateOf } from '/plugins/cloth/index.js';
import { CLOTH, FLAT, S } from '/plugins/cloth/surface.js';
import { measurePassGpuTime } from '/plugins/_shared/gpu-time.mjs';
import { plugin as template } from '/plugins/_template/index.js';

console.error(`cloth-gpu tests: WebGPU ${(await gpuAvailable()) ? 'available' : 'NOT available'}`);

const W = 480;
const H = 320;
const scene = markerScene({ w: W, h: H });
// The oracle calls a pixel bright when its red channel is over 110. For the mapper checks the cloth is lit evenly (no shadow, no sheen)
// and its back is dark, so that a bright pixel can only be a white marker on the printed side, whatever fold it lies in.
const PLAIN = { ...meta.defaults, shadow: 0, sheen: 0, through: 0.04, back: '#000' };

/** @param {any} rig @param {string} type @param {number[]} at @param {number} [buttons] */
function pointer(rig, type, [x, y], buttons = 1) {
  const r = rig.canvas.getBoundingClientRect();
  rig.layerEl.dispatchEvent(new PointerEvent(type, { bubbles: true, composed: true, cancelable: true, isPrimary: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons, clientX: r.left + x, clientY: r.top + y }));
}
/**
 * Take the cloth at `from` and pull it to `to` over `ms` of the frame clock, presenting a frame every 16 ms (synthetic events reach the
 * plugin's capture listeners like trusted ones). The clock runs up to now, so the frame that the test presents next follows on it.
 * @param {number[]} from @param {number[]} to @param {number} [ms]
 */
const pull = (from, to, ms = 640) => (/** @type {any} */ rig) => {
  const frames = Math.round(ms / 16), t0 = performance.now() - frames * 16;
  pointer(rig, 'pointerdown', from);
  for (let k = 1; k <= frames; k += 1) {
    const f = Math.min(1, k / (frames * 0.6));
    pointer(rig, 'pointermove', [from[0] + (to[0] - from[0]) * f, from[1] + (to[1] - from[1]) * f]);
    rig.tick(t0 + k * 16);
  }
};
const CORNER = [470, 312];
const LIFTED = [300, 150];

gpuTest('held and pulled: the mapper predicts every presented pixel (the page point on the printed side, no target on the back and on the wall); identity does not', async (t) => {
  // minBrightShare 0.5: the lifted corner shows its back, and the wall shows where it was
  const v = await checkMapperAgainstGpu(t, plugin, PLAIN, { scene, before: pull(CORNER, LIFTED), minBrightShare: 0.5 });
  console.error(`cloth mapper vs GPU (pulled): decided=${v.real.decided} wrong=${v.real.wrong} bright=${v.real.bright} | identity wrong=${v.identity.wrong}`);
  assert.ok(v.ok, v.why);
});

gpuTest('the frame shows the lifted cloth: its back and the wall are no target, and the mapper of a frame 100 ms earlier is measurably wrong on it', async (t) => {
  const { img, mappers } = await presentOnce(t, plugin, PLAIN, { scene, before: pull(CORNER, LIFTED, 480) });
  const mapper = /** @type {any} */ (mappers.at(-1));
  // (the plugin keeps 4 mapper states: the mapper of 6 frames earlier answers from a copy taken while its frame was the newest)
  assert.equal(stateOf(mapper)?.[S.MODE], CLOTH);
  const good = agreement(img, mapper, scene).wrong;
  let none = 0, mapped = 0;
  for (let y = 4; y < H; y += 8) for (let x = 4; x < W; x += 8) { if (isNoTarget(mapper({ x, y, width: W, height: H }))) none += 1; else mapped += 1; }
  assert.ok(none > 60 && mapped > 1200, `no target at ${none} of ${none + mapped} places`);
  assert.ok(isNoTarget(mapper({ x: W - 3, y: H - 3, width: W, height: H })), 'where the corner hung, the wall shows');
  // control: the same pull, seen 100 ms earlier in its course
  const early = await presentOnce(t, plugin, PLAIN, { scene, before: pull(CORNER, LIFTED, 380) });
  const wrong = agreement(img, /** @type {any} */ (early.mappers.at(-1)), scene).wrong;
  console.error(`cloth: the frame's mapper ${good} wrong px, the mapper of the pull 100 ms earlier ${wrong}`);
  assert.ok(good <= 5 && wrong >= 40 && wrong > 8 * Math.max(1, good), `this frame ${good}, 100 ms earlier ${wrong}`);
});

/** a page with every level of grey, colour ramps and thin lines: what a resampling, a wrong gamma or a dither would change */
const picture = {
  w: W, h: H, centres: [], size: 0, distance: () => 1e9,
  /** @param {CanvasRenderingContext2D} ctx */
  paint(ctx) {
    for (let x = 0; x < W; x += 1) { const v = Math.round((x / (W - 1)) * 255); ctx.fillStyle = `rgb(${v},${v},${v})`; ctx.fillRect(x, 0, 1, 80); ctx.fillStyle = `rgb(${v},${255 - v},${(v * 7) % 256})`; ctx.fillRect(x, 80, 1, 80); }
    ctx.fillStyle = '#03101c'; ctx.fillRect(0, 160, W, 160);
    ctx.fillStyle = '#edfaff'; ctx.font = '13px system-ui'; ctx.fillText('The cloth at rest shows the page itself: 0123456789', 12, 200);
    for (let x = 10; x < W; x += 3) ctx.fillRect(x, 230, 1, 30);
    for (let y = 270; y < H; y += 2) ctx.fillRect(0, y, W, 1);
  },
};
/** the source as the host uploads it (the picture is opaque) @param {any} rig */
const sourcePixels = (rig) => rig.ctx.getImageData(0, 0, W, H);
/** pixels that differ in any channel, and the largest difference @param {ImageData} a @param {ImageData} b */
function difference(a, b) {
  let count = 0, most = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
    if (d > 0) count += 1;
    if (d > most) most = d;
  }
  return { count, most };
}

gpuTest('at rest the presented frame is the page, pixel for pixel, with the default look; after a gust has died out it is the page again, and no frame is asked for', async (t) => {
  const { rig, host, handle, img, mapper, at } = await presentOnce(t, plugin, { ...meta.defaults }, { scene: /** @type {any} */ (picture) });
  const source = sourcePixels(rig);
  const rest = difference(img, source);
  assert.deepEqual(rest, { count: 0, most: 0 }, `at rest ${rest.count} pixels differ from the page (by up to ${rest.most} levels)`);
  assert.equal(stateOf(/** @type {any} */ (mapper))?.[S.MODE], FLAT);
  // a gust: frames on the frame clock until the handle reports rest
  /** @type {any} */ let state;
  handle.trigger('gust', { strength: 1.2 }).then((/** @type {any} */ s) => { state = s; });
  let now = at + 100, moved = 0, frames = 0;
  while (state === undefined && now < at + 8000) {
    rig.tick(now); now += 1000 / 60; frames += 1;
    if (frames === 30) moved = difference(rig.snap(), source).count;
    await new Promise((r) => setTimeout(r, 0));
  }
  assert.equal(state, 'hanging');
  assert.ok(moved > 0.2 * W * H, `control: half a second into the gust ${moved} pixels differ from the page`);
  const f0 = host.stats().frames;
  rig.tick(now + 100);
  rig.tick(now + 200);
  assert.equal(host.stats().frames, f0, 'the host presents nothing more: the plugin is not continuous and asked for no frame');
  // a new version of the page is presented by the flat pass again: the page, exactly
  rig.commit();
  rig.tick(now + 300);
  const again = difference(rig.snap(), sourcePixels(rig));
  assert.deepEqual(again, { count: 0, most: 0 }, `after the gust ${again.count} pixels differ from the page (by up to ${again.most} levels)`);
}, { timeout: 30000 });

gpuTest('the cloth drawn as a mesh, a hair off its plane, is the page too: it differs from the page by at most a few levels at edges', async (t) => {
  // through the mesh pipeline: a pointer that has moved 8 px has pushed the cloth, and 4 ms later the dent is a fraction of a pixel deep
  const nudge = (/** @type {any} */ rig) => { rig.tick(performance.now() - 20); pointer(rig, 'pointermove', [200, 150], 0); pointer(rig, 'pointermove', [208, 150], 0); };
  const { rig, img, mapper } = await presentOnce(t, plugin, { ...meta.defaults }, { scene: /** @type {any} */ (picture), before: nudge, offsetMs: 4 });
  assert.equal(stateOf(/** @type {any} */ (mapper))?.[S.MODE], CLOTH, 'this frame is drawn as cloth');
  const d = difference(img, sourcePixels(rig));
  console.error(`cloth flat mesh vs page: ${d.count} of ${W * H} pixels differ, by at most ${d.most} levels`);
  assert.ok(d.most <= 3, `${d.count} pixels differ, by up to ${d.most} levels`);
});

gpuTest('the action gust through the effect handle: the cloth billows, every checked frame agrees with its mapper, it resolves hanging on the page', async (t) => {
  const r = await runActionOnGpu(t, plugin, PLAIN, 'gust', { direction: 0, strength: 1.3 }, { scene, maxMs: 7000, checkEvery: 12 });
  console.error(`cloth gust: ${r.frames} frames, ${r.checked} checked, at most ${r.maxChanged} px changed, worst mapper ${r.worst?.wrong} px wrong`);
  assert.equal(r.state, 'hanging');
  assert.ok(r.maxChanged > 800, `the cloth moved: ${r.maxChanged} px changed`);
  assert.ok(r.worst !== null && r.checked >= 6 && r.worst.wrong <= 8, `a frame of the gust disagrees with its mapper on ${r.worst?.wrong} px`);
  assert.equal(changedPixels(r.last, r.first), 0, 'back on the page');
}, { timeout: 60000 });

gpuTest('the action demo: resolves hanging within 4 s of the frame clock, and the last frame is the first', async (t) => {
  const r = await runActionOnGpu(t, plugin, PLAIN, 'demo', undefined, { scene, maxMs: 7000, checkEvery: 20 });
  console.error(`cloth demo: ${r.frames} frames (${(r.frames / 60).toFixed(2)} s), at most ${r.maxChanged} px changed, worst mapper ${r.worst?.wrong} px wrong`);
  assert.equal(r.state, 'hanging');
  assert.ok(r.frames <= 4 * 60, `the demo took ${(r.frames / 60).toFixed(2)} s`);
  assert.ok(r.maxChanged > 800 && r.worst !== null && r.worst.wrong <= 8);
  assert.equal(changedPixels(r.last, r.first), 0);
}, { timeout: 60000 });

gpuTest('the actions drop and in: the cloth peels off and falls (every checked frame agrees with its mapper), the bare wall is no target; hung again, the frame is the page', async (t) => {
  const r = await runActionOnGpu(t, plugin, PLAIN, 'drop', undefined, { scene, maxMs: 5000, checkEvery: 6 });
  console.error(`cloth drop: ${r.frames} frames, ${r.checked} checked, worst mapper ${r.worst?.wrong} px wrong`);
  assert.equal(r.state, 'dropped');
  assert.ok(r.worst !== null && r.checked >= 3 && r.worst.wrong <= 8, `a frame of the fall disagrees with its mapper on ${r.worst?.wrong} px`);
  // the wall: no marker anywhere, and no target
  let bright = 0;
  for (let i = 0; i < r.last.data.length; i += 4) if (r.last.data[i] > 110) bright += 1;
  assert.equal(bright, 0, 'the wall shows no marker');
  const gone = /** @type {any} */ (r.handle);
  assert.equal(await gone.settled(), 'dropped');
  /** @type {any} */ let state;
  gone.trigger('in').then((/** @type {any} */ s) => { state = s; });
  let now = performance.now() + 100, frames = 0, last = r.last;
  while (state === undefined && frames < 600) { r.rig.tick(now); now += 1000 / 60; frames += 1; last = r.rig.snap(); await new Promise((res) => setTimeout(res, 0)); }
  assert.equal(state, 'hanging');
  assert.ok(frames < 5 * 60, `hung again in ${(frames / 60).toFixed(2)} s`);
  assert.equal(changedPixels(last, r.first), 0, 'the page again');
}, { timeout: 60000 });

gpuTest('device loss while the cloth is held: the host re-creates the plugin on a new device, the old instance is destroyed, the new one presents the flat page with an identity mapper', async (t) => {
  const { spy, log } = lossSpy(plugin);
  const { rig, mappers } = await presentOnce(t, spy, PLAIN, { scene, before: pull(CORNER, LIFTED) });
  assert.ok(isNoTarget(/** @type {any} */ (mappers.at(-1))({ x: W - 3, y: H - 3, width: W, height: H })), 'held before the loss');
  log.devices[0].destroy();
  await until(() => log.devices.length >= 2, 3000);
  assert.equal(log.devices.length, 2, 'create() ran again');
  assert.notEqual(log.devices[1], log.devices[0]);
  assert.equal(log.destroyed, 1, 'the old instance (and its document listeners) was destroyed');
  pointer(rig, 'pointerup', LIFTED, 0);   // the gesture of the lost instance ends; the new instance never saw it
  rig.tick(performance.now() + 50);
  rig.tick(performance.now() + 100);
  const img = rig.snap();
  const real = agreement(img, /** @type {any} */ (mappers.at(-1)), scene);
  const id = agreement(img, identity, scene);
  assert.ok(real.bright > 3000 && real.wrong <= 5 && id.wrong <= 5, `after recovery: mapper ${real.wrong}, identity ${id.wrong}, bright ${real.bright}`);
});

gpuTest('GPU time at 2560x1600 (1280x800 CSS px, DPR 2), 240 frames on a 120 Hz clock, the cloth in a gust (shadow passes, the tessellated sheet, 4x MSAA); the template pass as baseline', async () => {
  const o = { cssWidth: 1280, cssHeight: 800, dpr: 2 };
  const blown = { ...o, before(/** @type {HTMLCanvasElement} */ _canvas, /** @type {any} */ instance) { instance.runAction('gust', { strength: 1.5 }, { reducedMotion: false }); } };
  const base = await measurePassGpuTime(template, { offset: 24 }, o);
  const rest = await measurePassGpuTime(plugin, { ...meta.defaults }, o);
  const m = await measurePassGpuTime(plugin, { ...meta.defaults }, blown);
  if (!m || !base || !rest) { console.error('cloth GPU time: timestamp-query not available, NOT measured'); return; }
  console.error(`cloth GPU time (${m.adapter}): in a gust, back-to-back ${m.throughputMs.toFixed(3)} ms/frame; at rest (the flat pass) ${rest.throughputMs.toFixed(3)}; template ${base.throughputMs.toFixed(3)} (${m.width}x${m.height}, 120 Hz budget ${m.budgetMs.toFixed(2)} ms)`);
  assert.ok(m.throughputMs < m.budgetMs / 2, `back-to-back ${m.throughputMs} ms: more than half of the 120 Hz frame`);
}, { timeout: 60000 });
