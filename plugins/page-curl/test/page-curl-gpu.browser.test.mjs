// The page-curl plugin on the real GPU (headless Chrome, the real effects host): its input mapper against the pixels the GPU produced
// (plugins/_shared/gpu-check.mjs) with the identity and a pose 20 px away as controls, the back of the sheet (paper with the source showing
// through, mirrored), the dog-ear at rest, the spring back to the plain source, a device loss mid-drag, and the GPU time.
import { assert } from '/test/unit/lib/t.js';
import { agreement, checkMapperAgainstGpu, gpuAvailable, gpuTest, identity, lossSpy, markerScene, presentOnce, until } from '/plugins/_shared/gpu-check.mjs';
import { UNIFORM_FLOATS, isNoTarget, mapCurlPoint, meta, plugin, poseState, stateOf, unproject } from '/plugins/page-curl/index.js';
import { measurePassGpuTime } from '/plugins/_shared/gpu-time.mjs';
import { plugin as template } from '/plugins/_template/index.js';

console.error(`page-curl-gpu tests: WebGPU ${(await gpuAvailable()) ? 'available' : 'NOT available'}`);

const W = 480;
const H = 320;
const scene = markerScene({ w: W, h: H });
const GRAB = [476, 316];
const POSE = [250, 170];
// The oracle calls a pixel bright when its red channel is over 110. The default paper is cream (bright): for the mapper checks the back of
// the sheet and the page underneath get dark colours, so a bright pixel can only be the front of the page (a white marker).
const DARK = { ...meta.defaults, autoPeek: 0, paper: '#2f5f75', under: '#1d242c' };

/** @param {any} rig @param {string} type @param {number[]} at */
function pointer(rig, type, [x, y]) {
  const r = rig.canvas.getBoundingClientRect();
  rig.layerEl.dispatchEvent(new PointerEvent(type, { bubbles: true, composed: true, cancelable: true, isPrimary: true, pointerId: 1, pointerType: 'mouse', button: 0, clientX: r.left + x, clientY: r.top + y }));
}
/** grab the bottom-right corner and pull it to `to` (synthetic events reach the plugin's capture listeners like trusted ones) */
const dragTo = (/** @type {number[]} */ to) => (/** @type {any} */ rig) => { pointer(rig, 'pointerdown', GRAB); pointer(rig, 'pointermove', to); };
/** the same, then one frame now: the spring that follows the pointer starts on it, so the frame presentOnce shows `offsetMs` later is curled */
const dragged = (/** @type {number[]} */ to) => (/** @type {any} */ rig) => { dragTo(to)(rig); rig.tick(performance.now()); };
/** present frames until the spring that follows the pointer has settled (its corner lies under the pointer) */
function settle(/** @type {any} */ rig) { const t = performance.now(); for (let k = 1; k <= 8; k += 1) rig.tick(t + k * 250); return rig.snap(); }

/** where the held corner of a presented state lies (page css px): the fold's corner minus the pull @param {Float32Array} s */
function cornerOf(s) {
  const lx = s[2] - s[4] * s[9], ly = s[3] - s[5] * s[9];
  return [s[10] > 0 ? lx : s[2] - lx, ly];
}

gpuTest('curled: the mapper predicts every presented pixel (identity on the flat page, the page point on the front of the roll, no target on the back and beneath); identity does not', async (t) => {
  // minBrightShare 0.6: the lifted sheet covers about a third of the page with its back, where no marker of the front can be bright
  const v = await checkMapperAgainstGpu(t, plugin, DARK, { scene, before: dragged(POSE), offsetMs: 400, minBrightShare: 0.6 });
  console.error(`page-curl mapper vs GPU: decided=${v.real.decided} wrong=${v.real.wrong} bright=${v.real.bright} | identity wrong=${v.identity.wrong}`);
  assert.ok(v.ok, v.why);
});

gpuTest('a mapper of a pose 20 px away is measurably wrong on the same frame; the presented pose has the corner under the pointer', async (t) => {
  const { rig, mappers } = await presentOnce(t, plugin, DARK, { scene, before: dragTo(POSE) });
  const img = settle(rig);
  const mapper = /** @type {any} */ (mappers.at(-1));
  const s = /** @type {Float32Array} */ (stateOf(mapper));
  // the corner is drawn 2R above the page; seen from the camera it lies under the pointer
  const [cx, cy] = cornerOf(s);
  const D = s[11], k = D / (D - 2 * s[8]);
  const seen = { x: W / 2 + (cx - W / 2) * k, y: H / 2 + (cy - H / 2) * k };
  assert.ok(Math.hypot(seen.x - POSE[0], seen.y - POSE[1]) < 1, `the corner is seen at ${seen.x.toFixed(2)}, ${seen.y.toFixed(2)}, the pointer is at ${POSE}`);
  const near = poseState(new Float32Array(UNIFORM_FLOATS), W, H, 'br', cx + 20, cy + 14, /** @type {number} */ (meta.defaults.radius));
  const good = agreement(img, mapper, scene).wrong;
  const wrong = agreement(img, (p) => mapCurlPoint(near, p), scene).wrong;
  console.error(`page-curl: the right pose ${good} wrong px, a pose 20 px away ${wrong}`);
  assert.ok(good <= 5 && wrong >= 40 && wrong > 8 * Math.max(1, good), `right pose ${good}, shifted pose ${wrong}`);
});

