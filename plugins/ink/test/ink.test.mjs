// The ink plugin in Node, over a fake GPU device that records what the plugin submits: the folder contract, the pure helpers, the input
// mapper against an independent oracle, the same motion at 30, 60 and 120 frames per second, the way to rest, the pointer (hover, press,
// a press on a control, through context.localPoint), reduced motion, and the actions through the real handle of the effects host.
// The fluid itself is tested in ink-sim.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractTest } from '../../_shared/contract-test.mjs';
import { nodeHandle } from '../../_shared/node-host.mjs';
import { CHANNELS, MAX_BLOOMS, MAX_STEPS_PER_FRAME, PAD, STEP_MS, createFluid, pack, step, stir } from '../sim.js';
import { ACTIONS, DEMO_MS, G, GLOBALS_LENGTH, INK_CAP, INK_HOLD, INK_LIFE, PALETTES, PIGMENT_TEXELS, S, SEGMENTS_PER_STEP, STEP_FLOATS, demoPath, inkMix, inkOptics, mapInkPoint, meta, pigmentGrid, plugin } from '../index.js';

contractTest(import.meta.url);

const W = 480, H = 320;

/** A GPU device that records what the plugin submits: the uniform blocks (by buffer label), the fields, the render passes. */
function fakeGpu() {
  const globals = [], steps = [], fields = [], passes = [], created = [];
  const device = {
    createShaderModule: () => ({}), createRenderPipeline: () => ({}), createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}),
    createBuffer: (d) => ({ label: d.label, destroy() {} }), createSampler: () => ({}), createBindGroup: (d) => ({ label: d.label }),
    createTexture: (d) => { const t = { d, label: d.label, destroyed: false, createView: () => ({ of: d.label }), destroy() { t.destroyed = true; } }; created.push(t); return t; },
    queue: {
      writeBuffer: (buffer, offset, data) => (buffer.label === 'hic-ink-steps' ? steps.push({ index: offset / (STEP_FLOATS * 4), data: new Float32Array(data) }) : globals.push(new Float32Array(data))),
      writeTexture: (dst, data) => fields.push({ layer: dst.origin.z, data: new Float32Array(data) }),
    },
  };
  const encoder = {
    beginRenderPass: (d) => {
      const pass = { view: d.colorAttachments[0].view, loadOp: d.colorAttachments[0].loadOp, draws: 0, scissor: null, group: null };
      passes.push(pass);
      return { setPipeline() {}, setBindGroup(_i, g) { pass.group = g; }, setScissorRect(...r) { pass.scissor = r; }, draw() { pass.draws += 1; }, end() {} };
    },
  };
  return { device, encoder, globals, steps, fields, passes, created };
}

const stubFetch = (t) => { const real = globalThis.fetch; globalThis.fetch = async () => ({ ok: true, text: async () => '// wgsl' }); t.after(() => { globalThis.fetch = real; }); };
/** elements for event.target: plain page content, and a text field */
const page = { closest: () => null };
const field = { closest: (selector) => (/\binput\b/.test(selector) ? field : null) };
/** the largest displacement (CSS px) in a packed field */
const shift = (data) => { let m = 0; for (let k = 0; k < data.length; k += CHANNELS) m = Math.max(m, Math.hypot(data[k], data[k + 1])); return m; };

/** The instance over the fake device. `localPoint` stands for the plugins added after this one (context.localPoint). */
async function createInk(t, options = {}, { reduced = false, localPoint = undefined } = {}) {
  stubFetch(t);
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
  const gpu = fakeGpu();
  const listeners = {}, listenOptions = {};
  let renders = 0;
  const win = { devicePixelRatio: 2, matchMedia: (q) => ({ matches: reduced && q === '(prefers-reduced-motion: reduce)' }), PointerEvent: class { constructor(o) { Object.assign(this, o); } } };
  const context = {
    apiVersion: 2, device: gpu.device, format: 'bgra8unorm', requestRender() { renders += 1; },
    canvas: { ownerDocument: { defaultView: win }, getBoundingClientRect: () => ({ left: 0, top: 0 }), clientWidth: W, clientHeight: H, clientLeft: 0, clientTop: 0 },
    listen: (type, fn, o) => { listeners[type] = fn; listenOptions[type] = o; return () => {}; },
    viewport: () => ({}),
    ...(localPoint ? { localPoint } : {}),
  };
  const instance = await plugin.create(context, { ...meta.defaults, ...options });
  const frame = (now) => ({ now, width: W * 2, height: H * 2, cssWidth: W, cssHeight: H, dpr: 2, sourceReady: true, sourceView: gpu, destinationView: {}, encoder: gpu.encoder });
  const pointer = (type, x, y, extra = {}) => listeners[type](new win.PointerEvent({ clientX: x, clientY: y, buttons: 0, pointerType: 'mouse', timeStamp: performance.now(), target: page, ...extra }));
  /** render frames every `dt` ms from `from` until `done()` or `maxMs`; returns the frame time reached */
  const run = (from, maxMs, dt = 1000 / 120, done = () => false) => { let now = from; for (; now <= from + maxMs && !done(); now += dt) instance.render(frame(now)); return now; };
  return { instance, gpu, frame, listeners, listenOptions, win, pointer, run, renders: () => renders };
}

