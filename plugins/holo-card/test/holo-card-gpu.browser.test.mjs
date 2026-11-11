// The holo-card input mapper against the pixels the GPU really produced (plugins/_shared/gpu-check.mjs), a card tilting on its spring,
// the action demo through the real host (every checked frame of the sweep agrees with its mapper), device loss, the GPU time of the pass, and
// extended range (the core of the glare above white, a white panel under it not, nothing at rest or on a standard target).
import { assert } from '/test/unit/lib/t.js';
import { agreement, checkMapperAgainstGpu, gpuAvailable, gpuTest, markerScene, presentOnce, runActionOnGpu, until } from '/plugins/_shared/gpu-check.mjs';
import { definePlugin } from '/src/effects/plugin-abi.js';
import { UNIFORM_FLOATS, mapCardPoint, plugin, writeCardPose } from '/plugins/holo-card/index.js';
import { measureGpuTime } from '/plugins/_shared/gpu-time.mjs';
import { makeRig } from '/test/unit/gpu-effects/lib/rig.mjs';
import { createEffectHost } from '/src/effects/effect-host.js';

console.error(`holo-card gpu tests: WebGPU ${(await gpuAvailable()) ? 'available' : 'NOT available'}`);

const scene = markerScene({ w: 480, h: 320 });
/** geometry only: no foil, no glare, so "bright" is decided by the sampled point alone. Idle sway gives a tilted pose at the first frame. */
const GEOMETRY = { tilt: 30, foil: 0, glare: 0, idle: true };

gpuTest('a tilted card: every presented pixel samples the source point the perspective mapper says; identity does not (positive control)', async (t) => {
  // the card is drawn at 0.86 of the canvas and tilted, so markers are smaller than painted: "markers visible" share 0.6 instead of 0.8
  const v = await checkMapperAgainstGpu(t, plugin, GEOMETRY, { scene, minBrightShare: 0.6 });
  console.error(`holo-card mapper vs GPU: decided=${v.real.decided} wrong=${v.real.wrong} bright=${v.real.bright} | identity wrong=${v.identity.wrong}`);
  assert.ok(v.ok, v.why);
});

gpuTest('the oracle is sensitive to the pose: the flat card (no tilt, same scale) disagrees with the tilted pixels', async (t) => {
  const { img, mapper } = await presentOnce(t, plugin, GEOMETRY, { scene });
  const flat = new Float32Array(UNIFORM_FLOATS);
  flat[2] = 480; flat[3] = 320;
  writeCardPose(flat, 0, 0, 0.86, 480, 320);
  const good = agreement(img, /** @type {any} */ (mapper), scene).wrong;
  const bad = agreement(img, (p) => mapCardPoint(flat, p), scene).wrong;
  assert.ok(good <= 5, `the plugin's mapper: ${good} wrong px`);
  assert.ok(bad > 100, `the flat card: ${bad} wrong px`);
});

gpuTest('the card tilting on its spring towards the pointer: the newest mapper still predicts every pixel', async (t) => {
  const { rig, mappers } = await presentOnce(t, plugin, { ...GEOMETRY, idle: false }, { scene });
  const r = rig.canvas.getBoundingClientRect();
  const t0 = performance.now();
  for (let k = 1; k <= 6; k += 1) {   // the pointer moves to the lower right; each move asks for a frame
    rig.layerEl.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r.left + 240 + k * 35, clientY: r.top + 160 + k * 22 }));
    rig.tick(t0 + 100 + k * 16);
  }
  const img = rig.snap();
  const moving = agreement(img, /** @type {any} */ (mappers.at(-1)), scene);
  const first = agreement(img, /** @type {any} */ (mappers[0]), scene);
  console.error(`holo-card tilting (${mappers.length} frames): newest wrong=${moving.wrong}, first-frame mapper wrong=${first.wrong}`);
  assert.ok(moving.wrong <= 5, `${moving.wrong} wrong px`);
  assert.ok(first.wrong > 100, 'the card really moved: the mapper of the first frame no longer fits');
});

gpuTest('the action demo through the real host: the card sweeps, every checked frame agrees with its own mapper, it resolves rest', async (t) => {
  const r = await runActionOnGpu(t, plugin, { ...GEOMETRY, idle: false }, 'demo', undefined, { scene, maxMs: 6000, checkEvery: 8 });
  console.error(`holo-card demo: ${r.frames} frames, ${r.checked} checked, at most ${r.maxChanged} px changed, worst mapper ${r.worst?.wrong} px wrong`);
  assert.equal(r.state, 'rest');
  assert.ok(r.frames >= 190 && r.frames <= 290, `the demo lasts about 3.2 s and settles: ${r.frames} frames at 60 Hz`);
  assert.ok(r.maxChanged > 2000, `the card moved: ${r.maxChanged} px changed`);
  assert.ok(r.worst !== null && r.checked >= 20 && r.worst.wrong <= 5, `a frame of the demo disagrees with its mapper on ${r.worst?.wrong} px`);
});

