// Shatter through the REAL effects host on a real WebGPU canvas: the assembled frame against the host's own passthrough (bit for bit), the
// mapper of the cracked pane against the GPU pixels, a click through the cracked glass, the cracks running from the impact, the fall,
// input blocking through the interposer, frame-cap independence, reduced motion, device loss and the submit wiring.
// Run: node test/unit/run.mjs plugins/shatter/test/shatter-gpu.browser.test.mjs
import { assert, sleep } from '/test/unit/lib/t.js';
import { checkMapperAgainstGpu, gpuAvailable, gpuTest } from '/plugins/_shared/gpu-check.mjs';
import { nonDominantShare } from '/test/unit/gpu-effects/lib/rig.mjs';
import { CONTROLS, DURATION, H, W, diff, diffNear, transitionRig } from '/plugins/_shared/transition-gpu-rig.mjs';
import { plugin } from '/plugins/shatter/index.js';
import { isNoTarget } from '/src/effects/no-target.js';
import { makeRig } from '/test/unit/gpu-effects/lib/rig.mjs';
import { createEffectHost } from '/src/effects/effect-host.js';
import { definePlugin } from '/src/effects/plugin-abi.js';

console.error(`shatter-gpu tests: WebGPU ${(await gpuAvailable()) ? 'available' : 'NOT available'}`);

const { reference, start } = transitionRig(plugin, { duration: DURATION });

gpuTest('idle: the presented frame equals the host passthrough bit for bit, and the mapper is the identity', async (t) => {
  const ref = await reference(t);
  const { rig, handle, mappers } = await start(t, { intro: false });
  rig.tick(performance.now());
  const d = diff(rig.snap(), ref);
  assert.equal(d.max, 0, `idle frame differs from the passthrough by up to ${d.max} levels`);
  const m = /** @type {any} */ (mappers.at(-1));
  assert.deepEqual(m({ x: 120, y: 60, width: W, height: H }), { x: 120, y: 60 });
});

gpuTest('cracked pane: the mapper agrees with the GPU pixels (the inverse of the offsets and of the bending), the identity does not', async (t) => {
  const verdict = await checkMapperAgainstGpu(t, plugin, { intro: false, state: 'cracked', impact: { x: 200, y: 150 }, edgeAmount: 0, glint: 0 });
  console.error(`shatter cracked mapper: ${verdict.real.wrong} wrong px of ${verdict.real.decided} (identity ${verdict.identity.wrong}), ${verdict.real.bright} bright`);
  assert.ok(verdict.ok, verdict.why);
});

gpuTest('a click through the cracked glass reaches the control drawn there; while the cracks run it is swallowed', async (t) => {
  const { rig, handle, mappers } = await start(t, { intro: false }, { interposer: true, html: CONTROLS });
  const btn = /** @type {HTMLButtonElement} */ (rig.layerEl.querySelector('#btn'));
  let clicks = 0;
  btn.addEventListener('click', () => { clicks += 1; });
  const press = () => {
    const r = rig.canvas.getBoundingClientRect();
    const cx = r.left + 100, cy = r.top + 60;
    const target = /** @type {Element} */ (document.elementFromPoint(cx, cy));
    const init = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, pointerId: 1, isPrimary: true, button: 0 };
    target.dispatchEvent(new PointerEvent('pointerdown', init));
    target.dispatchEvent(new PointerEvent('pointerup', init));
    target.dispatchEvent(new MouseEvent('click', { ...init, detail: 1 }));
  };
  const t0 = performance.now();
  rig.tick(t0);
  handle.trigger('crack', { point: { x: 120, y: 90 } });
  rig.tick(t0 + 10);
  rig.tick(t0 + 100);
  press();
  assert.equal(clicks, 0, 'the cracks are running: the press is swallowed');
  rig.tick(t0 + 600);
  const m = /** @type {any} */ (mappers.at(-1));
  const p = m({ x: 100, y: 60, width: W, height: H });
  assert.ok(!isNoTarget(p) && (p.x !== 100 || p.y !== 60), `cracked: the mapper moves the point (${p.x.toFixed(2)}, ${p.y.toFixed(2)})`);
  press();
  assert.equal(clicks, 1, 'cracked and still: the click reaches the button drawn under the pointer');
});

