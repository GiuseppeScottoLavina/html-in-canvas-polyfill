// The ink plugin through the real effects host on a real WebGPU canvas (headless Chrome): the input mapper against the pixels the GPU
// produced (not against its own formula), the frame at rest against the host's picture without any plugin, the pigment over a bright and
// over a dark page, each action through the effect handle, zero work at rest, and the GPU and CPU time of a frame.
import { assert } from '/test/unit/lib/t.js';
import { makeRig } from '/test/unit/gpu-effects/lib/rig.mjs';
import { createEffectHost } from '/src/effects/effect-host.js';
import { agreement, changedPixels, checkMapperAgainstGpu, gpuAvailable, gpuTest, identity, markerScene, presentOnce, runActionOnGpu } from '/plugins/_shared/gpu-check.mjs';
import { INK_LIFE, meta, plugin } from '/plugins/ink/index.js';

console.error(`ink-gpu tests: WebGPU ${(await gpuAvailable()) ? 'available' : 'NOT available'}`);

const scene = markerScene({ w: 480, h: 320 });
const later = () => new Promise((r) => setTimeout(r, 0));

/** Two strokes of a pressed mouse across the canvas, by the plugin's own listeners (the tests that use them set pigment 0, so that the markers keep their brightness, and intensity 0.25, so that no marker is squeezed past recognition). @param {any} rig */
function strokes(rig) {
  const r = rig.canvas.getBoundingClientRect();
  const at = (/** @type {string} */ type, /** @type {number} */ x, /** @type {number} */ y) => rig.layerEl.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: r.left + x, clientY: r.top + y, buttons: type === 'pointerup' ? 0 : 1, pointerType: 'mouse' }));
  at('pointerdown', 60, 100);
  for (let i = 0; i <= 30; i += 1) at('pointermove', 60 + 12 * i, 100 + 60 * Math.sin(i / 5));
  at('pointerup', 420, 220);
  at('pointerdown', 420, 220);
  for (let i = 0; i <= 30; i += 1) at('pointermove', 420 - 12 * i, 220 - 50 * Math.sin(i / 4));
  at('pointerup', 60, 220);
}

/** What the host presents for a scene with no plugin at all. @param {any} t @param {any} s */
async function reference(t, s) {
  const rig = makeRig({ w: s.w, h: s.h, paint: s.paint });
  rig.commit();
  const host = await createEffectHost(rig.env, rig.deps, rig.canvas, rig.source, { interposer: false });
  t.cleanup(() => host.destroy());
  rig.tick(performance.now());
  return rig.snap();
}
/** pixels that differ at all, and the largest difference @param {ImageData} a @param {ImageData} b */
function exact(a, b) {
  let n = 0, max = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
    if (d) { n += 1; max = Math.max(max, d); }
  }
  return { n, max };
}

gpuTest('every presented pixel samples the source point the ink mapper says (pixel-exact, 150k pixels), the identity does not (positive control)', async (t) => {
  const v = await checkMapperAgainstGpu(t, plugin, { intensity: 0.25, pigment: 0 }, { scene, before: strokes, offsetMs: 200 });
  console.error(`ink mapper vs GPU: decided=${v.real.decided} wrong=${v.real.wrong} (${(v.real.share * 100).toFixed(4)}%) brightPx=${v.real.bright} | identity wrong=${v.identity.wrong} (${(v.identity.share * 100).toFixed(3)}%)`);
  assert.ok(v.ok, v.why);
  assert.ok(v.real.wrong * 40 < v.identity.wrong);
});

gpuTest('a mapper of another instant disagrees measurably: the oracle is sensitive to the simulated field', async (t) => {
  const { img, mapper } = await presentOnce(t, plugin, { intensity: 0.25, pigment: 0 }, { scene, before: strokes, offsetMs: 200 });
  const { rig, mappers, at } = await presentOnce(t, plugin, { intensity: 0.25, pigment: 0 }, { scene, before: strokes, offsetMs: 200 });
  for (let k = 1; k <= 6; k += 1) rig.tick(at + k * 50);
  const good = agreement(img, /** @type {any} */ (mapper), scene).wrong;
  const wrong = agreement(img, /** @type {any} */ (mappers.at(-1)), scene).wrong;
  assert.ok(good <= 5 && wrong > 100 && wrong > good * 20, `another instant: ${wrong} wrong pixels vs ${good}`);
});

