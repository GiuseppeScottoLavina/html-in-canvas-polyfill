// Node tests of the liquid-glass plugin: the folder contract, the lens mapper against an independent formula (the height field
// differentiated numerically, Snell's law by angles), and what render() does with a recording fake GPU (spring, pinning, reduced motion,
// frame cap, no per-frame allocation, per-frame freeze of the mapper, touch drag and its claim, the demo, zero work at rest).
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractTest } from '../../_shared/contract-test.mjs';
import { fakeGpu } from '../../_shared/fake-gpu.mjs';
import { GLASS, UNIFORM_FLOATS, demoStops, lensSurface, mapLensPoint, meta, plugin, sdSquircle, writeLensGeometry } from '../index.js';

contractTest(import.meta.url);

test('meta and the definition agree; ABI v2, direct canvas attachment, the demo action, frozen', () => {
  assert.equal(plugin.type, meta.name);
  assert.equal(plugin.apiVersion, 2);
  assert.equal(plugin.outputCapabilities?.directCanvasRenderAttachment, true);
  assert.deepEqual([...(plugin.actions ?? [])], ['demo']);
  assert.ok(Object.isFrozen(plugin) && Object.isFrozen(meta) && Object.isFrozen(meta.defaults) && Object.isFrozen(plugin.actions));
});

/**
 * Independent formula, written from the description: the deformation S (stretch 1 + e along the jelly vector, squash 1 / (1 + 0.6 e)
 * across it, times the press swell) inverted numerically; the slab height z = base m + hb sqrt(1 - e^2) + dome (1 - |l|^2 / R^2) over a
 * squircle-cornered box; its normal by central differences; the refracted ray by Snell's angles in the plane of incidence.
 */
function oracle({ w, h, cx, cy, hx, hy, refraction, jx = 0, jy = 0, press = 1 }, p) {
  const e = Math.min(0.24, Math.hypot(jx, jy));
  const ux = e > 0 ? jx / Math.hypot(jx, jy) : 1;
  const uy = e > 0 ? jy / Math.hypot(jx, jy) : 0;
  const along = (1 + e) * press;
  const across = press / (1 + 0.6 * e);
  const S = [along * ux * ux + across * uy * uy, (along - across) * ux * uy, (along - across) * ux * uy, along * uy * uy + across * ux * ux];
  const det = S[0] * S[3] - S[1] * S[2];
  const toLocal = (x, y) => [(S[3] * (x - cx) - S[1] * (y - cy)) / det, (-S[2] * (x - cx) + S[0] * (y - cy)) / det];
  const m = Math.min(hx, hy);
  const r = m;
  const dist = (lx, ly) => {
    const qx = Math.abs(lx) - (hx - r);
    const qy = Math.abs(ly) - (hy - r);
    if (qx > 0 && qy > 0) return (qx ** 4 + qy ** 4) ** 0.25 - r;
    return Math.max(qx, qy) - r;
  };
  const bevel = 0.4 * m;
  const hb = refraction * 0.55 * bevel;
  const dome = refraction * 0.75 * m;
  const R2 = hx * hx + hy * hy;
  const z = (x, y) => {
    const [lx, ly] = toLocal(x, y);
    const t = Math.min(1, Math.max(0, 1 + dist(lx, ly) / bevel));
    return 0.1 * m + hb * Math.sqrt(1 - t * t) + dome * Math.max(0, 1 - (lx * lx + ly * ly) / R2);
  };
  const [lx, ly] = toLocal(p.x, p.y);
  const d = dist(lx, ly);
  const clamp = (q) => ({ x: Math.min(w, Math.max(0, q.x)), y: Math.min(h, Math.max(0, q.y)) });
  if (d >= 0) return { point: clamp(p), skip: false };
  const qx = Math.abs(lx) - (hx - r);
  const qy = Math.abs(ly) - (hy - r);
  // where the numeric derivative is meaningless: the vertical edge, and the crease of the distance inside the box
  const skip = 1 + d / bevel > 0.97 || (!(qx > 0 && qy > 0) && Math.abs(qx - qy) < 0.05);
  const k = 1e-3;
  const zx = (z(p.x + k, p.y) - z(p.x - k, p.y)) / (2 * k);
  const zy = (z(p.x, p.y + k) - z(p.x, p.y - k)) / (2 * k);
  const nl = Math.hypot(zx, zy, 1);
  const n = [-zx / nl, -zy / nl, 1 / nl];
  const sinI = Math.hypot(n[0], n[1]);
  const sinT = sinI / 1.5;
  const cosT = Math.sqrt(1 - sinT * sinT);
  // the incident ray (0, 0, -1): its part along the surface, normalised
  const it = [n[2] * n[0], n[2] * n[1], -1 + n[2] * n[2]];
  const itl = Math.hypot(...it) || 1;
  const t = [-n[0] * cosT + (it[0] / itl) * sinT, -n[1] * cosT + (it[1] / itl) * sinT, -n[2] * cosT + (it[2] / itl) * sinT];
  const T = z(p.x, p.y);
  return { point: clamp({ x: p.x + (t[0] / -t[2]) * T, y: p.y + (t[1] / -t[2]) * T }), skip };
}