/** a pressed stroke of the mouse from (x0, y) to (x1, y) in `n` moves 12 ms apart, starting at time t */
function drag(w, x0, x1, y, t, n = 12, target = page) {
  w.pointer('pointerdown', x0, y, { timeStamp: t, buttons: 1, target });
  for (let i = 1; i <= n; i += 1) w.pointer('pointermove', x0 + ((x1 - x0) * i) / n, y, { timeStamp: t + 12 * i, buttons: 1, target });
}

test('meta and the definition: three actions, the gallery defaults, the reduced-motion line; the two uniform blocks are laid out without gaps', () => {
  assert.deepEqual([...plugin.actions], ['demo', 'stir', 'clear']);
  assert.equal(plugin.actions, ACTIONS);
  assert.deepEqual({ ...meta.defaults }, { intensity: 0.6, flow: 0.5, pigment: 0.7 });
  assert.ok(meta.reducedMotion.length <= 160 && meta.touch.length <= 160 && meta.description.length <= 160);
  assert.equal(GLOBALS_LENGTH % 4, 0);
  assert.equal(G.SCATTER + 12, GLOBALS_LENGTH);
  assert.equal(S.INK + 4 * SEGMENTS_PER_STEP, S.BLOOM);
  assert.ok(S.BLOOM + 8 * MAX_BLOOMS <= STEP_FLOATS);
  assert.equal((STEP_FLOATS * 4) % 256, 0, 'a step block starts at a uniform offset alignment');
});

test('the inks: absorption from the colour on white (-ln), scattering from the sheen; every palette has three; bad entries fall back to marbling', () => {
  for (const name of Object.keys(PALETTES)) {
    const o = inkOptics(name);
    assert.equal(o.length, 24);
    assert.equal(PALETTES[name].length, 3);
    for (let i = 0; i < 3; i += 1) for (let c = 0; c < 3; c += 1) assert.ok(o[i * 4 + c] >= 0 && o[12 + i * 4 + c] > 0, `${name}: ink ${i} channel ${c}`);
  }
  const m = inkOptics('marbling');
  // the first ink is a blue: it absorbs red most and blue least, and scatters blue most
  assert.ok(m[0] > m[1] && m[1] > m[2] && m[14] > m[12]);
  assert.deepEqual([...inkOptics('no-such-palette')], [...m]);
  assert.deepEqual([...inkOptics(42)], [...m]);
  assert.deepEqual([...inkOptics([])], [...m]);
  // a custom palette: white ink absorbs nothing; a pair gives its own sheen; a bad colour falls back to the entry of marbling
  const custom = inkOptics(['#ffffff', ['#000', '#ff0000'], 'red']);
  assert.deepEqual([...custom.slice(0, 3)], [0, 0, 0]);
  assert.ok(custom[4] > 8 && Math.abs(custom[4] - custom[5]) < 1e-6, 'black is limited to the absorption of 2 % reflectance');
  assert.ok(custom[16] > 2 && custom[17] === 0 && custom[18] === 0, 'the sheen of the pair is red');
  assert.deepEqual([...custom.slice(8, 11)], [...m.slice(8, 11)]);
  assert.notDeepEqual([...inkOptics('sumi')], [...m]);
});

test('the hue: two neighbouring inks cross-faded, the shares sum to 1, one turn of the palette per unit; the pigment texture: about one texel per CSS px, capped; the demo path stays on the page', () => {
  const out = new Float32Array(4);
  for (let p = -1; p <= 2; p += 0.013) {
    inkMix(p, out);
    assert.ok(Math.abs(out[0] + out[1] + out[2] - 1) < 1e-6 && out[3] === 0 && out.every((v) => v >= 0));
    assert.ok(out.filter((v) => v > 0).length <= 2);
  }
  inkMix(0, out); assert.deepEqual([...out], [1, 0, 0, 0]);
  inkMix(1 / 3, out); assert.ok(Math.abs(out[1] - 1) < 1e-5);
  inkMix(5 + 2 / 3, out); assert.ok(Math.abs(out[2] - 1) < 1e-5);
  inkMix(0.5, out); assert.ok(Math.abs(out[1] - 0.5) < 1e-6 && Math.abs(out[2] - 0.5) < 1e-6);
  assert.deepEqual(pigmentGrid(480, 320, 1), { w: 480, h: 320 });
  assert.deepEqual(pigmentGrid(480, 320, 2), { w: 960, h: 640 });
  const big = pigmentGrid(1100, 620, 2);
  assert.ok(big.w * big.h <= PIGMENT_TEXELS * 1.01 && big.w * big.h > PIGMENT_TEXELS * 0.98 && Math.abs(big.w / big.h - 1100 / 620) < 0.01);
  const huge = pigmentGrid(3000, 2000, 1);
  assert.ok(huge.w * huge.h <= PIGMENT_TEXELS * 1.01);
  const p = { x: 0, y: 0 };
  let above = 0, below = 0;
  for (let s = 0; s <= 1; s += 0.01) { demoPath(s, 1100, 620, p); assert.ok(p.x > 100 && p.x < 1000 && p.y > 100 && p.y < 520); if (p.y < 300) above += 1; else if (p.y > 320) below += 1; }
  assert.ok(above > 30 && below > 30, 'an S: one bend above the middle, one below');
});