gpuTest('where the effect does nothing the picture is the source, bit for bit: the whole frame at intensity 0 and before any input, and every pixel outside the stirred region while a gentle stroke displaces the rest', async (t) => {
  const text = {
    w: 480, h: 320,
    paint(/** @type {CanvasRenderingContext2D} */ ctx) {
      const g = ctx.createLinearGradient(0, 0, 480, 320); g.addColorStop(0, '#fdf6e3'); g.addColorStop(1, '#16324f');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 480, 320);
      ctx.fillStyle = '#0b1622'; ctx.font = '15px sans-serif';
      for (let y = 20; y < 320; y += 22) ctx.fillText('The page stays the page where the ink is at rest 0123456789', 8, y);
      ctx.fillStyle = 'rgba(255, 80, 120, 0.5)'; ctx.fillRect(300, 40, 120, 60);
    },
  };
  const plain = await reference(t, text);
  const off = await presentOnce(t, plugin, { intensity: 0 }, { scene: /** @type {any} */ (text), before: strokes });
  assert.deepEqual(exact(off.img, plain), { n: 0, max: 0 }, 'intensity 0: the passthrough of the host');
  const idle = await presentOnce(t, plugin, { ...meta.defaults }, { scene: /** @type {any} */ (text) });
  assert.deepEqual(exact(idle.img, plain), { n: 0, max: 0 }, 'before any input: the passthrough of the host');
  // a short, slow stroke in the upper left corner: far from it the water moves slower than the page lets go
  const gentle = (/** @type {any} */ rig) => {
    const r = rig.canvas.getBoundingClientRect();
    for (let i = 0; i <= 6; i += 1) rig.layerEl.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r.left + 60 + 5 * i, clientY: r.top + 60, buttons: 0, pointerType: 'mouse' }));
  };
  const stirred = await presentOnce(t, plugin, { intensity: 1 }, { scene: /** @type {any} */ (text), before: gentle, offsetMs: 60 });
  let inside = 0, outside = 0, far = 0;
  const m = /** @type {any} */ (stirred.mapper);
  for (let y = 0; y < 320; y += 1) for (let x = 0; x < 480; x += 1) {
    const i = (y * 480 + x) * 4;
    const differs = stirred.img.data[i] !== plain.data[i] || stirred.img.data[i + 1] !== plain.data[i + 1] || stirred.img.data[i + 2] !== plain.data[i + 2];
    const q = m({ x: x + 0.5, y: y + 0.5, width: 480, height: 320 });
    const still = q.x === x + 0.5 && q.y === y + 0.5;
    if (still) { far += 1; if (differs) outside += 1; } else if (differs) inside += 1;
  }
  console.error(`ink at rest: ${far} px that the mapper leaves alone, ${outside} of them differ from the source; ${inside} px changed where it displaces`);
  assert.ok(far > 60000, `most of the page is not displaced (${far} px)`);
  assert.equal(outside, 0, 'every pixel that is not displaced is the source texel');
  assert.ok(inside > 300, `control: the stroke changed ${inside} px`);
});

