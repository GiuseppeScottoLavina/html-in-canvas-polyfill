// Browser test kit for plugin authors: run a plugin through the REAL effects host on a real WebGPU canvas and judge its input mapper
// against the pixels the GPU produced, not against its own formula. Used by plugins/*/test/*.browser.test.mjs (npm run test:unit:browser).
//
// The scene is a grid of white marker squares on black. A presented pixel is bright exactly when the source point it samples lies inside a
// marker, so a correct mapper predicts every bright pixel; the identity mapper (what a plugin without a mapper amounts to) must not.
import { test } from '/test/unit/lib/t.js';
import { gpuAvailable, makeRig } from '/test/unit/gpu-effects/lib/rig.mjs';
import { createEffectHost } from '/src/effects/effect-host.js';
import { definePlugin } from '/src/effects/plugin-abi.js';

export { gpuAvailable };

const GPU = await gpuAvailable();

/** A test that is reported as skipped (never as passed) where this Chrome has no WebGPU adapter. */
export function gpuTest(/** @type {string} */ name, /** @type {(t: any) => unknown} */ fn, /** @type {any} */ opts) {
  return GPU ? test(name, fn, opts) : test.skip(`SKIPPED: no WebGPU - ${name}`, fn);
}

/** @param {{x: number, y: number}} p */
export const identity = (p) => ({ x: p.x, y: p.y });

/**
 * Marker squares of `size` px every `step` px (first centre at step/2 + offset).
 * @param {{w?: number, h?: number, step?: number, size?: number, first?: {x: number, y: number}}} [o]
 */
export function markerScene({ w = 480, h = 320, step = 60, size = 10, first = { x: 60, y: 40 } } = {}) {
  /** @type {{x: number, y: number}[]} */ const centres = [];
  for (let y = first.y; y <= h - first.y; y += step) for (let x = first.x; x <= w - first.x; x += step) centres.push({ x, y });
  return {
    w, h, centres, size,
    /** @param {CanvasRenderingContext2D} ctx */
    paint(ctx) { ctx.fillStyle = '#ffffff'; for (const c of centres) ctx.fillRect(c.x - size / 2, c.y - size / 2, size, size); },
    /** signed distance (px) from a source point to the nearest marker square: negative inside @param {number} x @param {number} y */
    distance(x, y) {
      let best = Infinity;
      for (const c of centres) {
        const dx = Math.abs(x - c.x) - size / 2;
        const dy = Math.abs(y - c.y) - size / 2;
        best = Math.min(best, Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0));
      }
      return best;
    },
  };
}

/**
 * Wrap a definition so that every mapper the host asks for is kept, newest last.
 * @param {any} plugin
 */
export function spyMappers(plugin) {
  /** @type {Function[]} */ const mappers = [];
  const def = definePlugin({
    ...plugin,
    async create(/** @type {any} */ ctx, /** @type {any} */ options) {
      const inst = await plugin.create(ctx, options);
      return { ...inst, captureInputMapper(/** @type {any} */ frame) { const m = inst.captureInputMapper(frame); mappers.push(m); return m; } };
    },
  });
  return { def, mappers };
}

/**
 * Present ONE frame of `plugin` over `scene` through the real host and read it back in the same task.
 * @param {any} t  the test context (the host is destroyed by t.cleanup)
 * @param {any} plugin  the plugin definition (index.js `plugin`)
 * @param {Record<string, unknown>} options  addPlugin options
 * @param {{scene?: ReturnType<typeof markerScene>, offsetMs?: number, before?: (rig: any) => void}} [o]  `before` runs after addPlugin (e.g. pointer events)
 */
export async function presentOnce(t, plugin, options, { scene = markerScene(), offsetMs = 80, before } = {}) {
  const rig = makeRig({ w: scene.w, h: scene.h, paint: scene.paint });
  rig.commit();
  const host = await createEffectHost(rig.env, rig.deps, rig.canvas, rig.source, { interposer: false });
  t.cleanup(() => host.destroy());
  const { def, mappers } = spyMappers(plugin);
  const handle = await host.addPlugin(def, options);
  before?.(rig);
  rig.tick(performance.now() + offsetMs);
  return { rig, host, handle, img: rig.snap(), mapper: mappers.at(-1), mappers };
}

/**
 * Pixel-exact oracle: count the pixels where "bright" disagrees with "map(pixel centre) is inside a marker", ignoring pixels whose source point
 * is within `band` px of a marker edge (bilinear filtering makes those ambiguous).
 * @param {ImageData} img
 * @param {(p: {x: number, y: number, width: number, height: number}) => {x: number, y: number}} map
 * @param {ReturnType<typeof markerScene>} scene
 */
export function agreement(img, map, scene, band = 1.25) {
  let decided = 0, wrong = 0, bright = 0;
  for (let j = 0; j < img.height; j += 1) {
    for (let i = 0; i < img.width; i += 1) {
      const isBright = img.data[(j * img.width + i) * 4] > 110;
      if (isBright) bright += 1;
      const m = map({ x: i + 0.5, y: j + 0.5, width: img.width, height: img.height });
      const d = scene.distance(m.x, m.y);
      if (Math.abs(d) < band) continue;
      decided += 1;
      if (isBright !== (d < 0)) wrong += 1;
    }
  }
  return { decided, wrong, bright, share: wrong / Math.max(1, decided) };
}

/**
 * The standard check of a spatial plugin: its mapper agrees with the GPU pixels (at most `maxWrong` pixels), and the identity mapper is
 * measurably wrong on the same frame (at least `minIdentityWrong` pixels), so the check could have failed.
 * @param {any} t
 * @param {any} plugin
 * @param {Record<string, unknown>} options  options under which the plugin really displaces pixels
 * @param {{scene?: ReturnType<typeof markerScene>, offsetMs?: number, before?: (rig: any) => void, maxWrong?: number, minIdentityWrong?: number}} [o]
 */
export async function checkMapperAgainstGpu(t, plugin, options, { maxWrong = 5, minIdentityWrong = 200, ...present } = {}) {
  const scene = present.scene ?? markerScene();
  const { img, mapper } = await presentOnce(t, plugin, options, { ...present, scene });
  if (typeof mapper !== 'function') throw new Error('the host never asked the plugin for a mapper: is the instance `spatial: true`?');
  const real = agreement(img, /** @type {any} */ (mapper), scene);
  const flat = agreement(img, identity, scene);
  const minBright = scene.centres.length * scene.size * scene.size * 0.8;
  const verdict = {
    real, identity: flat,
    ok: real.bright >= minBright && real.wrong <= maxWrong && flat.wrong >= minIdentityWrong,
    why: real.bright < minBright ? `markers not visible (${real.bright} bright px, ${minBright} expected)`
      : flat.wrong < minIdentityWrong ? `the displacement is too small to judge: the identity mapper is wrong on only ${flat.wrong} px`
      : real.wrong > maxWrong ? `the mapper disagrees with the GPU on ${real.wrong} px (limit ${maxWrong})` : 'ok',
  };
  return verdict;
}
