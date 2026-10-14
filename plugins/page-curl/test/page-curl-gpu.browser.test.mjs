// The page-curl input mapper against the pixels the GPU really produced (plugins/_shared/gpu-check.mjs), with a wrong-mapper control,
// the back of the page (mirrored and dimmed) checked pixel by pixel, the release back to the identity, and the GPU time of the pass.
import { assert } from '/test/unit/lib/t.js';
import { agreement, checkMapperAgainstGpu, gpuAvailable, gpuTest, identity, markerScene, presentOnce } from '/plugins/_shared/gpu-check.mjs';
import { RELEASE_MS, UNIFORM_FLOATS, curlGeometry, isNoTarget, mapCurlPoint, meta, plugin } from '/plugins/page-curl/index.js';
import { measurePassGpuTime } from '/plugins/_shared/gpu-time.mjs';
import { plugin as template } from '/plugins/_template/index.js';

console.error(`page-curl-gpu tests: WebGPU ${(await gpuAvailable()) ? 'available' : 'NOT available'}`);

const W = 480;
const H = 320;
const scene = markerScene({ w: W, h: H });
const GRAB = [476, 316];
const POSE = [290, 190];

/** @param {any} rig @param {string} type @param {number[]} at */
function pointer(rig, type, [x, y]) {
  const r = rig.canvas.getBoundingClientRect();
  rig.layerEl.dispatchEvent(new PointerEvent(type, { bubbles: true, composed: true, cancelable: true, isPrimary: true, pointerId: 1, pointerType: 'mouse', button: 0, clientX: r.left + x, clientY: r.top + y }));
}
/** grab the bottom-right corner and pull it to POSE (synthetic events reach the plugin's capture listeners like trusted ones) */
const dragTo = (/** @type {number[]} */ to) => (/** @type {any} */ rig) => { pointer(rig, 'pointerdown', GRAB); pointer(rig, 'pointermove', to); };

/** the uniform block the plugin computes for a pull of the bottom-right corner to `to` */
function stateFor(/** @type {number[]} */ to) {
  const s = new Float32Array(UNIFORM_FLOATS);
  s[2] = W; s[3] = H;
  curlGeometry(s, W, H, to[0], to[1], /** @type {number} */ (meta.defaults.radius));
  return s;
}

gpuTest('curled: the mapper predicts every presented pixel (identity on the flat page, no target on the curl); identity does not (positive control)', async (t) => {
  const v = await checkMapperAgainstGpu(t, plugin, { ...meta.defaults }, { scene, before: dragTo(POSE) });
  console.error(`page-curl mapper vs GPU: decided=${v.real.decided} wrong=${v.real.wrong} bright=${v.real.bright} | identity wrong=${v.identity.wrong}`);
  assert.ok(v.ok, v.why);
});

gpuTest('a mapper of a pose 20 px away is measurably wrong on the same frame (the oracle sees the fold line)', async (t) => {
  const { img, mapper } = await presentOnce(t, plugin, { ...meta.defaults }, { scene, before: dragTo(POSE) });
  const near = stateFor([POSE[0] + 20, POSE[1] + 14]);
  const good = agreement(img, /** @type {any} */ (mapper), scene).wrong;
  const wrong = agreement(img, (p) => mapCurlPoint(near, p), scene).wrong;
  console.error(`page-curl: the right pose ${good} wrong px, a pose 20 px away ${wrong}`);
  assert.ok(good <= 5 && wrong >= 40 && wrong > 8 * Math.max(1, good), `right pose ${good}, shifted pose ${wrong}`);
});

gpuTest('the mapper of the presented frame is the one the plugin computes for that pose (no target on the curl, identity on the flat page)', async (t) => {
  const { mapper } = await presentOnce(t, plugin, { ...meta.defaults }, { scene, before: dragTo(POSE) });
  const s = stateFor(POSE);
  let curled = 0, flat = 0;
  for (let y = 2.5; y < H; y += 7) {
    for (let x = 2.5; x < W; x += 7) {
      const p = { x, y, width: W, height: H };
      const m = /** @type {any} */ (mapper)(p);
      assert.deepEqual(m, mapCurlPoint(s, p));
      if (isNoTarget(m)) curled += 1; else if (m.x === x && m.y === y) flat += 1;
    }
  }
  assert.ok(curled > 200 && flat > 1500, `${curled} sampled points are curled, ${flat} flat`);
});

gpuTest('the back of the page is the source mirrored across the fold and dimmed (pixel by pixel)', async (t) => {
  const far = [170, 110];
  const { img } = await presentOnce(t, plugin, { ...meta.defaults }, { scene, before: dragTo(far) });
  const s = stateFor(far);
  const r = s[7];
  let decided = 0, wrong = 0, dimMarkers = 0;
  for (let j = 0; j < H; j += 1) {
    for (let i = 0; i < W; i += 1) {
      const x = i + 0.5, y = j + 0.5;
      const sd = x * s[4] + y * s[5] - s[6];
      if (sd >= -2) continue;                                   // the flat part of the back only (not the cylinder)
      const k = Math.PI * r - 2 * sd;
      const qx = x + k * s[4], qy = y + k * s[5];
      if (qx < 1 || qy < 1 || qx > W - 1 || qy > H - 1) continue;
      const d = scene.distance(qx, qy);
      if (Math.abs(d) < 1.25) continue;
      decided += 1;
      const red = img.data[(j * W + i) * 4];
      const marker = d < 0;
      if (marker) dimMarkers += 1;
      // a white marker seen from behind: dimmed to about a third (never as bright as the front); the back elsewhere: dark tint
      if (marker ? !(red > 45 && red < 110) : !(red < 35)) wrong += 1;
    }
  }
  console.error(`page-curl back side: decided=${decided} wrong=${wrong} dim mirrored marker px=${dimMarkers}`);
  assert.ok(decided > 2000 && dimMarkers > 100, `the flap covers ${decided} px, ${dimMarkers} of them a mirrored marker`);
  assert.ok(wrong <= 5, `${wrong} px of the back disagree with the mirror of the source`);
});