// an independent oracle: the centred cubic B-spline basis over the packed field, cells clamped into the padded grid
const B3 = (t) => { const a = Math.abs(t); return a < 1 ? 2 / 3 - a * a + (a * a * a) / 2 : a < 2 ? ((2 - a) ** 3) / 6 : 0; };
function oracleRead(data, offset, pw, ph, gx, gy, channel) {
  let v = 0;
  for (let j = Math.floor(gy) - 1; j <= Math.floor(gy) + 2; j += 1) for (let i = Math.floor(gx) - 1; i <= Math.floor(gx) + 2; i += 1) {
    v += data[offset + (Math.min(ph - 1, Math.max(0, j)) * pw + Math.min(pw - 1, Math.max(0, i))) * CHANNELS + channel] * B3(gx - i) * B3(gy - j);
  }
  return v;
}

/** A mapper state over a stirred fluid, laid out as render() writes it. */
function stateOf(w, h, seed = 1) {
  const f = createFluid(w, h);
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let i = 0; i < 8; i += 1) stir(f, rnd() * w, rnd() * h, 600 * (rnd() - 0.5), 600 * (rnd() - 0.5), 32);
  for (let i = 0; i < 30; i += 1) step(f, { drag: 1, heal: 2, confine: 3 });
  const state = new Float32Array(GLOBALS_LENGTH + f.pw * f.ph * CHANNELS);
  state[G.CSS] = w; state[G.CSS + 1] = h; state[G.GRID] = f.gw; state[G.GRID + 1] = f.gh; state[G.MOVED] = 1;
  pack(f, state, GLOBALS_LENGTH);
  return { state, f };
}

test('mapInkPoint equals the independent oracle (the B-spline basis over the packed field) on a grid, several sizes; at rest it is the identity; it never leaves the canvas', () => {
  let moved = 0;
  for (const [w, h, seed] of [[640, 480, 1], [300, 900, 7], [1100, 620, 3]]) {
    const { state, f } = stateOf(w, h, seed);
    for (let i = 0; i <= 20; i += 1) for (let j = 0; j <= 20; j += 1) {
      // presented at another size than the fluid's (the mapper works in shares of the presented size)
      const point = { x: (i / 20) * w * 1.5, y: (j / 20) * h * 1.5, width: w * 1.5, height: h * 1.5 };
      const gx = (i / 20) * f.gw - 0.5 + PAD, gy = (j / 20) * f.gh - 0.5 + PAD;
      const dx = oracleRead(state, GLOBALS_LENGTH, f.pw, f.ph, gx, gy, 0), dy = oracleRead(state, GLOBALS_LENGTH, f.pw, f.ph, gx, gy, 1);
      const expected = { x: Math.min(1, Math.max(0, i / 20 - dx / w)) * point.width, y: Math.min(1, Math.max(0, j / 20 - dy / h)) * point.height };
      const got = mapInkPoint(state, point);
      assert.ok(Math.abs(got.x - expected.x) < 1e-3 && Math.abs(got.y - expected.y) < 1e-3, `${w}x${h} (${point.x}, ${point.y}): ${got.x}, ${got.y} vs ${expected.x}, ${expected.y}`);
      assert.ok(got.x >= 0 && got.x <= point.width && got.y >= 0 && got.y <= point.height);
      if (Math.hypot(got.x - point.x, got.y - point.y) > 1) moved += 1;
    }
    // a point of a wall stays on that wall: nothing of the page comes in from outside
    assert.ok(Math.abs(mapInkPoint(state, { x: 0, y: h / 3, width: w, height: h }).x) < 1e-3);
    assert.ok(Math.abs(mapInkPoint(state, { x: w / 3, y: h, width: w, height: h }).y - h) < 1e-3);
    state[G.MOVED] = 0;
    assert.deepEqual(mapInkPoint(state, { x: 123.25, y: 45.5, width: w, height: h }), { x: 123.25, y: 45.5 });
  }
  assert.ok(moved > 300, `the states really displace (${moved} points moved by more than 1 px)`);
});

test('at rest nothing works: not continuous, settled at once, no step, no field upload, the mapper is the identity, no frame requested; the listeners are passive', async (t) => {
  const w = await createInk(t);
  assert.equal(w.instance.spatial, true);
  assert.equal(w.instance.continuous, false);
  assert.equal(w.instance.settled(), 'still');
  w.run(1000, 100);
  assert.equal(w.gpu.steps.length, 0);
  assert.equal(w.gpu.fields.length, 0);
  assert.equal(w.renders(), 0);
  const g = w.gpu.globals.at(-1);
  assert.equal(g[G.MOVED], 0); assert.equal(g[G.INKED], 0); assert.equal(g[G.READY], 1);
  assert.deepEqual(w.instance.captureInputMapper()({ x: 77, y: 33, width: W, height: H }), { x: 77, y: 33 });
  assert.equal(w.gpu.passes.every((p) => p.draws === 1 && p.scissor === null), true, 'one picture pass per frame, nothing else');
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointerleave', 'pointercancel', 'touchstart', 'touchmove', 'touchend', 'touchcancel']) {
    assert.equal(w.listenOptions[type]?.passive, true, `${type} is passive`);
  }
  // not a PointerEvent (a script's event): ignored
  w.listeners.pointerdown({ clientX: 10, clientY: 10 });
  assert.equal(w.instance.continuous, false);
});

