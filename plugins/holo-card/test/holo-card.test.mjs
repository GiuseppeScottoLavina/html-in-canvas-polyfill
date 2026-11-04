// Node tests of the holo-card plugin: the folder contract, the perspective mapper against an independent projection, and what render()
// does with a recording fake GPU (tilt spring, idle sway, reduced motion, frame cap, no per-frame allocation, per-frame mapper freeze),
// the passive touch tilt, the device tilt (option `motion`), the action 'demo' (also through the real handle) and zero work at rest.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractTest } from '../../_shared/contract-test.mjs';
import { fakeGpu } from '../../_shared/fake-gpu.mjs';
import { ACTIONS, DEMO_MS, SWAY_HZ, MOTION_RANGE, NO_TARGET, UNIFORM_FLOATS, demoTarget, mapCardPoint, meta, motionTarget, plugin, writeCardPose } from '../index.js';
import { nodeHandle } from '../../_shared/node-host.mjs';

contractTest(import.meta.url);

test('meta and the definition agree; ABI v2, direct canvas attachment, frozen', () => {
  assert.equal(plugin.type, meta.name);
  assert.equal(plugin.apiVersion, 2);
  assert.equal(plugin.outputCapabilities?.directCanvasRenderAttachment, true);
  assert.ok(Object.isFrozen(plugin) && Object.isFrozen(meta) && Object.isFrozen(meta.defaults));
  assert.deepEqual([...plugin.actions], ['demo']);
  assert.deepEqual([...ACTIONS], [...plugin.actions]);
});

function pose(rx, ry, { w = 1100, h = 620, scale = 0.86 } = {}) {
  const s = new Float32Array(UNIFORM_FLOATS);
  s[2] = w; s[3] = h;
  writeCardPose(s, rx, ry, scale, w, h);
  return s;
}

/**
 * Independent check, in the FORWARD direction: put a source point on the card (scale, rotate about the centre with matrices), project
 * it to the screen with a pinhole camera D px in front, then the mapper of that screen point must give the source point back.
 */
