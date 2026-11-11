// The page-curl plugin on the real GPU (headless Chrome, the real effects host): its input mapper against the pixels the GPU produced
// (plugins/_shared/gpu-check.mjs) with the identity and a pose 20 px away as controls, the back of the sheet (paper with the source showing
// through, mirrored), the dog-ear at rest, the spring back to the plain source, the actions 'peek' and 'demo' through the effect handle, a device loss
// mid-drag, and the GPU time.
import { assert } from '/test/unit/lib/t.js';
import { agreement, changedPixels, checkMapperAgainstGpu, gpuAvailable, gpuTest, identity, lossSpy, markerScene, presentOnce, runActionOnGpu, spyMappers, until } from '/plugins/_shared/gpu-check.mjs';
import { UNIFORM_FLOATS, foldOf, foldPoint, heldCorner, isNoTarget, mapCurlPoint, meta, plugin, poseState, project, stateOf } from '/plugins/page-curl/index.js';
import { measurePassGpuTime } from '/plugins/_shared/gpu-time.mjs';
import { plugin as template } from '/plugins/_template/index.js';
import { makeRig } from '/test/unit/gpu-effects/lib/rig.mjs';
import { createEffectHost } from '/src/effects/effect-host.js';
import { definePlugin } from '/src/effects/plugin-abi.js';

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