test('the same motion at 30, 60 and 120 frames per second: the demo uploads the same fields step for step, and the pigment gets the same segments; another intensity gives other fields (control)', async (t) => {
  /** the fields and the pigment steps of the first 0.7 s of the demo at `fps` */
  const record = async (fps, options = {}) => {
    const w = await createInk(t, options);
    w.instance.runAction('demo', {}, { reducedMotion: false });
    const first = w.run(performance.now() + 4, 0, 1000 / fps);   // the first frame: one step
    w.run(first, 700, 1000 / fps);
    const perFrame = w.gpu.steps.reduce((m, s) => Math.max(m, s.index + 1), 0);
    return { fields: w.gpu.fields.map((f) => f.data), steps: w.gpu.steps.map((s) => s.data), perFrame };
  };
  const a = await record(120), b = await record(60), c = await record(30);
  assert.equal(a.perFrame, 1); assert.equal(b.perFrame, 2); assert.equal(c.perFrame, 4);
  const n = Math.min(a.fields.length, b.fields.length, c.fields.length);
  assert.ok(n > 70, `${n} steps compared`);
  for (let i = 0; i < n; i += 1) {
    assert.ok(a.fields[i].every((v, k) => v === b.fields[i][k]) && a.fields[i].every((v, k) => v === c.fields[i][k]), `the field of step ${i} is the same at 120, 60 and 30 fps`);
    // the step blocks differ only in the layer the step is uploaded to
    for (const other of [b, c]) assert.ok(a.steps[i].every((v, k) => k === S.LAYER || v === other.steps[i][k]), `the pigment step ${i} is the same`);
  }
  assert.ok(shift(a.fields[n - 1]) > 5, `the demo really moves the page (${shift(a.fields[n - 1])} px)`);
  const d = await record(120, { intensity: 0.3 });
  assert.ok(Math.abs(shift(a.fields[n - 1]) - shift(d.fields[n - 1])) > 1, 'control: at another intensity the field differs');
});

test('the demo: one stroke of pigment across the page, then everything comes to rest by itself within 4.5 s at any frame rate; the frame at rest shows the plain page and nothing is requested after it', async (t) => {
  for (const fps of [120, 60, 24]) {
    const w = await createInk(t);
    let state;
    Promise.resolve(w.instance.runAction('demo', {}, { reducedMotion: false })).then((s) => { state = s; });
    assert.equal(w.instance.continuous, true);
    assert.ok(w.renders() >= 1, 'it asked for its first frame');
    const t0 = performance.now() + 4;
    const at = w.run(t0, DEMO_MS + 100, 1000 / fps);
    const mid = w.gpu.globals.at(-1);
    assert.equal(mid[G.MOVED], 1); assert.equal(mid[G.INKED], 1);
    assert.ok(mid[G.INK_BOX + 2] - mid[G.INK_BOX] > 0.6 * W, `the pigment spans the page (${mid[G.INK_BOX]}..${mid[G.INK_BOX + 2]})`);
    const released = w.gpu.steps.reduce((n, s) => n + s.data[S.COUNT], 0);
    assert.ok(released > 200, `${released} segments of pigment released`);
    assert.ok(w.gpu.steps.every((s) => Math.abs(s.data[S.LIFE] - INK_LIFE) < 1e-6 && Math.abs(s.data[S.CAP] - INK_CAP) < 1e-6 && s.data[S.COUNT] <= SEGMENTS_PER_STEP));
    assert.ok(Math.abs(mid[G.LOOK] - INK_HOLD) < 1e-6 && Math.abs(mid[G.LOOK + 1] - INK_LIFE) < 1e-6);
    const end = w.run(at, 6000, 1000 / fps, () => !w.instance.continuous);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(w.instance.continuous, false);
    assert.ok(end - t0 < 4500, `${fps} fps: at rest ${Math.round(end - t0)} ms after the first frame`);
    assert.ok(end - t0 > DEMO_MS + INK_LIFE * 1000, 'the pigment of the end of the stroke had its whole life');
    assert.equal(state, 'still');
    const g = w.gpu.globals.at(-1);
    assert.equal(g[G.MOVED], 0); assert.equal(g[G.INKED], 0);
    assert.deepEqual(w.instance.captureInputMapper()({ x: 200, y: 100, width: W, height: H }), { x: 200, y: 100 });
    // both pigment textures were emptied when the last pigment had outlived its life
    assert.equal(w.gpu.passes.filter((p) => p.loadOp === 'clear' && p.draws === 0).length, 2);
    const asked = w.renders(), steps = w.gpu.steps.length, fields = w.gpu.fields.length;
    w.run(end + 100, 300, 1000 / fps);
    assert.equal(w.renders(), asked); assert.equal(w.gpu.steps.length, steps); assert.equal(w.gpu.fields.length, fields);
    assert.equal(w.instance.settled(), 'still');
  }
});

test('a long gap between frames (off-screen, a low frame cap) is skipped, not caught up: at most MAX_STEPS_PER_FRAME steps a frame, and the pigment keeps its life on the simulation clock', async (t) => {
  const w = await createInk(t);
  w.instance.runAction('demo', {}, { reducedMotion: false });
  let frames = 0;
  // 4 frames per second: each frame is 30 steps late and runs 8
  for (let now = performance.now() + 250; w.instance.continuous && frames < 400; now += 250) { w.instance.render(w.frame(now)); frames += 1; }
  assert.equal(w.instance.continuous, false);
  assert.equal(Math.max(...w.gpu.steps.map((s) => s.index)), MAX_STEPS_PER_FRAME - 1);
  const steps = w.gpu.steps.length;
  // the same simulated time as at any frame rate: the stroke and the life of the pigment, in steps
  assert.ok(steps * STEP_MS > DEMO_MS + INK_LIFE * 1000 && steps * STEP_MS < 4500, `${steps} steps (${Math.round(steps * STEP_MS)} ms of simulation) over ${frames} frames`);
});