function project(rx, ry, { w = 1100, h = 620, scale = 0.86 }, src) {
  const D = 2 * Math.max(w, h);
  const v = [(src.x - w / 2) * scale, (src.y - h / 2) * scale, 0];
  const rotX = ([x, y, z]) => [x, y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
  const rotY = ([x, y, z]) => [x * Math.cos(ry) + z * Math.sin(ry), y, -x * Math.sin(ry) + z * Math.cos(ry)];
  const [x, y, z] = rotY(rotX(v));
  const f = D / (D + z);   // the eye is at z = -D, the canvas at z = 0
  return { x: w / 2 + x * f, y: h / 2 + y * f };
}

test('mapCardPoint inverts the forward projection of the card (rotation + perspective) on a grid of source points', () => {
  for (const [rx, ry] of [[0, 0], [0.3, -0.2], [-0.5, 0.45], [0.2, 0.52]]) {
    const s = pose(rx, ry);
    for (let i = 1; i < 20; i += 1) {
      for (let j = 1; j < 12; j += 1) {
        const src = { x: (i / 20) * 1100, y: (j / 12) * 620 };
        const screen = project(rx, ry, { w: 1100, h: 620, scale: 0.86 }, src);
        const back = mapCardPoint(s, { ...screen, width: 1100, height: 620 });
        assert.ok(Math.abs(back.x - src.x) < 1e-3 && Math.abs(back.y - src.y) < 1e-3, `rx=${rx} ry=${ry} src ${src.x},${src.y} -> ${back.x},${back.y}`);
      }
    }
  }
});

test('flat card: a plain scale about the centre; beside the card the mapper reaches nothing', () => {
  const s = pose(0, 0);
  const at = (x, y) => mapCardPoint(s, { x, y, width: 1100, height: 620 });
  const c = at(550, 310);
  assert.ok(Math.abs(c.x - 550) < 1e-9 && Math.abs(c.y - 310) < 1e-9);
  const q = at(550 + 86, 310);
  assert.ok(Math.abs(q.x - 650) < 1e-4, 'scale 0.86 (stored as f32)');
  assert.equal(at(20, 20), NO_TARGET, 'the background beside the card');
});

test('tilt towards the pointer: the side under the pointer comes closer (drawn larger)', () => {
  const s = pose(0, 0.4);   // the pose the plugin writes for a pointer on the right
  const right = project(0, 0.4, { w: 1100, h: 620, scale: 0.86 }, { x: 1000, y: 310 });
  const left = project(0, 0.4, { w: 1100, h: 620, scale: 0.86 }, { x: 100, y: 310 });
  assert.ok(right.x - 550 > 550 - left.x, 'the right half is wider on screen');
  assert.ok(Number.isFinite(mapCardPoint(s, { x: 0, y: 0, width: 1100, height: 620 }).x));
});


async function create(options = {}, { reduced = false } = {}) {
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => '// wgsl' });
  const gpu = fakeGpu();
  const listeners = {};
  const listenOptions = {};
  const win = Object.assign(new EventTarget(), { matchMedia: () => ({ matches: reduced }), screen: { orientation: { angle: 0 } } });
  const canvas = { ownerDocument: { defaultView: win }, getBoundingClientRect: () => ({ left: 0, top: 0 }), clientWidth: 1100, clientHeight: 620, clientLeft: 0, clientTop: 0 };
  let requests = 0;
  const context = { apiVersion: 2, device: gpu.device, format: 'bgra8unorm', canvas, requestRender() { requests += 1; }, listen: (type, fn, o) => { listeners[type] = fn; listenOptions[type] = o; return () => {}; } };
  try {
    const instance = await plugin.create(context, options);
    let now = performance.now();
    const frame = (delta = 1000 / 120) => { now += delta; return { now, delta, width: 2200, height: 1240, cssWidth: 1100, cssHeight: 620, sourceReady: true, sourceView: {}, destinationView: {}, encoder: gpu.encoder }; };
    return { instance, gpu, listeners, listenOptions, frame, win, requests: () => requests };
  } finally { globalThis.fetch = realFetch; }
}

/** rotation about y written into the block: ex = (cos ry, 0, -sin ry) */
const ryOf = (u) => Math.atan2(-u[6], u[4]);

test('the card tilts towards the pointer on a spring, settles exactly, then stops asking for frames', async () => {
  const { instance, gpu, listeners, frame } = await create({ tilt: 20, idle: false });
  instance.render(frame());
  assert.equal(instance.continuous, false, 'no idle sway, no pointer: at rest');
  listeners.pointermove({ clientX: 1100, clientY: 310 });
  assert.equal(instance.continuous, true);
  for (let k = 0; k < 400 && instance.continuous; k += 1) instance.render(frame());
  assert.ok(Math.abs(ryOf(gpu.writes.at(-1).copy) - (20 * Math.PI) / 180) < 1e-6, 'full tilt towards the right edge');
  assert.equal(instance.continuous, false);
});

test('the spring takes the same time at a 15 fps cap as at 120 fps', async () => {
  const angles = [];
  for (const fps of [120, 15]) {
    const { instance, gpu, listeners, frame } = await create({ tilt: 20, idle: false });
    instance.render(frame());
    listeners.pointermove({ clientX: 1100, clientY: 310 });
    for (let elapsed = 0; elapsed < 200; elapsed += 1000 / fps) instance.render(frame(1000 / fps));
    angles.push(ryOf(gpu.writes.at(-1).copy));
  }
  assert.ok(Math.abs(angles[0] - angles[1]) < 0.02, `after 200 ms: ${angles[0].toFixed(3)} at 120 fps, ${angles[1].toFixed(3)} at 15 fps`);
});

