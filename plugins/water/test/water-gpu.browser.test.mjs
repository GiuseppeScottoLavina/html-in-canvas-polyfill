// The water input mapper against the pixels the GPU really produced (not against its own formula), through the shared plugin kit; the
// actions 'drop' and 'demo' through the effect handle; zero work at rest; the light (caustics and reflections) on a uniform page.
import { assert } from '/test/unit/lib/t.js';
import { agreement, changedPixels, checkMapperAgainstGpu, gpuAvailable, gpuTest, identity, markerScene, presentOnce, runActionOnGpu } from '/plugins/_shared/gpu-check.mjs';
import { plugin } from '/plugins/water/index.js';

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
  assert.ok((settledAt - f0) / 60 < 4, `it settled within 4 s of the frame clock (${((settledAt - f0) / 60).toFixed(2)} s)`);
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

gpuTest('the action drop through the effect handle: a drop moves pixels around its point, the frame agrees with its mapper, it resolves calm', async (t) => {
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
  let near = 0;
  for (let y = 100; y < 220; y += 1) for (let x = 180; x < 300; x += 1) { const k = (y * img.width + x) * 4; if (Math.abs(img.data[k] - quietLater.data[k]) > 16) near += 1; }
  console.error(`water action: idle drift ${idle} px in 250 ms, the drop ${moved} px (${near} within 60 px of its point)`);
  assert.equal(idle, 0, 'nothing moves at rest');
  assert.ok(moved > 500 && near > 60, `the drop moved pixels: ${moved}, near its point ${near}`);
  const a = agreement(img, /** @type {any} */ (mappers.at(-1)), scene);
  assert.ok(a.wrong <= 5, `the frame of the drop disagrees with its mapper on ${a.wrong} px`);
  for (let i = 0; i < 120 && state === null; i += 1) { tick(); await later(); }
  assert.equal(state, 'calm', 'it resolves once the surface is flat again');
});

gpuTest('the action demo: rain changes the picture, every checked frame agrees with its mapper, it resolves calm within about 4 s at the default intensity and ends at rest', async (t) => {
  const r = await runActionOnGpu(t, plugin, { intensity: 0.5 }, 'demo', {}, { scene, stepMs: 1000 / 60, maxMs: 7000, checkEvery: 6 });
  const ms = (r.frames * 1000) / 60;
  console.error(`water demo: ${r.frames} frames (${Math.round(ms)} ms), max changed ${r.maxChanged} px, worst mapper disagreement ${r.worst?.wrong} px of ${r.worst?.decided} (${r.checked} frames checked)`);
  assert.equal(r.state, 'calm');
  assert.ok(ms < 4600, `the demo ends at rest after ${Math.round(ms)} ms`);
  assert.ok(r.maxChanged > 1500, `it rains: ${r.maxChanged} px changed`);
  assert.ok(r.worst && r.worst.wrong <= 5, `input follows the pixels while it rains: ${r.worst?.wrong} px disagree`);
  assert.ok(changedPixels(r.last, r.first) <= 2, 'it ends at rest: the last frame is the still picture');
});