test('the pointer: a hovering mouse stirs without pigment, a pressed one releases a drop and two lines of pigment along its path, and the page under it moves with it', async (t) => {
  const p = { x: 240, y: 160, width: W, height: H };
  const hover = await createInk(t);
  const t0 = performance.now();
  for (let i = 0; i <= 12; i += 1) hover.pointer('pointermove', 100 + 20 * i, 160, { timeStamp: t0 + 12 * i });
  assert.equal(hover.instance.continuous, true);
  hover.run(performance.now() + 4, 100);
  assert.equal(hover.gpu.steps.length, 0, 'no pigment from a hovering pointer');
  const h = hover.gpu.globals.at(-1);
  assert.equal(h[G.MOVED], 1); assert.equal(h[G.INKED], 0);
  const hx = hover.instance.captureInputMapper()(p).x;
  assert.ok(hx < 240 - 0.5 && hx > 240 - 40, `the page under the path moved to the right, with the pointer: it shows the source at x = ${hx}`);

  const press = await createInk(t);
  drag(press, 100, 340, 160, t0);
  press.run(performance.now() + 4, 100);
  const first = press.gpu.steps[0].data;
  assert.equal(first[S.COUNT], 4, 'the drop (an ink around a core of the next) and the first piece of the path (two inks side by side)');
  assert.deepEqual([first[S.SEG], first[S.SEG + 1], first[S.SEG + 2], first[S.SEG + 3]], [100, 160, 100, 160], 'the drop where the press landed');
  assert.ok(first[S.SHAPE + 2] > 1, 'a drop has a soft rim, not a Gaussian');
  assert.ok((first[S.SEG + 9] < 160) !== (first[S.SEG + 13] < 160), 'the two lines run either side of the path');
  const inks = (o) => [...first.slice(S.INK + o, S.INK + o + 3)];
  assert.notDeepEqual(inks(8), inks(12), 'in two different inks');
  assert.equal(press.gpu.globals.at(-1)[G.INKED], 1);
  const px = press.instance.captureInputMapper()(p).x;
  assert.ok(240 - px > 2 * (240 - hx), `a pressed pointer pushes harder: source x = ${px} against ${hx} for the hover`);
  // intensity 0: the effect is off; pigment 0: the page moves, no pigment
  const off = await createInk(t, { intensity: 0 });
  drag(off, 100, 340, 160, t0);
  assert.equal(off.instance.continuous, false);
  const dry = await createInk(t, { pigment: 0 });
  drag(dry, 100, 340, 160, t0);
  dry.run(performance.now() + 4, 100);
  assert.equal(dry.gpu.steps.length, 0);
  assert.equal(dry.gpu.globals.at(-1)[G.MOVED], 1);
});

/**
 * A sweep of the mouse to and fro across the canvas at `speed` CSS px/s for `ms`, one event every 8 ms, the frames at 120 per second in
 * between, then frames until rest; returns the largest displacement of any cell of the uploaded fields (CSS px: the B-spline is a convex
 * combination of the cells, so neither the mapper nor the pixels show more).
 */
function sweep(w, speed, { pressed = false, ms = 1200 } = {}) {
  const t0 = performance.now() + 10;
  let now = t0 + 4;
  for (let i = 0; i * 8 <= ms; i += 1) {
    const s = speed * i * 0.008, lap = s % (2 * 380), x = 50 + (lap < 380 ? lap : 760 - lap), y = 160 + 60 * Math.sin(s / 140);
    for (; now < t0 + 8 * i; now += 1000 / 120) w.instance.render(w.frame(now));
    w.pointer(i === 0 && pressed ? 'pointerdown' : 'pointermove', x, y, { timeStamp: t0 + 8 * i, buttons: pressed ? 1 : 0 });
  }
  for (let i = 0; i < 1500 && w.instance.continuous; i += 1, now += 1000 / 120) w.instance.render(w.frame(now));
  assert.equal(w.instance.continuous, false, 'it came to rest');
  return Math.max(0, ...w.gpu.fields.map((f) => shift(f.data)));
}

test('a hover sweep moves the page by at most 3 CSS px at the defaults, at any speed (text stays readable); it still stirs (control); a pressed sweep moves it by far more, as before (control)', async (t) => {
  const hovers = [];
  for (const speed of [400, 800, 2400, 4000]) hovers.push(sweep(await createInk(t), speed));
  assert.ok(hovers.every((d) => d <= 3), `hover: ${hovers.map((d) => d.toFixed(2)).join(', ')} px`);
  assert.ok(hovers.every((d) => d > 0.5), 'control: every hover moves the page a little');
  const pressed = sweep(await createInk(t, { pigment: 0 }), 800, { pressed: true });
  assert.ok(pressed > 20, `control: a pressed sweep moves the page by ${pressed.toFixed(1)} px`);
  const strong = sweep(await createInk(t, { intensity: 1 }), 2400);
  assert.ok(strong > hovers[2] * 1.3, `intensity scales the hover (${strong.toFixed(2)} px at 1)`);
});