gpuTest('the second impact breaks the pane: mid frames non-blank, moving, input blocked; it ends on the source with the identity', async (t) => {
  const ref = await reference(t);
  const { rig, handle, mappers } = await start(t, { intro: false });
  const t0 = performance.now();
  rig.tick(t0);
  await Promise.all([handle.trigger('impact', { point: { x: 300, y: 120 } }), (async () => { rig.tick(t0 + 10); rig.tick(t0 + 600); })()]);
  const cracked = rig.snap();
  const dc = diff(cracked, ref);
  console.error(`shatter cracked pane vs source: ${dc.over} px`);
  assert.ok(dc.over > 500 && dc.over < 0.25 * W * H, 'cracked: crack lines and shifted pieces, the form still there');
  const done = handle.trigger('impact');
  rig.tick(t0 + 700);                                  // the clock of the fall starts here
  const shots = [];
  // physics 0.31, 0.48 and 0.65 s (the fall starts at 0.17 s): on this small canvas most shards have fallen out by 0.8 s
  for (const at of [0.18, 0.28, 0.38]) { rig.tick(t0 + 700 + DURATION * at); shots.push(rig.snap()); }
  const midMapper = /** @type {any} */ (mappers.at(-1));
  for (const img of shots) assert.ok(nonDominantShare(img) > 0.05, `mid frame non-blank (${nonDominantShare(img).toFixed(3)})`);
  const d01 = diff(shots[0], shots[1]), d0r = diff(shots[0], ref), d12 = diff(shots[1], shots[2]);
  console.error(`shatter mid frames: 18%->28% ${d01.over} px, 18% vs source ${d0r.over} px, 28%->38% ${d12.over} px`);
  assert.ok(d01.over > 2000 && d12.over > 2000 && d0r.over > 2000, 'frames move');
  assert.ok(isNoTarget(midMapper({ x: 120, y: 60, width: W, height: H })), 'input blocked mid-transition (NO_TARGET)');
  // out (1000 ms) + hold (300 ms) + in (1000 ms); step at 120 Hz to the end
  for (let now = t0 + 700 + 400; now <= t0 + 700 + 2400; now += 8.33) rig.tick(now);
  rig.tick(t0 + 3200);
  assert.equal(await done, 'intact', 'the play promise resolves with the end state: intact');
  const end = diff(rig.snap(), ref);
  assert.equal(end.max, 0, `reassembled frame differs from the source by up to ${end.max} levels (the cracks closed too)`);
  assert.deepEqual(/** @type {any} */ (mappers.at(-1))({ x: 120, y: 60, width: W, height: H }), { x: 120, y: 60 }, 'identity again');
});

gpuTest('frame-cap independence: the frame at 400 ms is the same at 120 Hz and at a 15 fps cap', async (t) => {
  const run = async (/** @type {number} */ every) => {
    const { rig, host, handle } = await start(t, { intro: false });
    const t0 = performance.now();
    rig.tick(t0);
    handle.trigger('out');
    for (let k = 0; k <= 48; k += 1) rig.tick(t0 + 10 + k * 8.33, k % every === 0 || k === 48);
    const img = rig.snap();
    host.destroy();
    rig.root.remove();
    return img;
  };
  const fast = await run(1), capped = await run(8);
  const d = diff(fast, capped);
  assert.ok(d.max <= 1, `the same instant differs by ${d.max} levels between 120 Hz and 15 fps`);
});