test('idle sway animates while the pointer is away; leaving the canvas brings it back', async () => {
  const { instance, gpu, listeners, frame } = await create({ idle: true });
  instance.render(frame(500));
  assert.equal(instance.continuous, true);
  listeners.pointermove({ clientX: 550, clientY: 310 });
  for (let k = 0; k < 400 && instance.continuous; k += 1) instance.render(frame());
  assert.equal(instance.continuous, false, 'the pointer is over the card: it settles flat under a centred pointer');
  assert.ok(Math.abs(ryOf(gpu.writes.at(-1).copy)) < 1e-9);
  listeners.pointerleave({ clientX: 1200, clientY: 310 });
  instance.render(frame());
  assert.equal(instance.continuous, true, 'away again: swaying');
});

test('prefers-reduced-motion: the card stays flat, nothing is continuous, the glare still follows the pointer', async () => {
  const { instance, gpu, listeners, frame } = await create({ idle: true, tilt: 30 }, { reduced: true });
  listeners.pointermove({ clientX: 1100, clientY: 0 });
  instance.render(frame());
  const u = gpu.writes.at(-1).copy;
  assert.equal(ryOf(u), 0);
  assert.deepEqual([u[4], u[9], u[14]], [1, 1, 1], 'identity rotation');
  assert.deepEqual([u[18], u[19]], [1, 0], 'glare at the pointer');
  assert.equal(u[20], 0, 'no shimmer over time');
  assert.equal(instance.continuous, false);
});

test('the per-frame path reuses its buffers: one Float32Array, one pass descriptor', async () => {
  const { instance, gpu, frame } = await create({});
  for (let k = 0; k < 10; k += 1) { instance.render(frame()); instance.captureInputMapper(); }
  assert.equal(new Set(gpu.writes.map((w) => w.data)).size, 1);
  assert.equal(new Set(gpu.passes).size, 1);
});

test('a mapper describes the pose of its own frame; a gesture snapshot is a copy', async () => {
  const { instance, frame } = await create({ idle: true, tilt: 25 });
  instance.render(frame(300));
  const first = instance.captureInputMapper();
  const snapshot = first.captureGestureSnapshot();
  const probe = { x: 900, y: 120, width: 1100, height: 620 };
  const before = first(probe);
  for (let k = 0; k < 2; k += 1) { instance.render(frame(300)); instance.captureInputMapper(); }
  assert.deepEqual(first(probe), before);
  for (let k = 0; k < 6; k += 1) { instance.render(frame(300)); instance.captureInputMapper(); }
  assert.deepEqual(snapshot(probe), before);
  assert.notDeepEqual(instance.captureInputMapper()(probe), before, 'the sway moved the card since');
});

test('options are clamped; setOptions reaches the uniform block', async () => {
  const { instance, gpu, frame } = await create({ foil: 4, glare: -1, tilt: 99 });
  instance.render(frame());
  let u = gpu.writes.at(-1).copy;
  assert.deepEqual([u[16], u[17]], [1, 0]);
  instance.setOptions({ ...meta.defaults, foil: 0.25, glare: 0.5 });
  instance.render(frame());
  u = gpu.writes.at(-1).copy;
  assert.deepEqual([u[16], u[17]], [0.25, 0.5]);
});

/** a touch event as the browser delivers it to a passive listener: preventDefault would be ignored, the test counts the calls */
function touch(x, y, calls) {
  return { touches: x === null ? [] : [{ clientX: x, clientY: y }], cancelable: false, preventDefault() { calls.n += 1; } };
}