gpuTest('the pigment shows over a bright page and over a dark one: it darkens and colours white, it lights up black; without pigment (control) a uniform page shows nothing', async (t) => {
  const flat = (/** @type {string} */ color) => ({ w: 480, h: 320, paint(/** @type {CanvasRenderingContext2D} */ ctx) { ctx.fillStyle = color; ctx.fillRect(0, 0, 480, 320); } });
  const press = (/** @type {any} */ rig) => {
    const r = rig.canvas.getBoundingClientRect();
    const at = (/** @type {string} */ type, /** @type {number} */ x, /** @type {number} */ y) => rig.layerEl.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: r.left + x, clientY: r.top + y, buttons: 1, pointerType: 'mouse' }));
    at('pointerdown', 100, 160);
    for (let i = 1; i <= 24; i += 1) at('pointermove', 100 + 12 * i, 160 + 30 * Math.sin(i / 4));
  };
  /** @param {string} color @param {number} pigment */
  const look = async (color, pigment) => {
    const { img } = await presentOnce(t, plugin, { intensity: 1, pigment }, { scene: /** @type {any} */ (flat(color)), before: press, offsetMs: 120 });
    let changed = 0, lo = 255, hi = 0, colour = 0;
    const base = color === '#ffffff' ? [255, 255, 255] : [0, 0, 0];   // the paper (the water may move as far as the corners: its sheen is no pigment)
    for (let i = 0; i < img.data.length; i += 4) {
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2], l = Math.max(r, g, b);
      if (Math.abs(r - base[0]) > 16 || Math.abs(g - base[1]) > 16 || Math.abs(b - base[2]) > 16) { changed += 1; colour = Math.max(colour, l - Math.min(r, g, b)); }
      lo = Math.min(lo, l); hi = Math.max(hi, l);
    }
    return { changed, lo, hi, colour, base };
  };
  const white = await look('#ffffff', 1), black = await look('#000000', 1), none = await look('#ffffff', 0), dark = await look('#000000', 0);
  console.error(`ink pigment: on white ${white.changed} px changed, darkest ${white.lo}, chroma up to ${white.colour}; on black ${black.changed} px changed, brightest ${black.hi}; without pigment ${none.changed} px on white, brightest ${dark.hi} on black (the sheen alone)`);
  assert.ok(white.changed > 3000 && white.lo < 200 && white.colour > 120, 'ink on white paper: darker, and coloured');
  assert.ok(black.changed > 3000 && black.hi > 110, 'over black the scattered light of the pigment shows');
  assert.equal(none.changed, 0, 'control: pigment 0 leaves a uniform white page uniform (the displacement alone shows nothing there, the sheen less than 16 levels)');
  assert.ok(dark.hi < 100 && dark.hi > 20, 'control: over black without pigment only the sheen of the water shows, dimmer than the light the pigment scatters');
});

/** A press at rest (no move before it) at (x, y) of the canvas: a drop. @param {number} x @param {number} y */
const tap = (x, y) => (/** @type {any} */ rig) => {
  const r = rig.canvas.getBoundingClientRect();
  for (const type of ['pointerdown', 'pointerup']) rig.layerEl.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: r.left + x, clientY: r.top + y, buttons: type === 'pointerdown' ? 1 : 0, pointerType: 'mouse' }));
};

gpuTest('a drop that blooms: every presented pixel samples the source point the mapper says while the drop pushes the page outwards (pixel-exact), the identity does not (control)', async (t) => {
  const v = await checkMapperAgainstGpu(t, plugin, { ...meta.defaults, pigment: 0 }, { scene, before: tap(240, 160), offsetMs: 180 });
  console.error(`ink bloom mapper vs GPU: decided=${v.real.decided} wrong=${v.real.wrong} | identity wrong=${v.identity.wrong}`);
  assert.ok(v.ok, v.why);
});