function state({ w = 800, h = 500, cx = 400, cy = 250, size = 150, aspect = 1.45, refraction = 0.75, jx = 0, jy = 0, press = 1 } = {}) {
  const s = new Float32Array(UNIFORM_FLOATS);
  s[2] = w; s[3] = h;
  writeLensGeometry(s, { cx, cy, size, aspect, refraction, jx, jy, press });
  return s;
}

test('mapLensPoint equals the independent formula on a dense grid, for several lenses (moved, round, stretched, pressed)', () => {
  const lenses = [{}, { cx: 120, cy: 90, size: 200, refraction: 1 }, { size: 80, aspect: 1, refraction: 0.3 }, { cx: 790, cy: 10 },
    { jx: 0.15, jy: -0.1 }, { press: 1.07, refraction: 1 }, { aspect: 2.2, jy: 0.2 }];
  for (const o of lenses) {
    const s = state(o);
    const lens = { w: 800, h: 500, cx: s[4], cy: s[5], hx: s[6], hy: s[7], refraction: s[11], jx: o.jx, jy: o.jy, press: o.press };
    let inside = 0;
    for (let i = 0; i <= 320; i += 1) {
      for (let j = 0; j <= 200; j += 1) {
        const p = { x: i * 2.5 + 0.37, y: j * 2.5 + 0.61, width: 800, height: 500 };
        const a = mapLensPoint(s, p);
        const b = oracle(lens, p);
        if (b.skip) continue;
        if (a.x !== p.x || a.y !== p.y) inside += 1;
        assert.ok(Math.abs(a.x - b.point.x) < 0.02 && Math.abs(a.y - b.point.y) < 0.02, `${JSON.stringify(o)} at ${p.x},${p.y}: ${a.x},${a.y} vs ${b.point.x},${b.point.y}`);
      }
    }
    assert.ok(inside > 400, `${JSON.stringify(o)}: ${inside} displaced points compared`);
  }
});

test('the slab: identity outside, fixed centre, a magnifying top, a rim that bends the rays inward, bounded by the critical angle', () => {
  const s = state({ refraction: 1 });
  const at = (x, y) => mapLensPoint(s, { x, y, width: 800, height: 500 });
  assert.deepEqual(at(50, 40), { x: 50, y: 40 }, 'outside the lens nothing moves');
  const c = at(400, 250);
  assert.ok(Math.abs(c.x - 400) < 1e-9 && Math.abs(c.y - 250) < 1e-9, 'the centre shows itself');
  const mag = 20 / (at(420, 250).x - 400);
  assert.ok(mag > 1.12 && mag < 1.35, `the top magnifies: ${mag.toFixed(3)}x at refraction 1`);
  const magDefault = 20 / (mapLensPoint(state(), { x: 420, y: 250, width: 800, height: 500 }).x - 400);
  assert.ok(magDefault > 1.05 && magDefault < mag, `less at the default refraction: ${magDefault.toFixed(3)}x`);
  const hy = s[7];
  const rim = at(400, 250 - hy + 3);
  assert.ok(rim.y > 250 - hy + 3, `the rim shows the picture further in (y ${rim.y.toFixed(1)} > ${250 - hy + 3})`);
  // at the vertical edge the ray is refracted at most to the critical angle: it moves by at most tan(asin(1 / 1.5)) = 0.894 per unit of
  // thickness, here a little under: the normal is not quite horizontal half a pixel in
  const q = lensSurface(s, 400, 250 - hy + 0.5, { sd: 0, gl: 1, nx: 0, ny: 0, nz: 1, t: 0 });
  const edge = at(400, 250 - hy + 0.5);
  const moved = edge.y - (250 - hy + 0.5);
  assert.ok(moved > 0.5 * q.t && moved < Math.tan(Math.asin(1 / GLASS.ior)) * q.t, `at the edge: ${moved.toFixed(1)} px through ${q.t.toFixed(1)} px of glass`);
  assert.ok(sdSquircle(0, 0, 10, 5) < 0 && sdSquircle(20, 0, 10, 5) > 0);
  // a superellipse corner, not a circular one: it bulges past the circle of the same radius at 45 degrees
  const r = 5;
  const diag = r * Math.SQRT1_2 + 0.3;
  assert.ok(sdSquircle(10 - r + diag, 5 - r + diag, 10, 5) < 0);
});