gpuTest('device loss: the host re-creates the plugin on a new device and the card is drawn and mapped again', async (t) => {
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
  assert.ok(v.bright > scene.centres.length * 50, `the frame after the loss is drawn (${v.bright} bright px)`);
  assert.ok(v.wrong <= 5, `and its mapper fits it: ${v.wrong} wrong px`);
});

gpuTest('GPU time of the pass at the gallery size (1100 x 620 CSS px, DPR 2): well inside a 120 Hz frame', async () => {
  const r = await measureGpuTime(plugin, {});
  console.error(`holo-card GPU time ${r.w}x${r.h}: ${r.meanMs.toFixed(3)} ms/frame (clear-only pass ${r.baselineMs.toFixed(3)} ms), ${r.frames} frames back to back`);
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

/** the pixels above white in a frame of the aboveWhite stage: all of them, their centre, and those inside the white panel as the flat card draws it */
function litPixels(/** @type {ImageData} */ img) {
  let all = 0, panel = 0, sx = 0, sy = 0;
  // the card is drawn at 0.86 of the canvas about its centre
  const x0 = 240 + (PANEL.x - 240) * 0.86, x1 = 240 + (PANEL.x + PANEL.w - 240) * 0.86, y0 = 160 + (PANEL.y - 160) * 0.86, y1 = 160 + (PANEL.y + PANEL.h - 160) * 0.86;
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      if (img.data[(y * img.width + x) * 4] < 128) continue;
      all += 1; sx += x; sy += y;
      if (x >= x0 && x < x1 && y >= y0 && y < y1) panel += 1;
    }
  }
  return { all, panel, panelArea: Math.round((x1 - x0) * (y1 - y0)), cx: all ? sx / all : NaN, cy: all ? sy / all : NaN };
}

/** the card over the panel page, then the aboveWhite stage; `first`: the stage before it instead of the card */
async function rangeRig(/** @type {any} */ t, /** @type {boolean} */ hdr, /** @type {any} */ first = null) {
  const rig = makeRig({ w: 480, h: 320, paint: paintPanel });
  rig.commit();
  const host = await createEffectHost(rig.env, rig.deps, rig.canvas, rig.source, { interposer: false, hdr });
  t.cleanup(() => host.destroy());
  await host.addPlugin(first ?? plugin, first ? {} : { idle: false });
  await host.addPlugin(aboveWhite());
  let now = performance.now() + 60;
  const r = rig.canvas.getBoundingClientRect();
  return {
    rig, host,
    frame() { now += 16; rig.tick(now); return litPixels(rig.snap()); },
    /** the pointer rests at a canvas point until the spring has settled */
    hover(/** @type {number} */ x, /** @type {number} */ y) {
      for (let k = 0; k < 90; k += 1) { rig.layerEl.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r.left + x, clientY: r.top + y })); now += 16; rig.tick(now); }
      return litPixels(rig.snap());
    },
  };
}

gpuTest('extended range: the core of the glare is above white and the white panel under it is not, as a whole; at rest nothing is; on a standard target nothing is', async (t) => {
  const on = await rangeRig(t, true);
  if (!on.host.stats().hdr) { console.error('holo-card extended range: SKIPPED, this browser does not take the extended tone mapping of a WebGPU canvas'); return; }
  const rest = on.frame();
  assert.equal(rest.all, 0, 'the card at rest, no pointer: nothing above white');
  // the pointer over the white panel: the card tilts to it and the glare sits under it
  const at = { x: 335, y: 150 };
  const lit = on.hover(at.x, at.y);
  console.error(`holo-card extended range: ${lit.all} px above white around ${lit.cx.toFixed(0)}, ${lit.cy.toFixed(0)}; ${lit.panel} of the ${lit.panelArea} px of the white panel`);
  assert.ok(lit.all > 150, `the core of the glare is above white: ${lit.all} px`);
  assert.ok(Math.hypot(lit.cx - at.x, lit.cy - at.y) < 30, `and it sits under the pointer: ${lit.cx.toFixed(0)}, ${lit.cy.toFixed(0)}`);
  assert.ok(lit.all < 0.02 * 480 * 320, `a small part of the canvas: ${lit.all} px`);
  assert.ok(lit.panel < 0.12 * lit.panelArea, `the white panel is not above white as a whole: ${lit.panel} of ${lit.panelArea} px`);
  // control of the area check: a stage that lifts the whole picture puts the panel above white
  const up = await rangeRig(t, true, lifted());
  const all = up.frame();
  assert.ok(all.panel > 0.6 * all.panelArea, `control: a lifted panel is counted (${all.panel} of ${all.panelArea} px)`);
  // control of the range: the same pointer on a standard target
  const off = await rangeRig(t, false);
  assert.equal(off.host.stats().hdr, false);
  assert.equal(off.hover(at.x, at.y).all, 0, 'standard range: an 8-bit target holds nothing above white');
});