gpuTest('the back of the sheet is paper, and the source shows through it mirrored: darker exactly where the mirrored source has a marker', async (t) => {
  const far = [70, 90];
  const { rig, mappers } = await presentOnce(t, plugin, { ...meta.defaults, autoPeek: 0 }, { scene, before: dragTo(far) });
  const img = settle(rig);
  const s = /** @type {Float32Array} */ (stateOf(/** @type {any} */ (mappers.at(-1))));
  const [nx, ny, ax, ay, R, D] = [s[4], s[5], s[6], s[7], s[8], s[11]];
  const q = { x: 0, y: 0 };
  /** @type {number[]} */ const onMark = [];
  /** @type {number[]} */ const onPaper = [];
  for (let j = 0; j < H; j += 1) {
    for (let i = 0; i < W; i += 1) {
      // the flat part of the folded flap (2R above the page): the source point it carries, by the fold's reflection
      unproject(i + 0.5, j + 0.5, 2 * R, W, H, D, q);
      const tt = (q.x - ax) * nx + (q.y - ay) * ny;
      if (tt > -3) continue;                                   // only well inside the flat part of the flap
      const kk = Math.PI * R - 2 * tt;
      const sx = q.x + nx * kk, sy = q.y + ny * kk;
      if (sx < 3 || sy < 3 || sx > W - 3 || sy > H - 3) continue;
      const d = scene.distance(sx, sy);
      const red = img.data[(j * W + i) * 4];
      if (d < -2) onMark.push(red); else if (d > 14) onPaper.push(red);
    }
  }
  const mean = (/** @type {number[]} */ a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  console.error(`page-curl back side: ${onPaper.length} paper px (mean red ${mean(onPaper).toFixed(1)}), ${onMark.length} px over a mirrored marker (mean red ${mean(onMark).toFixed(1)})`);
  assert.ok(onPaper.length > 5000 && onMark.length > 100, `the flap covers ${onPaper.length} + ${onMark.length} px`);
  assert.ok(mean(onPaper) > 200, 'the back is light paper');
  assert.ok(mean(onMark) < mean(onPaper) - 25, 'a marker of the front shows through the paper, at its mirrored place');
});

gpuTest('at rest the top-right corner is a dog-ear: paper there (cream by default), and the mapper predicts the whole frame', async (t) => {
  const cream = await presentOnce(t, plugin, { ...meta.defaults, autoPeek: 0 }, { scene });
  let paper = 0;
  for (let j = 0; j < 64; j += 1) {
    for (let i = W - 64; i < W; i += 1) {
      const k = (j * W + i) * 4;
      if (cream.img.data[k] > 170 && cream.img.data[k + 1] > 160 && cream.img.data[k + 2] > 140) paper += 1;
    }
  }
  const { img, mapper } = await presentOnce(t, plugin, DARK, { scene });
  const real = agreement(img, /** @type {any} */ (mapper), scene);
  console.error(`page-curl dog-ear: ${paper} paper px in the top-right 64x64; mapper wrong ${real.wrong}`);
  assert.ok(paper > 150, `${paper} paper-coloured px at the top-right corner`);
  assert.ok(real.wrong <= 5 && real.bright > 3000, `mapper wrong ${real.wrong}`);
  assert.ok(isNoTarget(/** @type {any} */ (mapper)({ x: W - 2, y: 2, width: W, height: H })), 'the dog-ear is not the page');
});

gpuTest('released: the sheet springs back and the presented frame is the plain source again (identity)', async (t) => {
  const { rig, mappers } = await presentOnce(t, plugin, { ...DARK, dogEar: 0 }, { scene, before: dragTo(POSE) });
  settle(rig);
  assert.ok(isNoTarget(/** @type {any} */ (mappers.at(-1))({ x: POSE[0] + 4, y: POSE[1] + 4, width: W, height: H })), 'curled while held');
  pointer(rig, 'pointerup', POSE);
  const t0 = performance.now();
  for (let k = 1; k <= 12; k += 1) rig.tick(t0 + 3000 + k * 250);
  const img = rig.snap();
  const flat = /** @type {any} */ (mappers.at(-1));
  const real = agreement(img, flat, scene);
  const id = agreement(img, identity, scene);
  assert.ok(real.bright > 3000 && real.wrong <= 5 && id.wrong <= 5, `after the release: mapper wrong ${real.wrong}, identity wrong ${id.wrong}`);
  assert.deepEqual(flat({ x: 478, y: 318, width: W, height: H }), { x: 478, y: 318 });
});


gpuTest('device loss mid-drag: the host re-creates the plugin on a new device, the old instance is destroyed, the new one presents the flat page with an identity mapper', async (t) => {
  const { spy, log } = lossSpy(plugin);
  const { rig, mappers } = await presentOnce(t, spy, { ...DARK, dogEar: 0 }, { scene, before: dragged(POSE), offsetMs: 400 });
  assert.ok(isNoTarget(/** @type {any} */ (mappers.at(-1))({ x: 470, y: 310, width: W, height: H })), 'curled before the loss');
  log.devices[0].destroy();
  await until(() => log.devices.length >= 2, 3000);
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

gpuTest('GPU time at 2200x1240 (1100x620 CSS px, DPR 2), 240 frames on a 120 Hz clock, the sheet curled (shadow passes, MSAA strip); the template pass as baseline', async () => {
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
  console.error(`page-curl GPU time (${m.adapter}): back-to-back ${m.throughputMs.toFixed(3)} ms/frame (template ${base.throughputMs.toFixed(3)}) (${m.width}x${m.height}, 120 Hz budget ${m.budgetMs.toFixed(2)} ms)`);
  assert.ok(m.throughputMs < m.budgetMs / 2, `back-to-back ${m.throughputMs} ms: more than half of the 120 Hz frame`);
});