test('a press on a control of the page is the page\'s gesture: no drop on the field, and a drag from it stirs like a hover, without pigment; text is selectable there, and not where a pressed pointer stirs the page', async (t) => {
  const w = await createInk(t);
  const t0 = performance.now();
  drag(w, 100, 340, 160, t0, 12, field);
  assert.equal(w.instance.continuous, true, 'the drag still stirs');
  w.run(performance.now() + 4, 100);
  assert.equal(w.gpu.steps.length, 0, 'no pigment');
  assert.equal(w.gpu.globals.at(-1)[G.MOVED], 1);
  const select = (target) => { let prevented = false; w.listeners.selectstart({ target, preventDefault() { prevented = true; } }); return prevented; };
  assert.equal(select(field), false, 'a selection in the field starts');
  assert.equal(select(page), false, 'the press began on a control: the selection is the page\'s');
  w.pointer('pointerup', 340, 160);
  w.pointer('pointerdown', 100, 100, { buttons: 1 });
  assert.equal(select(page), true, 'while a press stirs the page, the text it crosses is not selected');
  assert.equal(select(field), false, 'but a field is always selectable');
  assert.equal(select({ parentElement: page }), true, 'a text node as the target');
  w.pointer('pointerup', 100, 100);
  assert.equal(select(page), false, 'no press: selections start as usual (the keyboard, a double click after the release)');
  assert.equal(w.listenOptions.selectstart, undefined, 'the only listener that is not passive');
  const allow = await createInk(t, { selectText: true });
  allow.pointer('pointerdown', 100, 100, { buttons: 1 });
  let prevented = false;
  allow.listeners.selectstart({ target: page, preventDefault() { prevented = true; } });
  assert.equal(prevented, false, 'option selectText: true');
});

test('with plugins added after the ink, the pointer is read through context.localPoint: the drop falls where the pointer is seen on the ink; where a later plugin shows nothing of it (null), nothing happens', async (t) => {
  const DX = 120, DY = 60;
  const shifted = await createInk(t, {}, { localPoint: (p) => ({ x: p.x + DX, y: p.y + DY }) });
  shifted.pointer('pointerdown', 100, 80, { buttons: 1 });
  shifted.run(performance.now() + 30, 20);
  const s = shifted.gpu.steps[0].data;
  assert.deepEqual([s[S.SEG], s[S.SEG + 1]], [100 + DX, 80 + DY]);
  const plain = await createInk(t);
  plain.pointer('pointerdown', 100, 80, { buttons: 1 });
  plain.run(performance.now() + 30, 20);
  assert.deepEqual([plain.gpu.steps[0].data[S.SEG], plain.gpu.steps[0].data[S.SEG + 1]], [100, 80], 'control: without them, under the pointer');
  const unseen = await createInk(t, {}, { localPoint: () => null });
  unseen.pointer('pointerdown', 100, 80, { buttons: 1 });
  for (let i = 0; i < 5; i += 1) unseen.pointer('pointermove', 100 + 20 * i, 80, { buttons: 1, timeStamp: performance.now() + 12 * i });
  assert.equal(unseen.instance.continuous, false);
  assert.equal(unseen.renders(), 0);
});

test('a finger: its touch moves stir and release pigment along its path over the canvas (passive: the page may scroll under it); a finger that stays over the same spot of the canvas while the page scrolls stirs nothing', async (t) => {
  const w = await createInk(t);
  const t0 = performance.now();
  const touch = (type, x, y, at) => w.listeners[type]({ type, timeStamp: at, changedTouches: [{ identifier: 1, clientX: x, clientY: y }] });
  w.pointer('pointerdown', 100, 160, { pointerType: 'touch', buttons: 1, timeStamp: t0 });
  touch('touchstart', 100, 160, t0);
  for (let i = 1; i <= 10; i += 1) touch('touchmove', 100 + 20 * i, 160, t0 + 12 * i);
  // pointer moves of a finger that touch events follow are not counted twice
  w.pointer('pointermove', 300, 160, { pointerType: 'touch', buttons: 1, timeStamp: t0 + 130 });
  w.run(performance.now() + 4, 150);
  assert.equal(w.gpu.steps.reduce((n, s) => n + s.data[S.COUNT], 0), 2 + 2 * 10, 'the drop and two lines for each of the 10 moves');
  touch('touchend', 300, 160, t0 + 200);
  const still = await createInk(t);
  const touchStill = (type, at) => still.listeners[type]({ type, timeStamp: at, changedTouches: [{ identifier: 2, clientX: 100, clientY: 160 }] });
  touchStill('touchstart', t0);
  for (let i = 1; i <= 10; i += 1) touchStill('touchmove', t0 + 12 * i);
  assert.equal(still.instance.continuous, false);
});