/** where the held corner of a presented state lies (page css px) and its height (on a cone, the flap is tilted) @param {Float32Array} s */
function cornerOf(s) {
  const [lx, ly, z] = heldCorner(s);
  return [s[10] > 0 ? lx : s[2] - lx, ly, z];
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
  // the corner is drawn above the page; seen from the camera it lies under the pointer
  const [cx, cy, cz] = cornerOf(s);
  const seen = project(cx, cy, cz, W, H, s[11], { x: 0, y: 0 });
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
  // forward, from the fold of the presented state: each point of the source that lies on the folded flap (and 3 px inside it), drawn where
  // the camera sees it; the flap is the top layer, so that pixel shows it
  const f = foldOf(s), D = s[11], m = s[10];
  const p = [0, 0, 0], q = { x: 0, y: 0 };
  const flap = (/** @type {number} */ x, /** @type {number} */ y) => foldPoint(x, y, f, p) === 2;
  /** @type {number[]} */ const onMark = [];
  /** @type {number[]} */ const onPaper = [];
  const seen = new Uint8Array(W * H);
  for (let sy = 3; sy <= H - 3; sy += 0.5) {
    for (let sx = 3; sx <= W - 3; sx += 0.5) {
      const lx = m > 0 ? sx : W - sx;
      if (!flap(lx - 3, sy) || !flap(lx + 3, sy) || !flap(lx, sy - 3) || !flap(lx, sy + 3) || !flap(lx, sy)) continue;
      project(m > 0 ? p[0] : W - p[0], p[1], p[2], W, H, D, q);
      const i = Math.floor(q.x), j = Math.floor(q.y);
      if (i < 0 || j < 0 || i >= W || j >= H || seen[j * W + i]) continue;
      seen[j * W + i] = 1;
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

/**
 * The host's live under page (EffectHostOptions.under) beneath the curl: markers of its own, between those of the source. The oracle of
 * gpu-check.mjs (agreement) over both pages: a pixel is bright exactly where the mapper's point is inside a marker of the page it names (the
 * source, or the under page for `under: true`). checkMapperAgainstGpu presents through a host without an under page, so the frame is built
 * here with the same rig and the same oracle.
 */
const underScene = markerScene({ w: W, h: H, first: { x: 90, y: 70 } });
const UNDER_OFFSET = 1e6;
/** both scenes as one: a point on the under page is moved far right, where only the under scene answers */
const bothScenes = { ...scene, distance: (/** @type {number} */ x, /** @type {number} */ y) => (x > UNDER_OFFSET / 2 ? underScene.distance(x - UNDER_OFFSET, y) : scene.distance(x, y)) };
/** @param {any} mapper */
const onBoth = (mapper) => (/** @type {any} */ p) => { const q = mapper(p); return q.under === true ? { x: q.x + UNDER_OFFSET, y: q.y } : q; };
/** the same mapper as a host without an under page reads it: a point on the under page shows nothing @param {any} mapper */
const withoutUnder = (mapper) => (/** @type {any} */ p) => { const q = mapper(p); return q.under === true ? { x: -1e5, y: -1e5 } : q; };

/** @param {any} t @param {Record<string, unknown>} options */
async function curlOverUnder(t, options) {
  const rig = makeRig({ w: W, h: H, paint: scene.paint, under: (ctx) => underScene.paint(ctx) });
  rig.commit();
  rig.commitUnder();
  const host = await createEffectHost(rig.env, rig.deps, rig.canvas, rig.source, { interposer: false, under: rig.under });
  t.cleanup(() => host.destroy());
  const { def, mappers } = spyMappers(plugin);
  const handle = await host.addPlugin(def, options);
  dragged(POSE)(rig);
  rig.tick(performance.now() + 400);
  return { rig, host, handle, img: rig.snap(), mapper: mappers.at(-1) };
}

gpuTest('under page: where the sheet is lifted the host\'s live under page shows, and the mapper sends the pointer to it exactly (control: the same frame read without an under page)', async (t) => {
  // shadow 0: the oracle reads "bright" as red > 110; the roll's shadow would darken white markers of the under page below it (it is checked by the stills)
  const { rig, host, img, mapper } = await curlOverUnder(t, { ...DARK, shadow: 0 });
  const real = agreement(img, onBoth(mapper), bothScenes);
  const blind = agreement(img, withoutUnder(mapper), scene);
  const id = agreement(img, identity, scene);
  let shownUnder = 0;
  for (let j = 0; j < H; j += 1) for (let i = 0; i < W; i += 1) {
    const q = /** @type {any} */ (mapper)({ x: i + 0.5, y: j + 0.5, width: W, height: H });
    if (q.under === true && img.data[(j * W + i) * 4] > 110) shownUnder += 1;
  }
  console.error(`page-curl under page vs GPU: decided=${real.decided} wrong=${real.wrong} | read without the under page wrong=${blind.wrong} | identity wrong=${id.wrong} | bright px of the under page ${shownUnder}`);
  assert.ok(real.wrong <= 5, `the mapper disagrees with the GPU on ${real.wrong} px over both pages`);
  assert.ok(shownUnder >= 250, `markers of the under page are shown beneath the sheet (${shownUnder} px)`);
  assert.ok(blind.wrong >= 200, `control: read without the under page the same frame is wrong on ${blind.wrong} px`);
  assert.equal(host.stats().underUploads, 1);
  assert.equal(rig.under.inert, false, 'some of the under page is shown: not inert');
  assert.deepEqual(/** @type {any} */ (mapper)({ x: W - 4, y: H - 4, width: W, height: H }), { x: W - 4, y: H - 4, under: true });
});

gpuTest('under page: with underPage false, and on a host without one, the page underneath is the paper and the mapper says no target there', async (t) => {
  const { img, mapper, host } = await curlOverUnder(t, { ...DARK, shadow: 0, underPage: false });
  const real = agreement(img, /** @type {any} */ (mapper), scene);
  const under = agreement(img, onBoth(mapper), bothScenes);
  let anyUnder = 0;
  for (let j = 0; j < H; j += 2) for (let i = 0; i < W; i += 2) if (/** @type {any} */ (mapper)({ x: i + 0.5, y: j + 0.5, width: W, height: H }).under === true) anyUnder += 1;
  assert.equal(anyUnder, 0, 'no point of the under page');
  assert.ok(real.wrong <= 5 && under.wrong <= 5, `the mapper agrees with the paper frame (wrong ${real.wrong})`);
  assert.ok(isNoTarget(/** @type {any} */ (mapper)({ x: W - 4, y: H - 4, width: W, height: H })), 'beneath the sheet: no target with underPage false');
  // the plugin listens on the document: the held pointer of the first host would hold the second one's sheet too
  host.destroy();
  const plain = await presentOnce(t, plugin, DARK, { scene, before: dragged(POSE), offsetMs: 400 });
  assert.ok(isNoTarget(/** @type {any} */ (plain.mapper)({ x: W - 4, y: H - 4, width: W, height: H })), 'beneath the sheet: no target without an under page');
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


gpuTest('the action peek through the effect handle: the dog-ear opens and closes, every checked frame agrees with its mapper, it resolves rest on the dog-ear', async (t) => {
  const r = await runActionOnGpu(t, plugin, DARK, 'peek', undefined, { scene, maxMs: 5000, checkEvery: 8 });
  console.error(`page-curl action: ${r.frames} frames, ${r.checked} checked, at most ${r.maxChanged} px changed, worst mapper ${r.worst?.wrong} px wrong`);
  assert.equal(r.state, 'rest');
  assert.ok(r.maxChanged > 1000, `the dog-ear opened: ${r.maxChanged} px changed`);
  assert.ok(r.worst !== null && r.checked >= 5 && r.worst.wrong <= 5, `a frame of the peek disagrees with its mapper on ${r.worst?.wrong} px`);
  assert.ok(changedPixels(r.last, r.first) <= 20, `back on the dog-ear: ${changedPixels(r.last, r.first)} px differ from the first frame`);
}, { timeout: 20000 });   // about 100 frames on the frame clock, and the mapper of every 8th judged on 150,000 pixels

gpuTest('the action demo through the effect handle: the page turns most of the way over and springs back, every checked frame agrees with its mapper, it resolves rest on the dog-ear', async (t) => {
  const r = await runActionOnGpu(t, plugin, DARK, 'demo', undefined, { scene, maxMs: 6000, checkEvery: 12 });
  console.error(`page-curl demo: ${r.frames} frames, ${r.checked} checked, at most ${r.maxChanged} px changed, worst mapper ${r.worst?.wrong} px wrong`);
  assert.equal(r.state, 'rest');
  assert.ok(r.maxChanged > 0.4 * W * H, `the page turned: ${r.maxChanged} px changed`);
  assert.ok(r.worst !== null && r.checked >= 8 && r.worst.wrong <= 5, `a frame of the demo disagrees with its mapper on ${r.worst?.wrong} px`);
  assert.ok(changedPixels(r.last, r.first) <= 20, `back on the dog-ear: ${changedPixels(r.last, r.first)} px differ from the first frame`);
}, { timeout: 30000 });

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

// ---- extended range ---------------------------------------------------------------------------------------------------------------------

/** a dark page with a large white panel */
const PANEL = { x: 250, y: 60, w: 190, h: 200 };
const paintPanel = (/** @type {CanvasRenderingContext2D} */ ctx) => {
  ctx.fillStyle = '#101826'; ctx.fillRect(0, 0, 480, 320);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(PANEL.x, PANEL.y, PANEL.w, PANEL.h);
};
/** a stage of one full-screen pass over its source (`body`: the fragment's colour from the source texel `c`) */
const stage = (/** @type {string} */ type, /** @type {string} */ body) => definePlugin({
  type, apiVersion: 2, version: 1, outputCapabilities: { directCanvasRenderAttachment: true },
  create(/** @type {any} */ ctx) {
    const { device, format } = ctx;
    const module = device.createShaderModule({ code: `
      @group(0) @binding(1) var tx : texture_2d<f32>;
      @vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4<f32> { var p = array<vec2<f32>,3>(vec2(-1.,-1.), vec2(3.,-1.), vec2(-1.,3.)); return vec4(p[i], 0., 1.); }
      @fragment fn fs(@builtin(position) pos : vec4<f32>) -> @location(0) vec4<f32> { let c = textureLoad(tx, vec2<i32>(pos.xy), 0); return vec4(${body}, 1.0); }` });
    const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format }] } });
    return { render(/** @type {any} */ frame) {
      const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 1, resource: frame.sourceView }] });
      const pass = frame.encoder.beginRenderPass({ colorAttachments: [{ view: frame.destinationView, loadOp: 'clear', storeOp: 'store' }] });
      pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.draw(3); pass.end();
    } };
  },
});
/** after a plugin: white where it wrote above white (largest channel over 1.004), black elsewhere */
const aboveWhite = () => stage('above-white', 'vec3(select(0.0, 1.0, max(c.r, max(c.g, c.b)) > 1.004))');
/** the control of the area check: the whole picture a tenth brighter, so a white panel is above white as a whole */
const lifted = () => stage('lifted', 'c.rgb * 1.1');