gpuTest('a drop over white paper: it lands as a full disc, its ink moves outwards and gathers in a rim denser than its middle (control: the disc at landing is not), then everything is gone and the frame is the source', async (t) => {
  const white = { w: 480, h: 320, paint(/** @type {CanvasRenderingContext2D} */ ctx) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 480, 320); } };
  const { rig, host, at } = await presentOnce(t, plugin, { ...meta.defaults }, { scene: /** @type {any} */ (white), before: tap(240, 160), offsetMs: 16 });
  /** the ink of a frame (255 - the darkest channel) around the drop: its mean radius, and the mean ink in rings 4 px wide @param {ImageData} img */
  const profile = (img) => {
    const rings = new Float64Array(30), counts = new Float64Array(30);
    let mass = 0, moment = 0;
    for (let y = 40; y < 280; y += 1) for (let x = 120; x < 360; x += 1) {
      const i = (y * 480 + x) * 4, ink = 255 - Math.min(img.data[i], img.data[i + 1], img.data[i + 2]), r = Math.hypot(x + 0.5 - 240, y + 0.5 - 160);
      mass += ink; moment += ink * r;
      if (r < 120) { rings[Math.floor(r / 4)] += ink; counts[Math.floor(r / 4)] += 1; }
    }
    const ring = [...rings].map((v, k) => v / Math.max(1, counts[k]));
    const middle = (ring[0] + ring[1]) / 2, rim = Math.max(...ring.slice(2));
    return { radius: moment / Math.max(1, mass), mass, middle, rim };
  };
  const first = profile(rig.snap());
  let now = at;
  const until = (/** @type {number} */ ms) => { while (now < at + ms) { now += 1000 / 60; rig.tick(now); } return profile(rig.snap()); };
  const mid = until(150), late = until(400);
  console.error(`ink drop: mean radius ${first.radius.toFixed(1)} -> ${mid.radius.toFixed(1)} -> ${late.radius.toFixed(1)} px; middle / rim ${first.middle.toFixed(0)} / ${first.rim.toFixed(0)} at landing, ${mid.middle.toFixed(0)} / ${mid.rim.toFixed(0)} at 150 ms, ${late.middle.toFixed(0)} / ${late.rim.toFixed(0)} at 400 ms`);
  assert.ok(first.mass > 1000 && first.radius < 14, 'it lands as a small disc');
  assert.ok(mid.radius > 1.8 * first.radius && late.radius > mid.radius, 'its ink moves outwards');
  assert.ok(first.rim < 1.2 * first.middle, 'control: the disc at landing is full (its middle about as dark as its edge)');
  assert.ok(late.rim > 1.5 * late.middle, 'the spread drop has a rim denser than its middle');
  const frames = host.stats().frames;
  for (let i = 0; i < 400; i += 1) { const before = host.stats().frames; now += 1000 / 60; rig.tick(now); if (host.stats().frames === before) break; }
  console.error(`ink drop: at rest after ${((host.stats().frames - frames) / 60 + 0.4).toFixed(2)} s`);
  assert.ok((host.stats().frames - frames) / 60 < INK_LIFE + 0.5, 'and comes to rest');
  const clean = rig.snap();
  assert.ok(clean.data.every((v) => v === 255), 'the frame at rest is the white page');
}, { timeout: 30000 });

gpuTest('the sheen of moving water: a hover over a uniform grey page lightens it where the surface tilts towards the light and darkens it where it tilts away, only where the page moves; at intensity 0 (control) the page stays uniform', async (t) => {
  const grey = { w: 480, h: 320, paint(/** @type {CanvasRenderingContext2D} */ ctx) { ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, 480, 320); } };
  const hover = (/** @type {any} */ rig) => {
    const r = rig.canvas.getBoundingClientRect();
    for (let i = 0; i <= 30; i += 1) rig.layerEl.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r.left + 60 + 12 * i, clientY: r.top + 160 + 40 * Math.sin(i / 5), buttons: 0, pointerType: 'mouse' }));
  };
  /** @param {number} intensity */
  const look = async (intensity) => {
    const { img, mapper } = await presentOnce(t, plugin, { ...meta.defaults, intensity }, { scene: /** @type {any} */ (grey), before: hover, offsetMs: 100 });
    let lighter = 0, darker = 0, outside = 0;
    for (let y = 0; y < 320; y += 1) for (let x = 0; x < 480; x += 1) {
      const v = img.data[(y * 480 + x) * 4], q = /** @type {any} */ (mapper)({ x: x + 0.5, y: y + 0.5, width: 480, height: 320 });
      if (q.x === x + 0.5 && q.y === y + 0.5) { if (v !== 128) outside += 1; } else if (v >= 131) lighter += 1; else if (v <= 125) darker += 1;
    }
    return { lighter, darker, outside };
  };
  const wet = await look(meta.defaults.intensity), dry = await look(0);
  console.error(`ink sheen on grey: ${wet.lighter} px lighter and ${wet.darker} px darker by 3 levels or more where the page moves, ${wet.outside} px changed where it does not; at intensity 0: ${dry.lighter + dry.darker + dry.outside} px`);
  assert.ok(wet.lighter > 200 && wet.darker > 200, 'the moving water shows its surface');
  assert.equal(wet.outside, 0, 'nothing where the page does not move');
  assert.equal(dry.lighter + dry.darker + dry.outside, 0, 'control: intensity 0');
});

