// The water input mapper against the pixels the GPU really produced (not against its own formula), through the shared plugin kit.
import { assert } from '/test/unit/lib/t.js';
import { agreement, checkMapperAgainstGpu, gpuAvailable, gpuTest, identity, markerScene, presentOnce } from '/plugins/_shared/gpu-check.mjs';
import { plugin } from '/plugins/water/index.js';

console.error(`water-gpu tests: WebGPU ${(await gpuAvailable()) ? 'available' : 'NOT available'}`);

const scene = markerScene({ w: 480, h: 320 });

/** Strong drops at known places, by the plugin's own pointerdown listener (the four slots are all replaced). @param {any} rig */
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

gpuTest('a mapper of another instant (time shifted) disagrees measurably: the oracle is sensitive to the displacement function', async (t) => {
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
  const { rig, img: first, mappers } = await presentOnce(t, plugin, { intensity: 1 }, { scene, before: dropRipples, offsetMs: 80 });
  const firstMapper = /** @type {any} */ (mappers.at(-1));
  const before = agreement(first, firstMapper, scene).wrong;
  const t0 = performance.now();
  for (let k = 1; k <= 2; k += 1) rig.tick(t0 + 80 + k * 50);
  assert.equal(agreement(first, firstMapper, scene).wrong, before, 'two newer presentations did not change what the first mapper describes');
  assert.ok(before <= 5);
  const newest = agreement(first, /** @type {any} */ (mappers.at(-1)), scene).wrong;
  assert.ok(newest > 100, 'while the newest mapper describes a different frame (positive control)');
});