test('refraction 0 is a flat slab: the identity everywhere (up to the canvas clamp)', () => {
  const s = state({ refraction: 0 });
  for (const [x, y] of [[400, 250], [450, 280], [400, 180], [330, 250]]) {
    const m = mapLensPoint(s, { x, y, width: 800, height: 500 });
    assert.ok(Math.abs(m.x - x) < 1e-6 && Math.abs(m.y - y) < 1e-6, `${x},${y} -> ${m.x},${m.y}`);
  }
});

/** how far the lens edge is from its centre along the direction (dx, dy), by bisection on its distance field */
function reach(s, dx, dy) {
  const q = { sd: 0, gl: 1, nx: 0, ny: 0, nz: 1, t: 0 };
  let lo = 0;
  let hi = 400;
  for (let i = 0; i < 50; i += 1) { const mid = (lo + hi) / 2; if (lensSurface(s, s[4] + dx * mid, s[5] + dy * mid, q).sd < 0) lo = mid; else hi = mid; }
  return lo;
}

test('a moving lens stretches along its velocity, also diagonally, and squashes across it; a press swells it', () => {
  const d = Math.SQRT1_2;
  const rest = state();
  const moving = state({ jx: 0.15, jy: 0.15 });
  assert.ok(reach(moving, d, d) > reach(rest, d, d) * 1.15, 'longer along the diagonal it moves on');
  assert.ok(reach(moving, -d, d) < reach(rest, -d, d) * 0.95, 'shorter across it');
  const pressed = state({ press: 1.07 });
  assert.ok(Math.abs(reach(pressed, 1, 0) / reach(rest, 1, 0) - 1.07) < 1e-3, 'the press swell scales the slab');
  assert.deepEqual([...rest.slice(8, 11)], [1, 0, 1], 'at rest the deformation is the identity');
});

async function create(options = {}, { reduced = false, source = null } = {}) {
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => '// wgsl' });
  const gpu = fakeGpu();
  const listeners = {};
  const listenOptions = {};
  let renders = 0;
  const win = { matchMedia: () => ({ matches: reduced }) };
  const canvas = { ownerDocument: { defaultView: win }, getBoundingClientRect: () => ({ left: 0, top: 0 }), clientWidth: 800, clientHeight: 500, clientLeft: 0, clientTop: 0 };
  const context = {
    apiVersion: 2, device: gpu.device, format: 'bgra8unorm', canvas, source, requestRender: () => { renders += 1; },
    listen: (type, fn, opts) => { listeners[type] = fn; listenOptions[type] = opts; return () => {}; },
  };
  try {
    const instance = await plugin.create(context, options);
    let now = 1000;
    const sourceView = {};
    const frame = (delta = 1000 / 120) => { now += delta; return { now, delta, width: 1600, height: 1000, cssWidth: 800, cssHeight: 500, sourceReady: true, sourceView, destinationView: {}, encoder: gpu.encoder }; };
    const last = () => gpu.writes.at(-1).copy;
    /** a touch event of one finger; `prevented` tells whether the plugin called preventDefault */
    const touch = (type, x, y, t, id = 7) => {
      const point = { identifier: id, clientX: x, clientY: y };
      const e = { type, timeStamp: t, cancelable: true, prevented: false, changedTouches: [point], touches: type === 'touchend' || type === 'touchcancel' ? [] : [point], preventDefault() { this.prevented = true; } };
      listeners[type](e);
      return e;
    };
    return { instance, gpu, listeners, listenOptions, frame, renders: () => renders, last, touch };
  } finally { globalThis.fetch = realFetch; }
}