gpuTest('input: a click on a control is swallowed mid-transition and reaches it when idle (positive control)', async (t) => {
  const { rig, handle } = await start(t, { intro: false }, { interposer: true, html: CONTROLS });
  const btn = /** @type {HTMLButtonElement} */ (rig.layerEl.querySelector('#btn'));
  const txt = /** @type {HTMLInputElement} */ (rig.layerEl.querySelector('#txt'));
  let clicks = 0;
  btn.addEventListener('click', () => { clicks += 1; });
  const press = () => {
    const r = rig.canvas.getBoundingClientRect();
    const cx = r.left + 100, cy = r.top + 60;
    const target = /** @type {Element} */ (document.elementFromPoint(cx, cy));
    const init = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, pointerId: 1, isPrimary: true, button: 0 };
    target.dispatchEvent(new PointerEvent('pointerdown', init));
    target.dispatchEvent(new PointerEvent('pointerup', init));
    target.dispatchEvent(new MouseEvent('click', { ...init, detail: 1 }));
  };
  const t0 = performance.now();
  rig.tick(t0);
  press();
  assert.equal(clicks, 1, 'idle: the click reaches the button');
  txt.focus();
  handle.trigger('play');
  rig.tick(t0 + 10);
  rig.tick(t0 + 10 + DURATION * 0.4);
  press();
  assert.equal(clicks, 1, 'mid-transition: no click reached the button');
  assert.equal(document.activeElement, txt, 'NO_TARGET: the host swallowed the press, so the focused field keeps the focus (keyboard input still reaches it)');
});

gpuTest('prefers-reduced-motion: a crossfade, no pixel moves (each pixel is the source mixed with the backdrop)', async (t) => {
  const ref = await reference(t);
  const { rig, handle } = await start(t, { intro: false, reducedMotion: true });
  const t0 = performance.now();
  rig.tick(t0);
  assert.equal(await handle.trigger('crack'), 'intact', 'nothing cracks: it resolves at once with the state it rests in');
  rig.tick(t0 + 5);
  assert.equal(diff(rig.snap(), ref).max, 0, 'the frame is the source');
  handle.trigger('impact');
  rig.tick(t0 + 10);
  rig.tick(t0 + 10 + DURATION * 0.5);
  const img = rig.snap();
  const back = [0.004, 0.018, 0.034].map((v) => v * 255);
  let worst = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    for (let c = 0; c < 3; c += 1) worst = Math.max(worst, Math.abs(img.data[i + c] - (ref.data[i + c] * 0.5 + back[c] * 0.5)));
  }
  assert.ok(worst <= 2, `crossfade at 50%: worst channel error ${worst.toFixed(1)} levels`);
  assert.ok(diff(img, ref).over > 1000, 'and it is not the source (positive control)');
});

gpuTest('device loss mid-transition: the plugin comes back assembled (no intro), with the identity mapper; the pending trigger resolves null', async (t) => {
  const ref = await reference(t);
  const { rig, handle, devices, mappers } = await start(t, { intro: true });
  const t0 = performance.now();
  for (let now = t0; now <= t0 + DURATION + 100; now += 50) rig.tick(now);   // the intro, to its end
  const pending = handle.trigger('out');
  rig.tick(t0 + DURATION + 150);
  rig.tick(t0 + DURATION + 450);
  devices[0].destroy();
  for (let i = 0; i < 200 && devices.length < 2; i += 1) await sleep(10);
  assert.equal(devices.length, 2, 'created again on a new device');
  assert.equal(await pending, null, 'the action died with the device');
  rig.tick(performance.now());
  assert.equal(diff(rig.snap(), ref).max, 0, 'assembled frame right after the recovery');
  assert.deepEqual(/** @type {any} */ (mappers.at(-1))({ x: 5, y: 6, width: W, height: H }), { x: 5, y: 6 });
});