/** the pixels above white in a frame of the aboveWhite stage: all of them, their centre, and those inside the white panel (its inner part: `inset` px in) */
function litPixels(/** @type {ImageData} */ img, inset = 4) {
  let all = 0, panel = 0, sx = 0, sy = 0;
  const x0 = PANEL.x + inset, x1 = PANEL.x + PANEL.w - inset, y0 = PANEL.y + inset, y1 = PANEL.y + PANEL.h - inset;
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      if (img.data[(y * img.width + x) * 4] < 128) continue;
      all += 1; sx += x; sy += y;
      if (x >= x0 && x < x1 && y >= y0 && y < y1) panel += 1;
    }
  }
  return { all, panel, panelArea: (x1 - x0) * (y1 - y0), cx: all ? sx / all : NaN, cy: all ? sy / all : NaN };
}

/** the plugin over the panel page, then the aboveWhite stage, on a host with or without extended range; `first`: the stage before it instead of the plugin */
async function rangeRig(/** @type {any} */ t, /** @type {boolean} */ hdr, /** @type {any} */ first = null) {
  const rig = makeRig({ w: 480, h: 320, paint: paintPanel });
  rig.commit();
  const host = await createEffectHost(rig.env, rig.deps, rig.canvas, rig.source, { interposer: false, hdr });
  t.cleanup(() => host.destroy());
  const handle = await host.addPlugin(first ?? plugin, first ? {} : { ...meta.defaults });
  await host.addPlugin(aboveWhite());
  let now = performance.now() + 60;
  const r = rig.canvas.getBoundingClientRect();
  return {
    rig, host, handle,
    /** one frame `ms` later on the frame clock, and what it shows above white */
    frame(ms = 16) { now += ms; rig.tick(now); return litPixels(rig.snap()); },
    /** a pointer event at a canvas point */
    pointer(/** @type {string} */ type, /** @type {number} */ x, /** @type {number} */ y, o = {}) { rig.layerEl.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, isPrimary: true, clientX: r.left + x, clientY: r.top + y, ...o })); },
  };
}
const SKIP = ' extended range: SKIPPED, this browser does not take the extended tone mapping of a WebGPU canvas';

