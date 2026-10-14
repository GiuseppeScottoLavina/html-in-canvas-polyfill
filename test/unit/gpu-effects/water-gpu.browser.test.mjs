// The water input mapper against the pixels the GPU really produced (not against its own formula).
import { test, assert } from '/test/unit/lib/t.js';
import { gpuAvailable, makeRig } from './lib/rig.mjs';
import { createEffectHost } from '/src/effects/effect-host.js';
import { definePlugin } from '/src/effects/plugin-abi.js';
import { WaterEffectPlugin } from '/src/effects/water/water-plugin.js';

const GPU = await gpuAvailable();
console.error(`water-gpu tests: WebGPU ${GPU ? 'available' : 'NOT available'}`);
const gtest = (name, fn, opts) => (GPU ? test(name, fn, opts) : test.skip(`SKIPPED: no WebGPU - ${name}`, fn));

const W = 480, H = 320, M = 10;
/** marker centres in source px */
const CENTRES = [];
for (let y = 40; y <= 280; y += 60) for (let x = 60; x <= 420; x += 60) CENTRES.push({ x, y });

const paintMarkers = (ctx) => {
  ctx.fillStyle = '#ffffff';
  for (const c of CENTRES) ctx.fillRect(c.x - M / 2, c.y - M / 2, M, M);
};

/** Water behind a wrapper that keeps every mapper the host asked for. */
function spyWater() {
  const mappers = [];
  const def = definePlugin({
    ...WaterEffectPlugin,
    async create(ctx, options) {
      const inst = await WaterEffectPlugin.create(ctx, options);
      return { ...inst, captureInputMapper(frame) { const m = inst.captureInputMapper(frame); mappers.push(m); return m; } };
    },
  });
  return { def, mappers };
}

/** Strong drops at known places, by the plugin's own pointerdown listener (the four slots are all replaced). */
function dropRipples(rig) {
  const r = rig.canvas.getBoundingClientRect();
  for (const [x, y] of [[150, 100], [330, 110], [210, 230], [380, 250]]) {
    rig.layerEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + x, clientY: r.top + y }));
  }
}

async function presentFrame(t, intensity, offsetMs) {
  const rig = makeRig({ w: W, h: H, paint: paintMarkers });
  rig.commit();
  const host = await createEffectHost(rig.env, rig.deps, rig.canvas, rig.source, { interposer: false });
  t.cleanup(() => host.destroy());
  const { def, mappers } = spyWater();
  await host.addPlugin(def, { intensity });
  dropRipples(rig);
  rig.tick(performance.now() + offsetMs);
  return { rig, img: rig.snap(), mapper: mappers.at(-1) };
}

/** signed distance (px) from a source point to the nearest marker square: negative inside */
function markerDistance(x, y) {
  let best = Infinity;
  for (const c of CENTRES) {
    const dx = Math.abs(x - c.x) - M / 2;
    const dy = Math.abs(y - c.y) - M / 2;
    best = Math.min(best, Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0));
  }
  return best;
}

/**
 * Pixel-exact oracle. A presented pixel is bright iff it shows a marker, i.e. iff the source point it samples lies inside a marker square.
 * Count the disagreements between "bright" and "map(pixel centre) is inside a marker", ignoring pixels whose source point is within
 * `band` px of a marker edge (bilinear blending makes those ambiguous).
 */
function agreement(img, map, band = 1.25) {
  let decided = 0, wrong = 0, bright = 0;
  for (let j = 0; j < img.height; j += 1) {
    for (let i = 0; i < img.width; i += 1) {
      const isBright = img.data[(j * img.width + i) * 4] > 110;
      if (isBright) bright += 1;
      const m = map({ x: i + 0.5, y: j + 0.5, width: img.width, height: img.height });
      const d = markerDistance(m.x, m.y);
      if (Math.abs(d) < band) continue;
      decided += 1;
      if (isBright !== (d < 0)) wrong += 1;
    }
  }
  return { decided, wrong, bright, share: wrong / decided };
}

const identity = (p) => ({ x: p.x, y: p.y });

gtest('every presented pixel samples the source point the water mapper says (pixel-exact, 150k pixels), identity does not (positive control)', async (t) => {
  const { img, mapper } = await presentFrame(t, 1, 80);
  const real = agreement(img, mapper);
  const flat = agreement(img, identity);
  console.error(`water mapper vs GPU: decided=${real.decided} wrong=${real.wrong} (${(real.share * 100).toFixed(4)}%) brightPx=${real.bright} | identity wrong=${flat.wrong} (${(flat.share * 100).toFixed(3)}%)`);
  assert.ok(real.bright > 3000, `markers are visible (${real.bright} bright px of 3500 expected)`);
  assert.ok(flat.wrong > 200, `the displacement is large enough for identity to be wrong on ${flat.wrong} px`);
  assert.ok(real.wrong <= 5, `mapper disagrees with the GPU on ${real.wrong} pixels`);
  assert.ok(real.wrong * 40 < flat.wrong);
});

gtest('a mapper of another instant (time shifted) disagrees measurably: the oracle is sensitive to the displacement function', async (t) => {
  const { img, mapper } = await presentFrame(t, 1, 80);
  const { mapper: later } = await presentFrame(t, 1, 200);
  const good = agreement(img, mapper).wrong;
  const wrong = agreement(img, later).wrong;
  assert.ok(wrong > 100 && wrong > good * 20, `another instant: ${wrong} wrong pixels vs ${good}`);
});

gtest('intensity 0: nothing is displaced and the mapper is the identity up to the border clamp', async (t) => {
  const { img, mapper } = await presentFrame(t, 0, 80);
  const real = agreement(img, mapper);
  const flat = agreement(img, identity);
  assert.ok(real.bright > 3000);
  assert.ok(real.wrong <= 5, `${real.wrong}`);
  assert.ok(flat.wrong <= 5, `intensity 0 really is the plain surface on the GPU (${flat.wrong})`);
});

gtest('a mapper stays valid for the frame it was captured for while later frames are presented', async (t) => {
  const rig = makeRig({ w: W, h: H, paint: paintMarkers });
  rig.commit();
  const host = await createEffectHost(rig.env, rig.deps, rig.canvas, rig.source, { interposer: false });
  t.cleanup(() => host.destroy());
  const { def, mappers } = spyWater();
  await host.addPlugin(def, { intensity: 1 });
  dropRipples(rig);
  const t0 = performance.now();
  rig.tick(t0 + 80);
  const first = rig.snap();
  const firstMapper = mappers.at(-1);
  const before = agreement(first, firstMapper).wrong;
  for (let k = 1; k <= 2; k += 1) rig.tick(t0 + 80 + k * 50);
  assert.equal(agreement(first, firstMapper).wrong, before, 'two newer presentations did not change what the first mapper describes');
  assert.ok(before <= 5);
  const newest = agreement(first, mappers.at(-1)).wrong;
  assert.ok(newest > 100, 'while the newest mapper describes a different frame (positive control)');
});