gpuTest('released: the page springs back and the presented frame is the plain source again (identity, pixel-exact)', async (t) => {
  const { rig, mappers } = await presentOnce(t, plugin, { ...meta.defaults }, { scene, before: dragTo(POSE) });
  pointer(rig, 'pointerup', POSE);
  const t0 = performance.now();
  rig.tick(t0 + 200);                     // the release starts on this frame
  rig.tick(t0 + 200 + RELEASE_MS / 2);
  const mid = /** @type {any} */ (mappers.at(-1));
  assert.ok(isNoTarget(mid({ x: 477, y: 317, width: W, height: H })), 'half way through the release the corner is still lifted');
  rig.tick(t0 + 200 + RELEASE_MS + 20);
  const img = rig.snap();
  const flat = /** @type {any} */ (mappers.at(-1));
  const real = agreement(img, flat, scene);
  const id = agreement(img, identity, scene);
  assert.ok(real.bright > 3000 && real.wrong <= 5 && id.wrong <= 5, `after the release: mapper wrong ${real.wrong}, identity wrong ${id.wrong}`);
  assert.deepEqual(flat({ x: 478, y: 318, width: W, height: H }), { x: 478, y: 318 });
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

gpuTest('device loss mid-drag: the host re-creates the plugin on a new device, the old instance is destroyed, the new one presents the flat page with an identity mapper', async (t) => {
  const { spy, log } = lossSpy(plugin);
  const { rig, mappers } = await presentOnce(t, spy, { ...meta.defaults }, { scene, before: dragTo(POSE) });
  assert.ok(isNoTarget(/** @type {any} */ (mappers.at(-1))({ x: 470, y: 310, width: W, height: H })), 'curled before the loss');
  log.devices[0].destroy();
  for (let i = 0; i < 300 && log.devices.length < 2; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.equal(log.devices.length, 2, 'create() ran again');
  assert.notEqual(log.devices[1], log.devices[0]);
  assert.equal(log.destroyed, 1, 'the old instance (and its document listeners) was destroyed');
  pointer(rig, 'pointerup', POSE);   // the gesture of the lost instance ends; the new instance never saw it
  rig.tick(performance.now() + 50);
  const img = rig.snap();
  const real = agreement(img, /** @type {any} */ (mappers.at(-1)), scene);
  const id = agreement(img, identity, scene);
  assert.ok(real.bright > 3000 && real.wrong <= 5 && id.wrong <= 5, `after recovery: mapper ${real.wrong}, identity ${id.wrong}, bright ${real.bright}`);
});

gpuTest('GPU time of the pass at 2200x1240 (1100x620 CSS px, DPR 2), 240 frames on a 120 Hz clock, the page curled; the template pass as baseline', async () => {
  const curled = {
    before(/** @type {HTMLCanvasElement} */ canvas) {
      const r = canvas.getBoundingClientRect();
      const ev = (/** @type {string} */ type, /** @type {number} */ x, /** @type {number} */ y) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, composed: true, cancelable: true, isPrimary: true, pointerId: 1, button: 0, clientX: r.left + x, clientY: r.top + y }));
      ev('pointerdown', 1096, 616);
      ev('pointermove', 520, 300);
    },
  };
  const base = await measurePassGpuTime(template, { offset: 24 });
  const m = await measurePassGpuTime(plugin, { ...meta.defaults }, curled);
  if (!m || !base) { console.error('page-curl GPU time: timestamp-query not available, NOT measured'); return; }
  console.error(`page-curl GPU time (${m.adapter}): back-to-back ${m.throughputMs.toFixed(3)} ms/frame (template ${base.throughputMs.toFixed(3)}); pass timestamps median ${m.medianMs.toFixed(3)} ms, p95 ${m.p95Ms.toFixed(3)} ms, max ${m.maxMs.toFixed(3)} ms; template pass median ${base.medianMs.toFixed(3)} ms, p95 ${base.p95Ms.toFixed(3)} ms (${m.width}x${m.height}, 120 Hz budget ${m.budgetMs.toFixed(2)} ms)`);
  assert.ok(m.p95Ms < m.budgetMs / 2 && m.throughputMs < m.budgetMs / 2, `p95 ${m.p95Ms} ms / back-to-back ${m.throughputMs} ms: more than half of the 120 Hz frame`);
  assert.ok(m.medianMs < 2 * base.medianMs + 0.5, `median ${m.medianMs} ms against ${base.medianMs} ms for the one-sample template pass`);
});