gpuTest('extended range: the lamp\'s highlight along the roll is above white while the corner is pulled, the white panel on the page is not; the dog-ear at rest shows nothing; on a standard target nothing is', async (t) => {
  const run = async (/** @type {boolean} */ hdr) => {
    const c = await rangeRig(t, hdr);
    let rest = c.frame();
    for (let k = 0; k < 30; k += 1) rest = c.frame();   // the dog-ear has settled
    // the top right corner pulled over the page, across the white panel, and held
    const mouse = { composed: true, cancelable: true, pointerType: 'mouse', button: 0 };
    c.pointer('pointerdown', 474, 6, mouse);
    let busiest = rest;
    for (let k = 1; k <= 60; k += 1) {
      const m = Math.min(1, k / 40);
      c.pointer('pointermove', 474 - 300 * m, 6 + 190 * m, mouse);
      const f = c.frame();
      if (f.all > busiest.all) busiest = f;
    }
    return { c, rest, busiest };
  };
  const on = await run(true);
  if (!on.c.host.stats().hdr) { console.error('page-curl' + SKIP); return; }
  console.error(`page-curl extended range: at most ${on.busiest.all} px above white in a frame of the pull (${on.busiest.panel} of the ${on.busiest.panelArea} px of the white panel's place)`);
  assert.equal(on.rest.all, 0, 'the dog-ear at rest: nothing above white');
  assert.ok(on.busiest.all > 40, `the highlight along the roll is above white: ${on.busiest.all} px`);
  // (a band about 10 px wide along a roll that crosses this small canvas; the gallery canvas is 4.6 times larger)
  assert.ok(on.busiest.all < 0.03 * 480 * 320, `a small part of the canvas: ${on.busiest.all} px`);
  assert.ok(on.busiest.panel < 0.1 * on.busiest.panelArea, `the white panel is not above white as a whole: ${on.busiest.panel} of ${on.busiest.panelArea} px`);
  // control of the area check: a stage that lifts the whole picture puts the panel above white
  const up = await rangeRig(t, true, lifted());
  const all = up.frame();
  assert.ok(all.panel > 0.9 * all.panelArea, `control: a lifted panel is counted (${all.panel} of ${all.panelArea} px)`);
  // control of the range: the same pull on a standard target
  const off = await run(false);
  assert.equal(off.c.host.stats().hdr, false);
  assert.equal(off.busiest.all, 0, 'standard range: an 8-bit target holds nothing above white');
});
