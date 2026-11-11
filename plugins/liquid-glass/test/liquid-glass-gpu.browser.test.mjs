// The liquid-glass input mapper against the pixels the GPU really produced (plugins/_shared/gpu-check.mjs), a moving lens, device loss,
// the demo action on the GPU, frost, and the GPU time of the pass.
import { assert } from '/test/unit/lib/t.js';
import { agreement, changedPixels, checkMapperAgainstGpu, gpuAvailable, gpuTest, markerScene, presentOnce, runActionOnGpu, until } from '/plugins/_shared/gpu-check.mjs';
import { definePlugin } from '/src/effects/plugin-abi.js';
import { UNIFORM_FLOATS, lensSurface, mapLensPoint, plugin, writeLensGeometry } from '/plugins/liquid-glass/index.js';
import { measureGpuTime } from '/plugins/_shared/gpu-time.mjs';
import { makeRig } from '/test/unit/gpu-effects/lib/rig.mjs';
import { createEffectHost } from '/src/effects/effect-host.js';

console.error(`liquid-glass gpu tests: WebGPU ${(await gpuAvailable()) ? 'available' : 'NOT available'}`);

const scene = markerScene({ w: 480, h: 320 });
/** geometry only: no colour fringes, no highlight or reflection, no shadow, no frost, so "bright" is decided by the sampled point alone */
const GEOMETRY = { pinned: true, x: 0.5, y: 0.5, size: 170, refraction: 1, dispersion: 0, highlight: 0, shadow: 0, frost: 0 };

/** The uniform block of the GEOMETRY lens at rest at (cx, cy) on the 480 x 320 scene. @param {number} cx @param {number} cy */
function lensState(cx, cy) {
  const s = new Float32Array(UNIFORM_FLOATS);
  s[0] = 480; s[1] = 320; s[2] = 480; s[3] = 320;
  writeLensGeometry(s, { cx, cy, size: GEOMETRY.size, aspect: 1.45, refraction: GEOMETRY.refraction });
  return s;
}

/** @param {ImageData} img the green channel copied into the red one (agreement() reads red) */
function greenAsRed(img) {
  const out = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  for (let i = 0; i < out.data.length; i += 4) out.data[i] = out.data[i + 1];
  return out;
}

gpuTest('a pinned lens: every presented pixel samples the source point the mapper says; identity does not (positive control)', async (t) => {
  const v = await checkMapperAgainstGpu(t, plugin, GEOMETRY, { scene });
  console.error(`liquid-glass mapper vs GPU: decided=${v.real.decided} wrong=${v.real.wrong} bright=${v.real.bright} | identity wrong=${v.identity.wrong}`);
  assert.ok(v.ok, v.why);
});

gpuTest('the oracle is sensitive to the lens geometry: the formula with the lens 12 px off disagrees', async (t) => {
  const { img, mapper } = await presentOnce(t, plugin, GEOMETRY, { scene });
  const right = lensState(240, 160);
  const off = lensState(252, 160);
  const good = agreement(img, /** @type {any} */ (mapper), scene).wrong;
  const formula = agreement(img, (p) => mapLensPoint(right, p), scene).wrong;
  const bad = agreement(img, (p) => mapLensPoint(off, p), scene).wrong;
  assert.ok(good <= 5 && formula <= 5, `the plugin's mapper ${good} and the formula ${formula} wrong px`);
  assert.ok(bad > 100, `the lens 12 px off: ${bad} wrong px`);
});

gpuTest('dispersion spreads red and blue only: the green channel stays where the mapper says', async (t) => {
  const { img, mapper } = await presentOnce(t, plugin, { ...GEOMETRY, dispersion: 1 }, { scene });
  const green = agreement(greenAsRed(img), /** @type {any} */ (mapper), scene);
  const red = agreement(img, /** @type {any} */ (mapper), scene);
  console.error(`liquid-glass dispersion 1: green wrong=${green.wrong}, red wrong=${red.wrong}`);
  assert.ok(green.wrong <= 5, `green channel: ${green.wrong} wrong px`);
  assert.ok(red.wrong > green.wrong, 'the red channel is really displaced (the fringes exist)');
});