test('a pinned lens starts at rest at (x, y) and the host is not kept busy', async () => {
  const { instance, last, frame } = await create({ pinned: true, x: 0.25, y: 0.5 });
  instance.render(frame());
  const u = last();
  assert.deepEqual([u[4], u[5]], [200, 250]);
  assert.equal(instance.continuous, false, 'nothing moves: no continuous rendering');
});

test('the lens follows the pointer on a spring: it overshoots a little, stretches, settles, and then stops asking for frames', async () => {
  const { instance, listeners, frame, renders, last } = await create({ x: 0.5, y: 0.5 });
  instance.render(frame());
  listeners.pointermove({ clientX: 600, clientY: 250, pointerType: 'mouse' });
  assert.equal(instance.continuous, true);
  assert.ok(renders() > 0, 'a pointer move asks the host for a frame');
  let maxX = 0;
  let stretched = false;
  for (let k = 0; k < 360 && instance.continuous; k += 1) {
    instance.render(frame());
    maxX = Math.max(maxX, last()[4]);
    if (last()[8] < 0.95) stretched = true;
  }
  const u = last();
  assert.equal(u[4], 600, 'settled exactly on the pointer');
  assert.ok(maxX > 600 && maxX < 640, `a small overshoot (${maxX})`);
  assert.ok(stretched, 'stretched along x while it moved');
  assert.deepEqual([...u.slice(8, 11)], [1, 0, 1], 'and round again at rest');
  assert.equal(instance.continuous, false, 'at rest: the host may sleep');
});

test('zero work at rest: once settled, nothing asks for a frame and every later frame is identical', async () => {
  const { instance, listeners, frame, renders, last } = await create({ x: 0.5, y: 0.5 });
  instance.render(frame());
  listeners.pointermove({ clientX: 650, clientY: 330, pointerType: 'mouse' });
  let k = 0;
  for (; k < 600 && instance.continuous; k += 1) instance.render(frame());
  assert.ok(k < 400, `settled after ${k} frames (${(k / 120).toFixed(2)} s)`);
  const asked = renders();
  const before = [...last()];
  for (let j = 0; j < 30; j += 1) instance.render(frame());
  assert.equal(renders(), asked, 'no requestRender of its own');
  assert.equal(instance.continuous, false);
  assert.deepEqual([...last()], before, 'and nothing changes');
});

test('the spring takes the same time at a 15 fps cap as at 120 fps (it integrates frame.delta)', async () => {
  const positions = [];
  for (const fps of [120, 15]) {
    const { instance, listeners, frame, last } = await create({ x: 0.5, y: 0.5 });
    instance.render(frame());
    listeners.pointermove({ clientX: 600, clientY: 250, pointerType: 'mouse' });
    for (let elapsed = 0; elapsed < 200; elapsed += 1000 / fps) instance.render(frame(1000 / fps));
    positions.push(last()[4]);
  }
  assert.ok(Math.abs(positions[0] - positions[1]) < 6, `after 200 ms: ${positions[0].toFixed(1)} at 120 fps, ${positions[1].toFixed(1)} at 15 fps`);
});

test('prefers-reduced-motion: the lens jumps to the pointer, no spring, no stretch, never continuous; the demo resolves at once', async () => {
  const { instance, listeners, frame, last } = await create({ x: 0.5, y: 0.5 }, { reduced: true });
  listeners.pointermove({ clientX: 100, clientY: 100, pointerType: 'mouse' });
  instance.render(frame());
  const u = last();
  assert.deepEqual([u[4], u[5]], [100, 100]);
  assert.equal(u[7], 75, 'half height = size / 2');
  assert.deepEqual([...u.slice(8, 11)], [1, 0, 1], 'not stretched');
  assert.equal(instance.continuous, false);
  assert.equal(await instance.runAction('demo', {}, { reducedMotion: true }), 'free');
  instance.render(frame());
  assert.deepEqual([last()[4], last()[5]], [100, 100], 'the demo did not move it');
  assert.equal(instance.continuous, false);
});