gpuTest('the action demo through the effect handle: the stroke changes the picture, every checked frame agrees with its mapper, it resolves still within 4.6 s and ends on the source', async (t) => {
  // without pigment, so that the markers keep their brightness and the mapper can be judged on every frame
  const r = await runActionOnGpu(t, plugin, { ...meta.defaults, pigment: 0 }, 'demo', {}, { scene, stepMs: 1000 / 60, maxMs: 7000, checkEvery: 6 });
  const ms = (r.frames * 1000) / 60;
  console.error(`ink demo (no pigment): ${r.frames} frames (${Math.round(ms)} ms), max changed ${r.maxChanged} px, worst mapper disagreement ${r.worst?.wrong} px of ${r.worst?.decided} (${r.checked} frames checked)`);
  assert.equal(r.state, 'still');
  assert.ok(r.maxChanged > 300, `the stroke moves the page: ${r.maxChanged} px changed`);
  assert.ok(r.worst && r.worst.wrong <= 5, `input follows the pixels while the page moves: ${r.worst?.wrong} px disagree`);
  assert.deepEqual(exact(r.last, r.first), { n: 0, max: 0 }, 'it ends at rest: the last frame is the first, bit for bit');
  // with pigment: the same, and the pigment is gone at the end
  const p = await runActionOnGpu(t, plugin, { ...meta.defaults }, 'demo', {}, { scene, stepMs: 1000 / 60, maxMs: 7000, checkEvery: 1000 });
  const pms = (p.frames * 1000) / 60;
  console.error(`ink demo: ${p.frames} frames (${Math.round(pms)} ms)`);
  assert.equal(p.state, 'still');
  assert.ok(pms < 4600 && pms > 1300 + INK_LIFE * 1000, `the demo ends at rest after ${Math.round(pms)} ms`);
  assert.deepEqual(exact(p.last, p.first), { n: 0, max: 0 }, 'no pigment is left: the last frame is the first, bit for bit');
}, { timeout: 40000 });

gpuTest('the actions stir and clear through the effect handle: stir draws its stroke at the point; clear wipes flow, displacement and pigment at once and resolves with the frame that shows the source', async (t) => {
  const { rig, handle, host, img: first } = await presentOnce(t, plugin, { ...meta.defaults }, { scene });
  let now = performance.now() + 100;
  const tick = (/** @type {number} */ n = 1) => { for (let i = 0; i < n; i += 1) { rig.tick(now); now += 1000 / 60; } };
  let state = null;
  handle.trigger('stir', { point: { x: 240, y: 160 }, angle: 0, strength: 1 }).then((/** @type {any} */ v) => { state = v; });
  tick(30);
  const mid = rig.snap();
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < 320; y += 1) for (let x = 0; x < 480; x += 1) {
    const i = (y * 480 + x) * 4;
    if (Math.abs(mid.data[i] - first.data[i]) > 16 || Math.abs(mid.data[i + 1] - first.data[i + 1]) > 16 || Math.abs(mid.data[i + 2] - first.data[i + 2]) > 16) { sx += x; sy += y; n += 1; }
  }
  console.error(`ink stir: ${n} px changed after 0.5 s, centred at (${(sx / n).toFixed(0)}, ${(sy / n).toFixed(0)})`);
  assert.ok(n > 2000 && Math.abs(sy / n - 160) < 25 && Math.abs(sx / n - 250) < 70, 'the stroke lies along y = 160, through the point, carried a little its own way');
  assert.equal(state, null, 'still moving');
  let cleared = null;
  handle.trigger('clear').then((/** @type {any} */ v) => { cleared = v; });
  await later();
  assert.equal(state, null, 'the stir is superseded: null');
  tick(1);
  const after = rig.snap();
  await later();
  assert.equal(cleared, 'still');
  assert.deepEqual(exact(after, first), { n: 0, max: 0 }, 'the frame that resolves clear is the source, bit for bit');
  const frames = host.stats().frames;
  tick(30);
  assert.equal(host.stats().frames, frames, 'and the host is idle after it');
  // ink released after a clear starts from empty textures: nothing of the old stroke comes back
  handle.trigger('stir', { point: { x: 100, y: 60 }, angle: 0, strength: 0.3 });
  tick(20);
  const again = rig.snap();
  let old = 0;
  for (let y = 120; y < 200; y += 1) for (let x = 200; x < 400; x += 1) { const i = (y * 480 + x) * 4; if (Math.abs(again.data[i] - first.data[i]) > 16) old += 1; }
  assert.equal(old, 0, 'nothing where the first stroke was');
});

