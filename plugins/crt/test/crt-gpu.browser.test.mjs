// The CRT input mapper against the pixels the GPU really produced (plugins/_shared/gpu-check.mjs): geometry only, then the full arcade
// look (thick scanlines, aperture grille, glow, warmth, flicker), the presets; device loss, and the GPU time.
import { assert } from '/test/unit/lib/t.js';
import { agreement, checkMapperAgainstGpu, gpuAvailable, gpuTest, markerScene, presentOnce, until } from '/plugins/_shared/gpu-check.mjs';
import { definePlugin } from '/src/effects/plugin-abi.js';
import { UNIFORM_FLOATS, bezelWidth, cornerRadius, mapCrtPoint, plugin, presets } from '/plugins/crt/index.js';
import { measureGpuTime } from '/plugins/_shared/gpu-time.mjs';
import { makeRig } from '/test/unit/gpu-effects/lib/rig.mjs';
import { createEffectHost } from '/src/effects/effect-host.js';

console.error(`crt gpu tests: WebGPU ${(await gpuAvailable()) ? 'available' : 'NOT available'}`);

const scene = markerScene({ w: 480, h: 320 });
/** geometry only: no glow halo, no misconvergence fringes, no flicker, so "bright" is decided by the sampled point alone */
const GEOMETRY = { curvature: 0.6, scanlines: 0.6, mask: 0, glow: 0, warmth: 0, flicker: 0, misconvergence: 0 };

/** The uniform block (geometry part) for a 480 x 320 frame at `curvature`. @param {number} curvature */
function crtState(curvature) {
  const s = new Float32Array(UNIFORM_FLOATS);
  s[0] = 480; s[1] = 320; s[2] = 480; s[3] = 320; s[4] = curvature * 0.5; s[5] = bezelWidth(480, 320); s[6] = cornerRadius(480, 320);
  return s;
}

/** @param {ImageData} img the brightest channel copied into the red one (agreement() reads red): behind the aperture grille every
 * pixel is one phosphor stripe, so the brightest channel is the light of that pixel */
function maxAsRed(img) {
  const out = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  for (let i = 0; i < out.data.length; i += 4) out.data[i] = Math.max(out.data[i], out.data[i + 1], out.data[i + 2]);
  return out;
}

gpuTest('every presented pixel samples the source point the barrel mapper says; identity does not (positive control)', async (t) => {
  // The screen shows the WHOLE source inside the bezel, so every marker is drawn smaller: about 0.80 of the painted area is bright at
  // curvature 0.6 (2818 of 3500 px, headless Chrome 154, Apple M1 Max); the share required is 0.7. The other two conditions (mapper at
  // most 5 wrong px, identity at least 200) are the kit's.
  const v = await checkMapperAgainstGpu(t, plugin, GEOMETRY, { scene, minBrightShare: 0.7 });
  console.error(`crt mapper vs GPU: decided=${v.real.decided} wrong=${v.real.wrong} bright=${v.real.bright} | identity wrong=${v.identity.wrong}`);
  assert.ok(v.ok, v.why);
});

gpuTest('the oracle is sensitive to the curvature: the formula at curvature 0.4 instead of 0.6 disagrees', async (t) => {
  const { img, mapper } = await presentOnce(t, plugin, GEOMETRY, { scene });
  const good = agreement(img, /** @type {any} */ (mapper), scene).wrong;
  const formula = agreement(img, (p) => mapCrtPoint(crtState(0.6), p), scene).wrong;
  const bad = agreement(img, (p) => mapCrtPoint(crtState(0.4), p), scene).wrong;
  assert.ok(good <= 5 && formula <= 5, `the plugin's mapper ${good} and the formula ${formula} wrong px`);
  assert.ok(bad > 100, `curvature 0.4: ${bad} wrong px`);
});

for (const [name, options] of /** @type {const} */ ([['arcade (the default)', {}], ['monitor', presets.monitor]])) {
  gpuTest(`the ${name} look (scanlines, aperture grille, glow, warmth, misconvergence) keeps every lit pixel where the mapper says`, async (t) => {
    const { img, mapper } = await presentOnce(t, plugin, { ...options, curvature: 1, flicker: 0 }, { scene });
    // the glow halo brightens the dark around each marker, so judge only pixels whose source point is more than 4 px from a marker edge
    const lit = agreement(maxAsRed(img), /** @type {any} */ (mapper), scene, 4);
    console.error(`crt ${name}: wrong=${lit.wrong} of ${lit.decided}, bright=${lit.bright}`);
    assert.ok(lit.wrong <= 5, `${lit.wrong} wrong px`);
  });
}