gpuTest('a lens moving on its spring (stretched by its velocity): the newest mapper still predicts every pixel', async (t) => {
  const { rig, mappers } = await presentOnce(t, plugin, { ...GEOMETRY, pinned: false }, { scene });
  const r = rig.canvas.getBoundingClientRect();
  const t0 = performance.now();
  for (let k = 1; k <= 6; k += 1) {   // a pointer drag towards the lower right; each move asks for a frame
    rig.layerEl.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r.left + 240 + k * 30, clientY: r.top + 160 + k * 14 }));
    rig.tick(t0 + 100 + k * 16);
  }
  const img = rig.snap();
  const moving = agreement(img, /** @type {any} */ (mappers.at(-1)), scene);
  const first = agreement(img, /** @type {any} */ (mappers[0]), scene);
  console.error(`liquid-glass moving lens (${mappers.length} frames): newest wrong=${moving.wrong}, first-frame mapper wrong=${first.wrong}`);
  assert.ok(moving.wrong <= 5, `${moving.wrong} wrong px`);
  assert.ok(first.wrong > 100, 'the lens really moved: the mapper of the first frame no longer fits');
});

gpuTest('device loss: the host re-creates the plugin on a new device and the lens is drawn and mapped again', async (t) => {
  /** @type {any[]} */ const devices = [];
  const def = definePlugin({ ...plugin, async create(/** @type {any} */ ctx, /** @type {any} */ o) { devices.push(ctx.device); return plugin.create(ctx, o); } });
  const { rig, mappers } = await presentOnce(t, def, GEOMETRY, { scene });
  const before = mappers.length;
  devices[0].destroy();
  await until(() => devices.length >= 2);
  assert.equal(devices.length, 2, 'create() ran again on a new device');
  await new Promise((ok) => setTimeout(ok, 50));
  rig.tick(performance.now() + 50);
  const img = rig.snap();
  assert.ok(mappers.length > before, 'a frame was presented after the loss');
  const v = agreement(img, /** @type {any} */ (mappers.at(-1)), scene);
  assert.ok(v.bright > scene.centres.length * 80, `the frame after the loss is drawn (${v.bright} bright px)`);
  assert.ok(v.wrong <= 5, `and its mapper fits it: ${v.wrong} wrong px`);
  assert.ok(agreement(img, (p) => mapLensPoint(lensState(240, 160), p), scene).wrong <= 5, 'with the same pinned lens as before the loss');
});

gpuTest('the demo on the GPU: the lens tours the scene, every checked frame is mapped, and it ends at rest at home', async (t) => {
  const r = await runActionOnGpu(t, plugin, { ...GEOMETRY, pinned: false }, 'demo', {}, { maxMs: 6000 });
  console.error(`liquid-glass demo: state=${r.state} frames=${r.frames} checked=${r.checked} worst wrong=${r.worst?.wrong} changed=${r.maxChanged}`);
  assert.equal(r.state, 'free');
  assert.ok(r.frames / 60 < 4.5, `${(r.frames / 60).toFixed(2)} s of frames`);
  assert.ok(r.checked >= 10 && (r.worst?.wrong ?? 99) <= 5, `the worst checked frame: ${r.worst?.wrong} wrong px`);
  assert.ok(r.maxChanged > 2000, `the lens really moved (${r.maxChanged} px changed at most)`);
  assert.ok(changedPixels(r.last, r.first) < 50, `and came back home: ${changedPixels(r.last, r.first)} px differ from the first frame`);
  assert.equal(r.handle.enabled, true);
});