gpuTest('intro and submit wiring: the shards fly together; an invalid submit cracks, a second one breaks it, a valid one heals the cracks', async (t) => {
  const ref = await reference(t);
  const { rig, handle } = await start(t, { intro: true, onSubmit: 'invalid' }, { html: CONTROLS });
  const t0 = performance.now();
  rig.tick(t0);
  assert.ok(nonDominantShare(rig.snap()) < 0.01, 'the intro starts with every shard gone (only the backdrop)');
  rig.tick(t0 + DURATION * 0.5);
  assert.ok(nonDominantShare(rig.snap()) > 0.05, 'halfway the shards are on their way in');
  for (let now = t0 + 550; now <= t0 + DURATION + 100; now += 50) rig.tick(now);
  assert.equal(diff(rig.snap(), ref).max, 0, 'the intro ends on the source');
  const form = /** @type {HTMLFormElement} */ (rig.layerEl.querySelector('#f'));
  const mail = /** @type {HTMLInputElement} */ (rig.layerEl.querySelector('#mail'));
  form.addEventListener('submit', (e) => e.preventDefault());   // the page's own handler (a real submit would navigate the test page)
  let now = t0 + DURATION + 200;
  form.requestSubmit();
  rig.tick(now); rig.tick(now += 300);
  assert.equal(diff(rig.snap(), ref).max, 0, 'valid form: nothing happens');
  mail.value = 'nope';
  form.requestSubmit();
  rig.tick(now += 10); rig.tick(now += 600);
  const cracked = diff(rig.snap(), ref).over;
  assert.ok(cracked > 500 && cracked < 0.25 * W * H, `invalid email: the pane cracks (${cracked} px), the form still there`);
  mail.value = 'ada@example.com';
  form.requestSubmit();
  rig.tick(now += 10); rig.tick(now += 600);
  assert.equal(diff(rig.snap(), ref).max, 0, 'fixed and submitted again: the cracks close');
  mail.value = 'nope';
  form.requestSubmit();
  rig.tick(now += 10); rig.tick(now += 600);
  form.requestSubmit();
  rig.tick(now += 10); rig.tick(now += DURATION * 0.35);
  assert.ok(diff(rig.snap(), ref).over > 0.3 * W * H, 'a second invalid submit breaks the pane');
});


gpuTest('the cracks start at the pointer: first crack lines only near it, then the shards near it move first', async (t) => {
  const ref = await reference(t);
  const { rig, handle } = await start(t, { intro: false, pieces: 40 });
  const t0 = performance.now();
  rig.tick(t0);
  const r = rig.canvas.getBoundingClientRect();
  rig.layerEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + 380, clientY: r.top + 80 }));
  handle.trigger('crack');
  rig.tick(t0 + 10);
  rig.tick(t0 + 10 + 25);                            // 25 ms of the 450 ms the cracks take: they have run about 70 px
  const crack = rig.snap();
  const nearCrack = diffNear(crack, ref, 380, 80, 60), farCrack = diffNear(crack, ref, 80, 260, 60);
  rig.tick(t0 + 600);
  const cracked = rig.snap();
  const farLater = diffNear(cracked, ref, 80, 260, 60);
  handle.trigger('impact');
  rig.tick(t0 + 610);
  rig.tick(t0 + 610 + DURATION * (0.25 / 1.7));     // physics 250 ms: the fall started at 170 ms, near the impact first
  const early = rig.snap();
  const nearMove = diffNear(early, cracked, 380, 80, 60), farMove = diffNear(early, cracked, 80, 260, 60);
  console.error(`shatter impact at (380, 80): crack lines near ${nearCrack} px / far ${farCrack} px (later ${farLater}); fell near ${nearMove} px / far ${farMove} px`);
  assert.ok(nearCrack > 50 && farCrack === 0, 'crack lines appear around the impact first');
  assert.ok(farLater > 0, 'and reach the far corner later');
  assert.ok(nearMove > 3000 && nearMove > 10 * farMove, 'shards near the impact fall first');
});