test('pinning keeps the lens where it is; the pointer no longer moves it; leaving the canvas sends an unpinned lens home', async () => {
  const { instance, listeners, frame, last } = await create({ x: 0.5, y: 0.5 });
  instance.setOptions({ ...meta.defaults, pinned: true, x: 0.5, y: 0.5 });
  listeners.pointermove({ clientX: 700, clientY: 400, pointerType: 'mouse' });
  for (let k = 0; k < 60; k += 1) instance.render(frame());
  assert.deepEqual([last()[4], last()[5]], [400, 250]);
  instance.setOptions({ ...meta.defaults, pinned: false, x: 0.5, y: 0.5 });
  listeners.pointermove({ clientX: 700, clientY: 400, pointerType: 'mouse' });
  for (let k = 0; k < 360; k += 1) instance.render(frame());
  assert.deepEqual([last()[4], last()[5]], [700, 400]);
  listeners.pointerleave({ clientX: 400, clientY: 250, pointerType: 'mouse' });
  for (let k = 0; k < 20; k += 1) instance.render(frame());
  assert.equal(last()[4], 700, 'a leave inside the canvas (to its live layer) does not move the lens');
  listeners.pointerleave({ clientX: 900, clientY: 250, pointerType: 'mouse' });
  for (let k = 0; k < 360; k += 1) instance.render(frame());
  assert.deepEqual([last()[4], last()[5]], [400, 250], 'home');
});

test('touch: a finger on the lens drags it and claims the gesture at its first move; a touch elsewhere is left to the page', async () => {
  const { instance, listeners, listenOptions, frame, last, touch } = await create({ x: 0.5, y: 0.5 });
  instance.render(frame());
  assert.equal(listenOptions.touchstart?.passive, false, 'touchstart is not passive');
  assert.equal(listenOptions.touchmove?.passive, false, 'touchmove is not passive (it may cancel the scroll)');
  // elsewhere: nothing claimed, the lens stays, and a touch pointer does not pull it either
  const t0 = touch('touchstart', 100, 60, 0);
  listeners.pointermove({ clientX: 120, clientY: 90, pointerType: 'touch' });
  const m0 = touch('touchmove', 120, 90, 16);
  touch('touchend', 120, 90, 32);
  for (let k = 0; k < 30; k += 1) instance.render(frame());
  assert.ok(!t0.prevented && !m0.prevented, 'a touch outside the lens is never prevented (the page scrolls)');
  assert.deepEqual([last()[4], last()[5]], [400, 250]);
  // on the lens, 30 px right of its centre: the grab point stays under the finger
  const s = touch('touchstart', 430, 250, 100);
  assert.ok(!s.prevented, 'touchstart is not prevented: a tap stays a tap');
  for (let k = 0; k < 6; k += 1) instance.render(frame());
  assert.ok(last()[8] < 0.98, `the press swells the lens (inverse scale ${last()[8].toFixed(3)})`);
  let claimed = true;
  for (let k = 1; k <= 20; k += 1) claimed = touch('touchmove', 430 + k * 5, 250 + k * 2, 100 + k * 16).prevented && claimed;
  assert.ok(claimed, 'every move of the drag is prevented: no scroll');
  for (let k = 0; k < 120; k += 1) instance.render(frame());
  assert.ok(Math.abs(last()[4] - 500) < 0.5 && Math.abs(last()[5] - 290) < 0.5, `the lens centre follows the finger with its grab offset: ${last()[4]}, ${last()[5]}`);
  // a slow release (the finger rested 1.9 s): no flick
  touch('touchend', 530, 290, 2000);
  for (let k = 0; k < 360 && instance.continuous; k += 1) instance.render(frame());
  assert.ok(Math.abs(last()[4] - 500) < 0.5 && Math.abs(last()[5] - 290) < 0.5, 'a release without speed leaves it where it was dropped');
  assert.equal(instance.continuous, false, 'and it comes to rest');
  assert.deepEqual([...last().slice(8, 11)], [1, 0, 1], 'unpressed and round again');
});