test('touch: a finger tilts the card where it rests, through PASSIVE listeners that never call preventDefault; lifting it lets the card go', async () => {
  const { instance, gpu, listeners, listenOptions, frame } = await create({ tilt: 20, idle: false });
  for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
    assert.equal(typeof listeners[type], 'function', type);
    assert.equal(listenOptions[type]?.passive, true, `${type} is passive: the page keeps its scroll`);
  }
  instance.render(frame());
  const calls = { n: 0 };
  listeners.touchstart(touch(1100, 310, calls));
  for (let k = 0; k < 400 && instance.continuous; k += 1) instance.render(frame());
  assert.ok(Math.abs(ryOf(gpu.writes.at(-1).copy) - (20 * Math.PI) / 180) < 1e-6, 'tilted towards the finger on the right edge');
  listeners.touchmove(touch(0, 310, calls));   // the finger moves (the page may scroll meanwhile: touchmove keeps coming)
  for (let k = 0; k < 400 && instance.continuous; k += 1) instance.render(frame());
  assert.ok(Math.abs(ryOf(gpu.writes.at(-1).copy) + (20 * Math.PI) / 180) < 1e-6, 'follows the finger to the left edge');
  // pointer events of the same finger are ignored (they stop at pointercancel when the page scrolls): no double handling, no release
  listeners.pointerleave({ pointerType: 'touch', clientX: 0, clientY: 310 });
  instance.render(frame());
  assert.equal(instance.continuous, false, 'still held');
  listeners.touchend(touch(null, null, calls));
  assert.equal(instance.continuous, true, 'released: the card springs back');
  for (let k = 0; k < 400 && instance.continuous; k += 1) instance.render(frame());
  assert.ok(Math.abs(ryOf(gpu.writes.at(-1).copy)) < 1e-9, 'flat again');
  assert.equal(calls.n, 0, 'no preventDefault: the card never claims the gesture');
});

test('demoTarget: a smooth sweep that starts and ends at the rest target and reaches the edges of the card in between', () => {
  const rest = { x: 0.3, y: -0.2 };
  assert.deepEqual(demoTarget(0, rest), rest);
  const end = demoTarget(1, rest);
  assert.ok(Math.abs(end.x - rest.x) < 1e-9 && Math.abs(end.y - rest.y) < 1e-9);
  let minX = 1, maxX = -1, minY = 1, maxY = -1, jump = 0, prev = demoTarget(0, rest);
  for (let i = 1; i <= 400; i += 1) {
    const p = demoTarget(i / 400, rest);
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    jump = Math.max(jump, Math.hypot(p.x - prev.x, p.y - prev.y));
    prev = p;
  }
  assert.ok(minX < -0.6 && maxX > 0.6 && minY < -0.3 && maxY > 0.3, `range x ${minX.toFixed(2)}..${maxX.toFixed(2)}, y ${minY.toFixed(2)}..${maxY.toFixed(2)}`);
  assert.ok(jump < 0.05, `no jump: ${jump.toFixed(3)} per 1/400 of the demo`);
});

test('the action demo: the tilt sweeps both ways and the glare travels, it resolves \'rest\' once the card has come to rest, then no frame is needed', async () => {
  const { instance, gpu, frame } = await create({ tilt: 14, idle: false });
  instance.render(frame());
  assert.equal(instance.continuous, false);
  assert.equal(await instance.settled(), 'rest', 'at rest: at once');
  let state = 'pending';
  Promise.resolve(instance.runAction('demo', {}, { reducedMotion: false })).then((v) => { state = v; });
  assert.equal(instance.continuous, true, 'the demo asks for frames');
  let minRy = 0, maxRy = 0, minGx = 1, maxGx = 0, frames = 0;
  for (let k = 0; k < 2000 && state === 'pending'; k += 1) {
    instance.render(frame());
    frames += 1;
    const u = gpu.writes.at(-1).copy;
    minRy = Math.min(minRy, ryOf(u)); maxRy = Math.max(maxRy, ryOf(u)); minGx = Math.min(minGx, u[18]); maxGx = Math.max(maxGx, u[18]);
    await Promise.resolve();
  }
  const tilt = (14 * Math.PI) / 180;
  assert.equal(state, 'rest');
  assert.ok(minRy < -0.6 * tilt && maxRy > 0.6 * tilt, `tilt ${minRy.toFixed(3)}..${maxRy.toFixed(3)} rad`);
  assert.ok(minGx < 0.25 && maxGx > 0.75, `the glare travels over the card: ${minGx.toFixed(2)}..${maxGx.toFixed(2)}`);
  assert.ok(frames >= (DEMO_MS / 1000) * 120 && frames < (DEMO_MS / 1000 + 1.5) * 120, `${frames} frames at 120 Hz for a ${DEMO_MS} ms demo`);
  for (let k = 0; k < 200 && instance.continuous; k += 1) instance.render(frame());
  assert.equal(instance.continuous, false, 'zero work at rest after the demo');
});