test('reduced motion: nothing flows and the page never moves; a press leaves a tint that fades in place over the life of the pigment; the demo resolves at once', async (t) => {
  const w = await createInk(t, {}, { reduced: true });
  assert.equal(w.instance.runAction('demo', {}, { reducedMotion: true }), 'still');
  assert.equal(w.instance.continuous, false);
  const t0 = performance.now();
  drag(w, 100, 340, 160, t0);
  assert.equal(w.instance.continuous, true, 'the press left a tint');
  const from = performance.now() + 4;
  const end = w.run(from, 6000, 1000 / 60, () => !w.instance.continuous);
  assert.ok(end - from > INK_LIFE * 1000 && end - from < INK_LIFE * 1000 + 400, `the tint is gone after ${Math.round(end - from)} ms`);
  assert.equal(w.gpu.fields.length, 0, 'the field is never uploaded: nothing moved');
  assert.ok(w.gpu.globals.every((g) => g[G.MOVED] === 0), 'the mapper stayed the identity');
  assert.ok(w.gpu.steps.every((s) => s.data[S.FLOWING] === 0), 'the pigment is not carried');
  assert.equal(w.gpu.steps.reduce((n, s) => n + s.data[S.COUNT], 0), 2, 'only the drop of the press: a drag draws nothing');
  let prevented = false;
  w.pointer('pointerdown', 50, 50, { buttons: 1 });
  w.listeners.selectstart({ target: page, preventDefault() { prevented = true; } });
  assert.equal(prevented, false, 'nothing is stirred, so text is selectable');
  // the user preference as the host reads it at a trigger, on an instance created without it
  const v = await createInk(t);
  assert.equal(v.instance.runAction('demo', {}, { reducedMotion: true }), 'still');
  assert.equal(v.instance.continuous, false);
});

/** the plugin behind the real handle of the host, over the fake GPU; the test renders the frames */
async function handleOf(t, { reducedMotion = false, options = {} } = {}) {
  stubFetch(t);
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
  const gpu = fakeGpu();
  const win = { devicePixelRatio: 1, matchMedia: () => ({ matches: reducedMotion }), PointerEvent: class extends Event { constructor(type, o) { super(type); Object.assign(this, o); } } };
  const canvas = Object.assign(new EventTarget(), { ownerDocument: { defaultView: win }, getBoundingClientRect: () => ({ left: 0, top: 0 }), clientWidth: W, clientHeight: H, clientLeft: 0, clientTop: 0 });
  const h = await nodeHandle(plugin, { ...meta.defaults, ...options }, { device: gpu.device, canvas, source: {}, reducedMotion });
  const frame = (now) => ({ now, width: W, height: H, cssWidth: W, cssHeight: H, dpr: 1, sourceReady: true, sourceView: gpu, destinationView: {}, encoder: gpu.encoder });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  /** the frame clock: it starts at the real time (the plugin wakes on that clock) and runs ahead of it as frames are rendered */
  let clock = 0;
  const next = () => { clock = Math.max(clock + 1000 / 60, performance.now() + 4); return clock; };
  /** frames at 60 per second until the instance rests (at most `maxMs`), and one more; returns the ms that took on the frame clock */
  const rest = (maxMs = 6000) => { const from = next(); h.inst.render(frame(from)); while (clock <= from + maxMs && h.inst.continuous) h.inst.render(frame(next())); h.inst.render(frame(next())); return clock - from; };
  /** `n` frames at 60 per second */
  const frames = (n) => { for (let i = 0; i < n; i += 1) h.inst.render(frame(next())); };
  return { ...h, gpu, frame, flush, rest, frames, canvas, win };
}

test('the action stir, through the effect handle: a stroke at the point, in the direction and of the length asked for; it resolves \'still\' at rest; bad options reject; settled() follows', async (t) => {
  const w = await handleOf(t);
  assert.deepEqual([...w.handle.actions], ['demo', 'stir', 'clear']);
  assert.equal(await w.handle.settled(), 'still');
  let state;
  w.handle.trigger('stir', { point: { x: 240, y: 160 }, angle: 90, strength: 1.5 }).then((s) => { state = s; });
  const pending = w.handle.settled();
  assert.equal(w.inst.continuous, true);
  const took = w.rest();
  await w.flush();
  assert.equal(state, 'still');
  assert.equal(await pending, 'still');
  assert.ok(took < 4500, `at rest after ${Math.round(took)} ms`);
  // the pigment: a vertical stroke through the point, 150 px x 1.5 long
  const ys = [], xs = [];
  for (const s of w.gpu.steps) for (let i = 0; i < s.data[S.COUNT]; i += 1) { xs.push(s.data[S.SEG + 4 * i], s.data[S.SEG + 4 * i + 2]); ys.push(s.data[S.SEG + 4 * i + 1], s.data[S.SEG + 4 * i + 3]); }
  assert.ok(Math.abs(Math.min(...ys) - (160 - 112.5)) < 3 && Math.abs(Math.max(...ys) - (160 + 112.5)) < 3, `the stroke runs from y = ${Math.min(...ys)} to ${Math.max(...ys)}`);
  assert.ok(Math.min(...xs) > 240 - 12 && Math.max(...xs) < 240 + 12, 'straight down through the point (the two lines either side of it)');
  assert.ok(Math.max(...w.gpu.fields.map((f) => shift(f.data))) > 3, 'and it moved the page');
  // without options: at the centre
  const a = await handleOf(t);
  a.handle.trigger('stir');
  a.frames(6);
  const s0 = a.gpu.steps.find((s) => s.data[S.COUNT] > 0).data;
  assert.ok(Math.hypot(s0[S.SEG] - W / 2, s0[S.SEG + 1] - H / 2) < 90, 'near the centre');
  for (const bad of [{ point: 5 }, { point: { x: 1 } }, { strength: 'much' }, { strength: NaN }, { angle: 'up' }]) {
    await assert.rejects(w.handle.trigger('stir', bad), TypeError, JSON.stringify(bad));
  }
  await assert.rejects(w.handle.trigger('swirl'), /unknown action "swirl"/);
  assert.equal(w.errors.length, 0);
});