gpuTest('the arcade look really has thick scanlines and an RGB grille: lines alternate bright and dark, columns alternate R, G, B', async (t) => {
  const white = markerScene({ w: 480, h: 320, step: 1000, size: 160, first: { x: 240, y: 160 } });
  const { img } = await presentOnce(t, plugin, { curvature: 0, flicker: 0, misconvergence: 0 }, { scene: white });
  // one white square in the middle (the barrel keeps the centre in place), so every row and column there is lit by the beam
  const c = white.centres[0];
  const rows = [], cols = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let j = Math.round(c.y - 20); j < Math.round(c.y + 20); j += 1) {
    let sum = 0;
    for (let i = Math.round(c.x - 20); i < Math.round(c.x + 20); i += 1) {
      const k = (j * img.width + i) * 4;
      sum += img.data[k] + img.data[k + 1] + img.data[k + 2];
      for (let ch = 0; ch < 3; ch += 1) cols[i % 3][ch] += img.data[k + ch];
    }
    rows.push(sum);
  }
  const contrast = Math.max(...rows) / Math.max(1, Math.min(...rows));
  const dominant = cols.map((v) => v.indexOf(Math.max(...v)));
  console.error(`crt arcade structure: row contrast ${contrast.toFixed(2)}, dominant channel per column ${dominant}`);
  assert.ok(contrast > 1.08, `scanlines visible on white (brightest / darkest row ${contrast.toFixed(2)})`);
  assert.deepEqual([...dominant].sort(), [0, 1, 2], 'three neighbouring columns are red, green and blue phosphor stripes');
});

gpuTest('flicker and rolling bar animate brightness only: two instants of the animation share one mapper', async (t) => {
  const a = await presentOnce(t, plugin, { ...GEOMETRY, flicker: 1 }, { scene, offsetMs: 80 });
  const b = await presentOnce(t, plugin, { ...GEOMETRY, flicker: 1 }, { scene, offsetMs: 2900 });
  const wa = agreement(a.img, /** @type {any} */ (a.mapper), scene).wrong;
  const wb = agreement(b.img, /** @type {any} */ (a.mapper), scene).wrong;
  assert.ok(wa <= 5 && wb <= 5, `${wa} / ${wb} wrong px`);
});

gpuTest('device loss: the host re-creates the plugin on a new device and the screen is drawn and mapped again', async (t) => {
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
  assert.ok(v.bright > scene.centres.length * 60, `the frame after the loss is drawn (${v.bright} bright px)`);
  assert.ok(v.wrong <= 5, `and its mapper fits it: ${v.wrong} wrong px`);
});

gpuTest('GPU time of the pass at the gallery size (1100 x 620 CSS px, DPR 2): well inside a 120 Hz frame', async () => {
  const r = await measureGpuTime(plugin, {});
  console.error(`crt GPU time ${r.w}x${r.h}: ${r.meanMs.toFixed(3)} ms/frame (clear-only pass ${r.baselineMs.toFixed(3)} ms), ${r.frames} frames back to back`);
  assert.ok(r.meanMs < 2, `${r.meanMs.toFixed(3)} ms per frame`);
});

// ---- extended range ---------------------------------------------------------------------------------------------------------------------

/** a dark page with a large white panel */
const PANEL = { x: 250, y: 60, w: 190, h: 200 };
const paintPanel = (/** @type {CanvasRenderingContext2D} */ ctx) => {
  ctx.fillStyle = '#101826'; ctx.fillRect(0, 0, 480, 320);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(PANEL.x, PANEL.y, PANEL.w, PANEL.h);
  // thin bright strokes on the dark page: rules 1 and 2 px wide
  ctx.fillStyle = '#ffffff'; for (let y = 70; y <= 250; y += 20) ctx.fillRect(40, y, 170, y % 40 === 10 ? 1 : 2);
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
function litPixels(/** @type {ImageData} */ img, inset = 12) {
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
  const handle = await host.addPlugin(first ?? plugin, first ? {} : { flicker: 0 });
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

gpuTest('extended range: the bloom of thin white strokes is above white, modestly; the flat white panel is not; on a standard target nothing is', async (t) => {
  const on = await rangeRig(t, true);
  if (!on.host.stats().hdr) { console.error('crt' + SKIP); return; }
  const lit = on.frame();
  console.error(`crt extended range: ${lit.all} px above white around ${lit.cx.toFixed(0)}, ${lit.cy.toFixed(0)}; ${lit.panel} of the ${lit.panelArea} px inside the white panel`);
  assert.ok(lit.all > 100, `the strokes bloom above white: ${lit.all} px`);
  assert.ok(lit.cx > 60 && lit.cx < 210, `they are the rules on the left: centre x ${lit.cx.toFixed(0)}`);
  assert.ok(lit.all < 0.03 * 480 * 320, `a small part of the canvas: ${lit.all} px`);
  assert.ok(lit.panel < 0.01 * lit.panelArea, `the flat white panel does not bloom above white: ${lit.panel} of ${lit.panelArea} px inside it`);
  // control of the area check: a stage that lifts the whole picture puts the panel above white
  const up = await rangeRig(t, true, lifted());
  const all = up.frame();
  assert.ok(all.panel > 0.9 * all.panelArea, `control: a lifted panel is counted (${all.panel} of ${all.panelArea} px)`);
  // control of the range: a standard target
  const off = await rangeRig(t, false);
  assert.equal(off.host.stats().hdr, false);
  assert.equal(off.frame().all, 0, 'standard range: an 8-bit target holds nothing above white');
});