test('the demo with the idle sway on lands on the sway without a jump; a pointer move takes over at once (the demo resolves null)', async () => {
  const { instance, gpu, listeners, frame } = await create({ tilt: 14, idle: true });
  instance.render(frame());
  let state = 'pending';
  Promise.resolve(instance.runAction('demo', {}, { reducedMotion: false })).then((v) => { state = v; });
  let prev = null, jump = 0;
  for (let k = 0; k < 2000 && state === 'pending'; k += 1) {
    instance.render(frame());
    const ry = ryOf(gpu.writes.at(-1).copy);
    if (prev !== null) jump = Math.max(jump, Math.abs(ry - prev));
    prev = ry;
    await Promise.resolve();
  }
  assert.equal(state, 'rest');
  assert.ok(jump < 0.01, `largest step between frames ${jump.toFixed(4)} rad`);
  assert.equal(instance.continuous, true, 'the declared idle sway goes on');
  let cut = 'pending';
  Promise.resolve(instance.runAction('demo', {}, { reducedMotion: false })).then((v) => { cut = v; });
  for (let k = 0; k < 30; k += 1) instance.render(frame());
  listeners.pointermove({ pointerType: 'mouse', clientX: 900, clientY: 100 });
  await Promise.resolve();
  assert.equal(cut, null, 'the user took over');
  let opt = 'pending';
  Promise.resolve(instance.runAction('demo', {}, { reducedMotion: false })).then((v) => { opt = v; });
  for (let k = 0; k < 30; k += 1) instance.render(frame());
  instance.setOptions({ foil: 0.3 });
  await Promise.resolve();
  assert.equal(opt, null, 'setOptions takes over too');
});

test('the action demo with reduced motion resolves \'rest\' at once; the card stays flat', async () => {
  const { instance, gpu, frame } = await create({ tilt: 14 }, { reduced: true });
  instance.render(frame());
  assert.equal(await instance.runAction('demo', {}, { reducedMotion: true }), 'rest');
  instance.render(frame());
  assert.equal(ryOf(gpu.writes.at(-1).copy), 0);
  assert.equal(instance.continuous, false);
});

test('the action demo through the effect handle (the host\'s validation, superseding, settled)', async (t) => {
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
  const realFetch = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async () => ({ ok: true, text: async () => '// wgsl' }));
  t.after(() => { globalThis.fetch = realFetch; });
  const gpu = fakeGpu();
  const win = Object.assign(new EventTarget(), { matchMedia: () => ({ matches: false }) });
  const canvas = Object.assign(new EventTarget(), { ownerDocument: { defaultView: win }, getBoundingClientRect: () => ({ left: 0, top: 0 }), clientWidth: 1100, clientHeight: 620, clientLeft: 0, clientTop: 0 });
  const { handle, inst } = await nodeHandle(plugin, { idle: false }, { device: gpu.device, canvas, source: new EventTarget() });
  assert.deepEqual([...handle.actions], ['demo']);
  await assert.rejects(handle.trigger('tilt'), /unknown action "tilt" of the plugin "holo-card"; its actions are 'demo'/);
  let now = 1000;
  const frame = () => { now += 1000 / 60; return { now, delta: 1000 / 60, width: 2200, height: 1240, cssWidth: 1100, cssHeight: 620, sourceReady: true, sourceView: {}, destinationView: {}, encoder: gpu.encoder }; };
  inst.render(frame());
  const first = handle.trigger('demo');
  const second = handle.trigger('demo');
  assert.equal(await first, null, 'superseded');
  let state = 'pending';
  second.then((v) => { state = v; });
  for (let k = 0; k < 600 && state === 'pending'; k += 1) { inst.render(frame()); await new Promise((r) => setImmediate(r)); }
  assert.equal(state, 'rest');
  assert.equal(await handle.settled(), 'rest');
  handle.remove();
});