test('the action demo, through the effect handle: \'still\' at rest; user input takes over (a press, setOptions): the stroke stops and the demo resolves null; a newer trigger supersedes it; removal resolves null', async (t) => {
  const w = await handleOf(t);
  const demo = w.handle.trigger('demo');
  w.rest();
  assert.equal(await demo, 'still');

  // a press during the stroke: the demo resolves null, and the stroke stops where it was
  const taken = w.handle.trigger('demo');
  w.frames(30);
  const before = w.gpu.steps.length;
  w.canvas.dispatchEvent(new w.win.PointerEvent('pointerdown', { clientX: 400, clientY: 40, buttons: 1, pointerType: 'mouse' }));
  assert.equal(await taken, null);
  w.frames(10);
  assert.equal(w.gpu.steps.slice(before).reduce((n, s) => n + s.data[S.COUNT], 0), 2, 'only the drop of the press: the stroke of the demo released nothing more');
  w.rest();

  const optioned = w.handle.trigger('demo');
  w.frames(2);
  w.handle.setOptions({ flow: 0.2 });
  assert.equal(await optioned, null);
  assert.equal(w.handle.options.flow, 0.2);
  w.rest();

  const older = w.handle.trigger('demo');
  const newer = w.handle.trigger('stir');
  assert.equal(await older, null);
  w.rest();
  assert.equal(await newer, 'still');

  const last = w.handle.trigger('demo');
  w.frames(2);
  w.handle.remove();
  assert.equal(await last, null);
});

test('the action clear, through the effect handle: the ink is gone at once (flow, displacement, pigment); it resolves \'still\' with the frame that shows the clean page', async (t) => {
  const w = await handleOf(t);
  const demo = w.handle.trigger('demo');
  w.frames(60);
  assert.equal(w.gpu.globals.at(-1)[G.MOVED], 1); assert.equal(w.gpu.globals.at(-1)[G.INKED], 1);
  let state;
  w.handle.trigger('clear').then((s) => { state = s; });
  assert.equal(await demo, null, 'superseded');
  await w.flush();
  assert.equal(state, undefined, 'not before its frame');
  assert.equal(w.inst.continuous, false);
  const passes = w.gpu.passes.length;
  w.frames(1);
  await w.flush();
  assert.equal(state, 'still');
  const g = w.gpu.globals.at(-1);
  assert.equal(g[G.MOVED], 0); assert.equal(g[G.INKED], 0);
  assert.deepEqual(w.gpu.passes.slice(passes).map((p) => [p.loadOp, p.draws]), [['clear', 0], ['clear', 0], ['clear', 1]], 'both pigment textures emptied, then the picture');
  assert.equal(await w.handle.settled(), 'still');
  // at rest it resolves with the next frame too
  const again = w.handle.trigger('clear');
  w.frames(1);
  assert.equal(await again, 'still');
});

test('actions under reduced motion (as the host reads it): demo resolves \'still\' at once and nothing moves; stir leaves a tint at the point that fades in place', async (t) => {
  const w = await handleOf(t, { reducedMotion: true });
  assert.equal(await w.handle.trigger('demo'), 'still');
  assert.equal(w.inst.continuous, false);
  let state;
  w.handle.trigger('stir', { point: { x: 100, y: 90 } }).then((s) => { state = s; });
  assert.equal(w.inst.continuous, true);
  const took = w.rest();
  await w.flush();
  assert.equal(state, 'still');
  assert.ok(took > INK_LIFE * 1000 && took < INK_LIFE * 1000 + 400);
  assert.equal(w.gpu.fields.length, 0);
  const s = w.gpu.steps.find((x) => x.data[S.COUNT] > 0).data;
  assert.deepEqual([s[S.SEG], s[S.SEG + 1], s[S.SEG + 2], s[S.SEG + 3]], [100, 90, 100, 90]);
});

test('a mapper keeps the field of its own frame while later frames are rendered (four slots); options are clamped', async (t) => {
  const w = await createInk(t);
  const t0 = performance.now();
  drag(w, 100, 340, 160, t0);
  const start = performance.now() + 60;
  w.instance.render(w.frame(start));
  const first = w.instance.captureInputMapper();
  const p = { x: 240, y: 160, width: W, height: H };
  const at = first(p);
  assert.ok(Math.abs(at.x - 240) > 1, `displaced: ${at.x}`);
  const frozen = first.captureGestureSnapshot();
  for (let k = 1; k <= 3; k += 1) { w.instance.render(w.frame(start + 100 * k)); w.instance.captureInputMapper(); }
  assert.deepEqual(first(p), at, 'three newer frames did not change the mapper of the first');
  w.instance.render(w.frame(start + 400));
  const newest = w.instance.captureInputMapper()(p);
  assert.ok(Math.abs(newest.x - at.x) > 0.5, `the newest frame maps another way (control): ${newest.x} against ${at.x}`);
  assert.deepEqual(frozen(p), at, 'a gesture snapshot outlives the slots');
  const h = await handleOf(t, { options: { intensity: 7, flow: -1, pigment: 'x', heal: 2 } });
  h.handle.trigger('stir');
  h.frames(6);
  assert.ok(h.gpu.steps.some((s) => s.data[S.COUNT] > 0), 'intensity clamped to 1, pigment falls back to its default');
});