test('touch: a flick carries the lens on with inertia, then it settles; a tap on the lens claims nothing', async () => {
  const { instance, frame, last, touch } = await create({ x: 0.3, y: 0.5 });
  instance.render(frame());
  const tapStart = touch('touchstart', 240, 250, 0);
  const tapEnd = touch('touchend', 240, 250, 90);
  assert.ok(!tapStart.prevented && !tapEnd.prevented, 'a tap is left to the browser (native focus and click, mapped by the host)');
  for (let k = 0; k < 120 && instance.continuous; k += 1) instance.render(frame());
  touch('touchstart', 240, 250, 1000);
  for (let k = 1; k <= 8; k += 1) { touch('touchmove', 240 + k * 12, 250, 1000 + k * 8); instance.render(frame(8)); }
  touch('touchend', 336, 250, 1070);   // 1.5 px per ms to the right
  let maxX = 0;
  let k = 0;
  for (; k < 720 && instance.continuous; k += 1) { instance.render(frame()); maxX = Math.max(maxX, last()[4]); }
  assert.ok(maxX > 336 + 120, `it glides on past the release point (${maxX.toFixed(0)} px)`);
  assert.equal(instance.continuous, false, `and it settles (${k} frames)`);
});

test('a pinned lens cannot be dragged: the touch is left to the page', async () => {
  const { instance, frame, last, touch } = await create({ pinned: true, x: 0.5, y: 0.5 });
  instance.render(frame());
  touch('touchstart', 400, 250, 0);
  const move = touch('touchmove', 450, 280, 16);
  for (let k = 0; k < 60; k += 1) instance.render(frame());
  assert.ok(!move.prevented);
  assert.deepEqual([last()[4], last()[5]], [400, 250]);
});

/** a fake drawn page: elements with boxes (CSS px of an 800 x 500 source at the canvas origin) */
function fakeSource(boxes) {
  const els = boxes.map((b) => ({ localName: b.tag, getBoundingClientRect: () => ({ left: b.x, top: b.y, width: b.w, height: b.h }) }));
  return { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 500 }), querySelectorAll: () => els };
}
const PAGE = [
  { tag: 'h1', x: 40, y: 60, w: 300, h: 60 }, { tag: 'p', x: 40, y: 160, w: 300, h: 120 },
  { tag: 'input', x: 440, y: 80, w: 150, h: 34 }, { tag: 'input', x: 610, y: 80, w: 150, h: 34 },
  { tag: 'textarea', x: 440, y: 160, w: 320, h: 70 }, { tag: 'button', x: 440, y: 400, w: 90, h: 40 },
  { tag: 'label', x: 440, y: 300, w: 2, h: 2 },
];

test('demoStops: fields and headings of any page, spread out, inside the canvas, as a tour from the lens', () => {
  const stops = demoStops(/** @type {any} */ (fakeSource(PAGE)), { x: 0.73, y: 0.3 });
  assert.ok(stops.length >= 3 && stops.length <= 4, `${stops.length} stops`);
  for (const p of stops) assert.ok(p.x >= 0.1 && p.x <= 0.9 && p.y >= 0.1 && p.y <= 0.9);
  for (let i = 0; i < stops.length; i += 1) for (let j = i + 1; j < stops.length; j += 1) assert.ok(Math.hypot(stops[i].x - stops[j].x, stops[i].y - stops[j].y) > 0.12, 'far from each other');
  assert.ok(stops.some((p) => Math.abs(p.x - 0.2375) < 0.01), 'the heading is visited');
  assert.equal(demoStops(null, { x: 0.5, y: 0.5 }).length, 0);
  assert.equal(demoStops(/** @type {any} */ (fakeSource([])), { x: 0.5, y: 0.5 }).length, 0);
});

test('demo: the lens glides over the page in under 4 s and comes back to rest at home; settled() waits for it', async () => {
  const source = fakeSource(PAGE);
  const { instance, frame, last, renders } = await create({ x: 0.73, y: 0.3 }, { source });
  instance.render(frame());
  const stops = demoStops(/** @type {any} */ (source), { x: 0.73, y: 0.3 });
  const asked = renders();
  let state;
  const run = Promise.resolve(instance.runAction('demo', {}, { reducedMotion: false })).then((s) => { state = s; });
  let waited;
  const settled = Promise.resolve(instance.settled()).then((s) => { waited = s; });
  assert.ok(renders() > asked && instance.continuous, 'the demo wakes the host');
  const near = stops.map(() => Infinity);
  let k = 0;
  for (; k < 120 * 6 && (state === undefined || instance.continuous); k += 1) {
    instance.render(frame());
    const u = last();
    stops.forEach((p, i) => { near[i] = Math.min(near[i], Math.hypot(u[4] - p.x * 800, u[5] - p.y * 500)); });
    await null;
  }
  await run;
  await settled;
  assert.equal(state, 'free');
  assert.equal(waited, 'free');
  assert.ok(k / 120 <= 4.2, `it ended at rest after ${(k / 120).toFixed(2)} s`);
  // each place passes under the flat top of the lens (half height 75 px; the spring lags the tour a little)
  for (const [i, d] of near.entries()) assert.ok(d < 45, `stop ${i} visited within ${d.toFixed(1)} px`);
  assert.deepEqual([last()[4], last()[5]], [0.73 * 800, 0.3 * 500].map((v) => Math.fround(v)), 'back home');
  assert.equal(instance.continuous, false, 'and at rest: no more frames');
});