gpuTest('zero work at rest: no frame without a change; a stroke renders every tick until flow, displacement and pigment are gone, then nothing, and the frame at rest is the source', async (t) => {
  const { rig, host, img: still } = await presentOnce(t, plugin, { intensity: 1 }, { scene });
  let now = performance.now() + 200;
  const tick = (/** @type {number} */ n) => { for (let i = 0; i < n; i += 1) { rig.tick(now); now += 1000 / 60; } };
  const f0 = host.stats().frames;
  tick(30);
  assert.equal(host.stats().frames, f0, 'at rest the host renders nothing (30 frame ticks)');
  const r = rig.canvas.getBoundingClientRect();
  const at = (/** @type {string} */ type, /** @type {number} */ x, /** @type {number} */ y) => rig.layerEl.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: r.left + x, clientY: r.top + y, buttons: 1, pointerType: 'mouse' }));
  at('pointerdown', 100, 160);
  for (let i = 1; i <= 20; i += 1) at('pointermove', 100 + 14 * i, 160);
  tick(30);
  const moving = host.stats().frames - f0;
  assert.ok(moving >= 29, `control: after the stroke it renders every tick (${moving} of 30)`);
  assert.ok(changedPixels(rig.snap(), still) > 2000, 'and the picture shows it');
  for (let i = 0; i < 400; i += 1) {
    const before = host.stats().frames;
    tick(1);
    if (host.stats().frames === before) break;
  }
  const settledAt = host.stats().frames;
  tick(30);
  assert.equal(host.stats().frames, settledAt, `at rest again after ${settledAt - f0} frames: no frame in 30 ticks`);
  // (the events of this stroke come in one instant: the fastest pointer the plugin follows, at intensity 1; the flow it leaves takes longer than the pigment)
  assert.ok((settledAt - f0) / 60 < 6, `the fastest stroke at intensity 1 settled within 6 s of the frame clock (${((settledAt - f0) / 60).toFixed(2)} s)`);
  rig.commit();   // the page changed: one frame, the plain picture
  tick(1);
  assert.equal(host.stats().frames, settledAt + 1);
  assert.deepEqual(exact(rig.snap(), still), { n: 0, max: 0 });
}, { timeout: 30000 });