gpuTest('after a play from an off-centre impact the last frame equals the source at every sampled pixel and the mapper is the identity', async (t) => {
  const ref = await reference(t);
  const { rig, handle, mappers } = await start(t, { intro: false });
  const t0 = performance.now();
  rig.tick(t0);
  handle.trigger('play', { point: { x: 100, y: 100 } });
  for (let now = t0 + 10; now <= t0 + 2500; now += 33) rig.tick(now);
  const img = rig.snap();
  const m = /** @type {any} */ (mappers.at(-1));
  let wrong = 0;
  for (let y = 5; y < H; y += 23) for (let x = 5; x < W; x += 29) {
    const p = m({ x: x + 0.5, y: y + 0.5, width: W, height: H });
    const a = ((Math.floor(p.y)) * W + Math.floor(p.x)) * 4, b = (y * W + x) * 4;
    if (a !== b || img.data[b] !== ref.data[a]) wrong += 1;
  }
  assert.equal(wrong, 0);
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
  const handle = await host.addPlugin(first ?? plugin, first ? {} : { intro: false, onSubmit: 'off' });
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

gpuTest('extended range: the flash of the strike and its glints are above white, the white panel around the impact is not, as a whole; the intact and the cracked pane at rest show nothing; a falling shard flashes; on a standard target nothing is', async (t) => {
  const on = await rangeRig(t, true);
  if (!on.host.stats().hdr) { console.error('shatter' + SKIP); return; }
  assert.equal(on.frame().all, 0, 'the intact pane: nothing above white');
  // a strike inside the white panel
  const at = { x: 345, y: 160 };
  let state = '';
  on.handle.trigger('crack', { point: at }).then((/** @type {any} */ s) => { state = s; });
  let lit = on.frame();
  for (let k = 0; k < 4; k += 1) lit = on.frame();   // 80 ms into the cracks: the flash is near its brightest
  console.error(`shatter extended range, the strike: ${lit.all} px above white around ${lit.cx.toFixed(0)}, ${lit.cy.toFixed(0)}; ${lit.panel} of the ${lit.panelArea} px of the white panel`);
  assert.ok(lit.all > 150, `the flash is above white: ${lit.all} px`);
  assert.ok(Math.hypot(lit.cx - at.x, lit.cy - at.y) < 40, `around the impact: ${lit.cx.toFixed(0)}, ${lit.cy.toFixed(0)}`);
  assert.ok(lit.panel < 0.25 * lit.panelArea, `the white panel is not above white as a whole: ${lit.panel} of ${lit.panelArea} px`);
  for (let k = 0; k < 80 && !state; k += 1) { on.frame(); await new Promise((ok) => setTimeout(ok, 0)); }   // the cracks run out (450 ms on the frame clock)
  assert.equal(state, 'cracked');
  assert.equal(on.frame().all, 0, 'the cracked pane at rest: nothing above white (the white panel under its facets and crack lines included)');
  // the fall: a face that mirrors the key light flashes above white; the falling panel never does as a whole
  on.handle.trigger('out');
  let most = 0;
  for (let k = 0; k < 70; k += 1) most = Math.max(most, on.frame().all);
  console.error(`shatter extended range, the fall: at most ${most} px above white in a frame`);
  assert.ok(most > 20, `a falling shard flashes above white: ${most} px at most`);
  assert.ok(most < 0.06 * 480 * 320, `a small part of the canvas in every frame: ${most} px at most`);
  // control of the area check: a stage that lifts the whole picture puts the panel above white
  const up = await rangeRig(t, true, lifted());
  const all = up.frame();
  assert.ok(all.panel > 0.9 * all.panelArea, `control: a lifted panel is counted (${all.panel} of ${all.panelArea} px)`);
  // control of the range: the same strike on a standard target
  const off = await rangeRig(t, false);
  assert.equal(off.host.stats().hdr, false);
  off.frame();
  off.handle.trigger('crack', { point: at });
  let dim = off.frame();
  for (let k = 0; k < 4; k += 1) dim = off.frame();
  assert.equal(dim.all, 0, 'standard range: an 8-bit target holds nothing above white');
}, { timeout: 30000 });