test('motionTarget: device degrees to card tilt in screen axes, for every screen orientation, clamped', () => {
  assert.deepEqual(motionTarget(MOTION_RANGE / 2, -MOTION_RANGE / 4, 0), { x: 0.5, y: -0.25 });
  assert.deepEqual(motionTarget(MOTION_RANGE / 2, -MOTION_RANGE / 4, 90), { x: -0.25, y: -0.5 });
  assert.deepEqual(motionTarget(MOTION_RANGE / 2, -MOTION_RANGE / 4, 180), { x: -0.5, y: 0.25 });
  assert.deepEqual(motionTarget(MOTION_RANGE / 2, -MOTION_RANGE / 4, 270), { x: 0.25, y: 0.5 });
  assert.deepEqual(motionTarget(MOTION_RANGE / 2, -MOTION_RANGE / 4, -90), { x: 0.25, y: 0.5 });
  assert.deepEqual(motionTarget(5 * MOTION_RANGE, -5 * MOTION_RANGE, 0), { x: 1, y: -1 });
});

/** a deviceorientation event (Node has no DeviceOrientationEvent: a plain Event with the two angles) */
function orientation(gamma, beta) { return Object.assign(new Event('deviceorientation'), { gamma, beta }); }

test('option motion: the device orientation tilts the card (relative to how it was held), sensor noise wakes nothing, and turning it off removes the listener', async () => {
  const { instance, gpu, frame, win, requests } = await create({ tilt: 20, idle: true, motion: true });
  instance.render(frame());
  assert.equal(instance.continuous, false, 'with the device tilt on, the idle sway is off');
  win.dispatchEvent(orientation(3, 40));   // the reference: how the device is held
  win.dispatchEvent(orientation(3 + MOTION_RANGE, 40));
  for (let k = 0; k < 400 && instance.continuous; k += 1) instance.render(frame());
  const ry = ryOf(gpu.writes.at(-1).copy);
  assert.ok(ry > 0.8 * (20 * Math.PI) / 180, `tilted by the device: ${ry.toFixed(3)} rad`);
  const n = requests();
  win.dispatchEvent(orientation(3 + MOTION_RANGE + 0.05, 40.05));
  assert.equal(requests(), n, 'a change inside the dead band asks for no frame');
  instance.setOptions({ motion: false });
  for (let k = 0; k < 400 && instance.continuous && k < 50; k += 1) instance.render(frame());
  const m = requests();
  win.dispatchEvent(orientation(-30, 10));
  assert.equal(requests(), m, 'no listener any more');
});

test('option motion is ignored with reduced motion (the card stays flat)', async () => {
  const { instance, gpu, frame, win } = await create({ tilt: 20, motion: true }, { reduced: true });
  win.dispatchEvent(orientation(0, 40));
  win.dispatchEvent(orientation(30, 40));
  instance.render(frame());
  assert.equal(ryOf(gpu.writes.at(-1).copy), 0);
});

test('the idle sway alone is redrawn SWAY_HZ times a second from a timer (not at the display rate); an interaction brings every frame back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { instance, gpu, listeners, frame, requests } = await create({ tilt: 14, idle: true });
  for (let k = 0; k < 120; k += 1) instance.render(frame());   // 1 s at 120 Hz: the spring settles onto the sway
  assert.equal(instance.continuous, false, 'the sway alone is not continuous');
  const n0 = requests();
  let frames = 0;
  const angles = new Set();
  for (let ms = 0; ms < 1000; ms += 1000 / SWAY_HZ) {
    t.mock.timers.tick(1000 / SWAY_HZ);
    if (requests() > n0 + frames) { frames += 1; instance.render(frame(1000 / SWAY_HZ)); angles.add(ryOf(gpu.writes.at(-1).copy).toFixed(6)); }
  }
  assert.ok(frames >= SWAY_HZ - 2 && frames <= SWAY_HZ + 1, `${frames} frames in 1 s of sway`);
  assert.ok(angles.size >= SWAY_HZ - 3, 'every one of them shows the card further along its sway');
  listeners.pointermove({ pointerType: 'mouse', clientX: 900, clientY: 100 });
  assert.equal(instance.continuous, true, 'the pointer: every frame again');
  instance.destroy();
});