gpuTest('frost blurs only what the glass shows: the page around it is untouched', async (t) => {
  const clear = await presentOnce(t, plugin, { ...GEOMETRY }, { scene });
  const frosted = await presentOnce(t, plugin, { ...GEOMETRY, frost: 1 }, { scene });
  const lens = lensState(240, 160);
  const q = { sd: 0, gl: 1, nx: 0, ny: 0, nz: 1, t: 0 };
  /** CSS px from the lens edge (> 0 outside); its anti-aliased ring is the pixel next to sd = 0 */
  const edgeDistance = (/** @type {number} */ i, /** @type {number} */ j) => { lensSurface(lens, i + 0.5, j + 0.5, q); return q.sd / q.gl; };
  let changedIn = 0;
  let changedOut = 0;
  for (let j = 0; j < 320; j += 1) {
    for (let i = 0; i < 480; i += 1) {
      const k = (j * 480 + i) * 4;
      const diff = Math.abs(clear.img.data[k] - frosted.img.data[k]) + Math.abs(clear.img.data[k + 1] - frosted.img.data[k + 1]);
      const d = edgeDistance(i, j);
      if (diff > 12) { if (d > 1) changedOut += 1; else if (d < 0) changedIn += 1; }
    }
  }
  console.error(`liquid-glass frost: ${changedIn} px changed under the lens, ${changedOut} outside`);
  assert.ok(changedIn > 300, `frost changes the picture under the lens (${changedIn} px)`);
  assert.ok(changedOut === 0, `and nothing more than a pixel outside it (${changedOut} px)`);
});

gpuTest('GPU time of the pass at the gallery size (1100 x 620 CSS px, DPR 2): well inside a 120 Hz frame', async () => {
  const r = await measureGpuTime(plugin, { refraction: 0.7, dispersion: 0.5, x: 0.5, y: 0.5 });
  console.error(`liquid-glass GPU time ${r.w}x${r.h}: ${r.meanMs.toFixed(3)} ms/frame (clear-only pass ${r.baselineMs.toFixed(3)} ms), ${r.frames} frames back to back`);
  assert.ok(r.meanMs < 2, `${r.meanMs.toFixed(3)} ms per frame`);
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
  const handle = await host.addPlugin(first ?? plugin, first ? {} : { x: 0.7, y: 0.5 });
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

gpuTest('extended range: the glints of a moving lens are above white, the white panel under it is not, as a whole; a lens at rest shows nothing; on a standard target nothing is', async (t) => {
  const run = async (/** @type {boolean} */ hdr) => {
    const g = await rangeRig(t, hdr);
    const rest = g.frame();
    // the pointer sweeps over the white panel: the lens follows and stretches
    let busiest = rest;
    for (let k = 0; k <= 30; k += 1) { g.pointer('pointermove', 270 + 5 * k, 120 + 2 * k); const f = g.frame(); if (f.all > busiest.all) busiest = f; }
    let last = busiest;
    for (let k = 0; k < 240 && (k < 5 || last.all > 0); k += 1) last = g.frame();
    return { g, rest, busiest, last };
  };
  const on = await run(true);
  if (!on.g.host.stats().hdr) { console.error('liquid-glass' + SKIP); return; }
  console.error(`liquid-glass extended range: at most ${on.busiest.all} px above white in a frame of the sweep (${on.busiest.panel} of the ${on.busiest.panelArea} px of the white panel)`);
  assert.equal(on.rest.all, 0, 'the lens at rest over the white panel: nothing above white');
  assert.ok(on.busiest.all > 12, `the glints of the moving lens are above white: ${on.busiest.all} px`);
  assert.ok(on.busiest.all < 0.015 * 480 * 320, `a small part of the canvas: ${on.busiest.all} px`);
  assert.ok(on.busiest.panel < 0.05 * on.busiest.panelArea, `the white panel under the lens is not above white as a whole: ${on.busiest.panel} of ${on.busiest.panelArea} px`);
  assert.equal(on.last.all, 0, 'and once the lens has come to rest again: nothing');
  // control of the area check: a stage that lifts the whole picture puts the panel above white
  const up = await rangeRig(t, true, lifted());
  const all = up.frame();
  assert.ok(all.panel > 0.9 * all.panelArea, `control: a lifted panel is counted (${all.panel} of ${all.panelArea} px)`);
  // control of the range: the same sweep on a standard target
  const off = await run(false);
  assert.equal(off.g.host.stats().hdr, false);
  assert.equal(off.busiest.all, 0, 'standard range: an 8-bit target holds nothing above white');
});