gpuTest('the cost of a frame at 1280 x 800 CSS px, DPR 2 (2560 x 1600), while the demo plays and while drops bloom: GPU time by throughput against a pass that only clears, and the CPU time of render()', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  const device = await /** @type {any} */ (adapter).requestDevice();
  const format = navigator.gpu.getPreferredCanvasFormat();
  const cssW = 1280, cssH = 800, dpr = 2, w = cssW * dpr, h = cssH * dpr;
  const paint = new OffscreenCanvas(w, h);
  const g = /** @type {OffscreenCanvasRenderingContext2D} */ (paint.getContext('2d'));
  g.fillStyle = '#081a2c'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#e8f6ff'; g.font = `${14 * dpr}px system-ui`;
  for (let y = 30 * dpr; y < h; y += 34 * dpr) g.fillText('The form stays usable through the effect: 0123456789 abcdefghijklmnopqrstuvwxyz', 20 * dpr, y);
  const source = device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
  device.queue.copyExternalImageToTexture({ source: paint }, { texture: source }, [w, h]);
  const target = device.createTexture({ size: [w, h], format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
  const sourceView = source.createView(), destinationView = target.createView();
  const canvas = document.createElement('canvas');
  canvas.style.cssText = `position:fixed;left:0;top:0;width:${cssW}px;height:${cssH}px`;
  document.body.append(canvas);
  try {
    /** @param {number} hz  frames per second of the frame clock @param {boolean} demo @param {boolean} clearOnly @param {boolean} [drops]  a drop every 0.2 s along the demo's path */
    const run = async (hz, demo, clearOnly, drops = false) => {
      /** @type {Record<string, Function>} */ const on = {};
      const context = { apiVersion: 2, adapter, device, format, canvas, source: canvas, requestRender() {}, listen: (/** @type {string} */ type, /** @type {Function} */ fn) => { on[type] = fn; return () => {}; }, viewport: () => ({}) };
      const instance = await plugin.create(/** @type {any} */ (context), { ...meta.defaults });
      if (demo) instance.runAction('demo', {}, { reducedMotion: false });
      const frames = Math.round(1.5 * hz), t0 = performance.now() + 4;
      await device.queue.onSubmittedWorkDone();
      const cpu = [];
      const start = performance.now();
      for (let k = 0; k < frames; k += 1) {
        if (drops && k % Math.round(0.2 * hz) === 0) {
          const x = 0.15 + (0.7 * k) / frames, y = 0.5 + 0.25 * Math.sin(9 * x);
          for (const type of ['pointerdown', 'pointerup']) on[type](new PointerEvent(type, { clientX: x * cssW, clientY: y * cssH, buttons: 1, pointerType: 'mouse' }));
        }
        const encoder = device.createCommandEncoder();
        const a = performance.now();
        if (clearOnly) encoder.beginRenderPass({ colorAttachments: [{ view: destinationView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] }).end();
        else instance.render(/** @type {any} */ ({ now: t0 + (k * 1000) / hz, delta: 1000 / hz, frameIndex: k, frameCap: 0, sourceVersion: 1, sourceReady: true, encoder, sourceTexture: source, sourceView, destinationTexture: target, destinationView, width: w, height: h, cssWidth: cssW, cssHeight: cssH, dpr }));
        cpu.push(performance.now() - a);
        device.queue.submit([encoder.finish()]);
      }
      await device.queue.onSubmittedWorkDone();
      const ms = (performance.now() - start) / frames;
      instance.destroy?.();
      cpu.sort((x, y) => x - y);
      return { ms, cpuMean: cpu.reduce((s, v) => s + v, 0) / cpu.length, cpuP95: cpu[Math.floor(cpu.length * 0.95)], cpuMax: cpu[cpu.length - 1] };
    };
    await run(120, true, false);   // warm up (pipelines, the JIT)
    const clear = await run(120, false, true);
    const rest = await run(120, false, false);
    const d120 = await run(120, true, false);
    const d60 = await run(60, true, false);
    // (a press takes over from the demo: these runs are the drops alone, each spreading for 0.45 s)
    const b120 = await run(120, false, false, true);
    const b60 = await run(60, false, false, true);
    const f = (/** @type {number} */ v) => v.toFixed(3);
    console.error(`ink cost at ${w} x ${h}: GPU throughput per frame: clear only ${f(clear.ms)} ms, at rest ${f(rest.ms)} ms, demo at 120 fps (1 step a frame) ${f(d120.ms)} ms, demo at 60 fps (2 steps a frame) ${f(d60.ms)} ms; drops every 0.2 s at 120 fps ${f(b120.ms)} ms, at 60 fps ${f(b60.ms)} ms`);
    console.error(`ink cost: CPU in render(): at rest mean ${f(rest.cpuMean)} ms; demo at 120 fps mean ${f(d120.cpuMean)} p95 ${f(d120.cpuP95)} max ${f(d120.cpuMax)} ms; demo at 60 fps mean ${f(d60.cpuMean)} p95 ${f(d60.cpuP95)} max ${f(d60.cpuMax)} ms; drops every 0.2 s at 120 fps mean ${f(b120.cpuMean)} p95 ${f(b120.cpuP95)} max ${f(b120.cpuMax)} ms, at 60 fps mean ${f(b60.cpuMean)} p95 ${f(b60.cpuP95)} max ${f(b60.cpuMax)} ms`);
    assert.ok(d120.ms < 8.33 && d60.ms < 16.67 && b120.ms < 8.33 && b60.ms < 16.67, 'the GPU keeps up with the frame clock');
    assert.ok(d120.cpuMean < 1.5 && d60.cpuMean < 3 && b120.cpuMean < 1.5 && b60.cpuMean < 3, `the CPU time of a frame: ${f(b120.cpuMean)} ms at 120 fps, ${f(b60.cpuMean)} ms at 60 fps`);
    assert.ok(rest.cpuMean < 0.2, 'a frame at rest steps nothing');
  } finally {
    canvas.remove(); source.destroy(); target.destroy(); device.destroy();
  }
}, { timeout: 60000 });