test('demo: user input takes over at once (the demo resolves null), and a pinned lens comes back to its pin', async () => {
  const { instance, listeners, frame, last } = await create({ x: 0.5, y: 0.5 });
  instance.render(frame());
  let state;
  const run = Promise.resolve(instance.runAction('demo', {}, { reducedMotion: false })).then((s) => { state = s; });
  for (let k = 0; k < 40; k += 1) instance.render(frame());
  listeners.pointermove({ clientX: 100, clientY: 400, pointerType: 'mouse' });
  await run;
  assert.equal(state, null, 'superseded by the user');
  for (let k = 0; k < 360 && instance.continuous; k += 1) instance.render(frame());
  assert.deepEqual([last()[4], last()[5]], [100, 400], 'the lens follows the user, not the tour');

  const pinned = await create({ pinned: true, x: 0.2, y: 0.4 });
  pinned.instance.render(pinned.frame());
  const done = Promise.resolve(pinned.instance.runAction('demo', {}, { reducedMotion: false }));
  for (let k = 0; k < 120 * 5 && pinned.instance.continuous; k += 1) { pinned.instance.render(pinned.frame()); await null; }
  assert.equal(await done, 'pinned');
  assert.deepEqual([pinned.last()[4], pinned.last()[5]], [160, 200]);
});

test('the per-frame path reuses its buffers: one Float32Array, one pass descriptor, no new object per frame', async () => {
  const { instance, gpu, listeners, frame } = await create({});
  listeners.pointermove({ clientX: 600, clientY: 300, pointerType: 'mouse' });
  for (let k = 0; k < 10; k += 1) { instance.render(frame()); instance.captureInputMapper(); }
  assert.equal(new Set(gpu.writes.map((w) => w.data)).size, 1, 'the same uniform array every frame');
  assert.equal(new Set(gpu.passes).size, 1, 'the same render pass descriptor every frame');
  assert.equal(new Set(gpu.passes.map((p) => p.colorAttachments[0])).size, 1);
});

test('a mapper describes the frame it was captured for; a gesture snapshot is a copy', async () => {
  const { instance, listeners, frame } = await create({ x: 0.5, y: 0.5 });
  instance.render(frame());
  const first = instance.captureInputMapper();
  const probe = { x: 430, y: 250, width: 800, height: 500 };
  const before = first(probe);
  const snapshot = first.captureGestureSnapshot();
  listeners.pointermove({ clientX: 100, clientY: 100, pointerType: 'mouse' });
  for (let k = 0; k < 2; k += 1) { instance.render(frame()); instance.captureInputMapper(); }
  assert.deepEqual(first(probe), before, 'still the first frame after two more presentations (the host keeps three)');
  for (let k = 0; k < 6; k += 1) { instance.render(frame()); instance.captureInputMapper(); }
  assert.deepEqual(snapshot(probe), before, 'the gesture snapshot never changes');
  assert.notDeepEqual(instance.captureInputMapper()(probe), before, 'while the newest mapper follows the moved lens');
});

test('options are clamped; setOptions reaches the uniform block', async () => {
  const { instance, frame, last } = await create({ size: 9999, refraction: -1, dispersion: 3, frost: 9 });
  instance.render(frame());
  let u = last();
  assert.equal(u[7], 140, 'size clamped to 280');
  assert.deepEqual([u[11], u[12], u[13]], [0, 1, 1]);
  instance.setOptions({ size: 100, refraction: 0.5, dispersion: 0.25, frost: 0.5, highlight: 0, shadow: 0.5 });
  instance.render(frame());
  u = last();
  assert.deepEqual([u[7], u[11], u[12], u[13], u[14], u[16]], [50, 0.5, 0.25, 0.5, 0, 0.5]);
});
