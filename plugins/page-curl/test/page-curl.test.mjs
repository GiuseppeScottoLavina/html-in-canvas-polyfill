// Node tests of the page-curl plugin: the folder contract, the curl geometry and the mapper formula (against an independent port of the
// whole shader region decision), the grab gesture (which events are taken from the page), the release on the frame clock (the same at
// every frame cap), reduced motion, and the render path (no allocation per frame).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { checkPluginFolder } from '../../_shared/contract.mjs';
import { NO_TARGET, RELEASE_MS, UNIFORM_FLOATS, curlGeometry, hotCorner, isNoTarget, mapCurlPoint, meta, parseColor, plugin, releaseEase } from '../index.js';

const W = 480;
const H = 320;

test('the folder satisfies the plugin contract (plugins/README.md)', async () => {
  assert.deepEqual(await checkPluginFolder(fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')), []);
});

test('meta and the definition agree; the defaults are valid options', () => {
  assert.equal(plugin.type, meta.name);
  assert.equal(plugin.apiVersion, 2);
  assert.deepEqual(Object.keys(meta.defaults).sort(), ['corner', 'radius', 'shadow']);
});

/** @param {number} cx @param {number} cy @param {number} dx @param {number} dy @param {number} [r] */
function state(cx, cy, dx, dy, r = 36) {
  const s = new Float32Array(UNIFORM_FLOATS);
  s[2] = W; s[3] = H;
  curlGeometry(s, cx, cy, dx, dy, r);
  return s;
}

/**
 * Independent port of fs() in page-curl.wgsl (written from the shader, not from mapCurlPoint): which layer a presented point shows,
 * and the source point it samples.
 * @param {Float32Array} u
 * @param {number} x @param {number} y
 */
function shaderRegion(u, x, y) {
  if (u[8] < 0.5) return { region: 'flat', q: [x, y] };
  const [dx, dy, axis] = [u[4], u[5], u[6]];
  const r = Math.max(u[7], 0.001);
  const ins = (qx, qy) => qx >= 0 && qy >= 0 && qx <= u[2] && qy <= u[3];
  const s = x * dx + y * dy - axis;
  if (s < 0) {
    const k = Math.PI * r - 2 * s;
    if (ins(x + k * dx, y + k * dy)) return { region: 'back', q: [x + k * dx, y + k * dy] };
    return { region: 'flat', q: [x, y] };
  }
  if (s <= r) {
    const up = Math.PI - Math.asin(Math.min(1, s / r));
    const kb = r * up - s;
    if (ins(x + kb * dx, y + kb * dy)) return { region: 'curl-back', q: [x + kb * dx, y + kb * dy] };
    const lo = Math.asin(Math.min(1, s / r));
    const kf = r * lo - s;
    if (ins(x + kf * dx, y + kf * dy)) return { region: 'curl-front', q: [x + kf * dx, y + kf * dy] };
  }
  return { region: 'under', q: null };
}

test('geometry: the dragged corner lands exactly under the pointer, back side up (any direction, any length)', () => {
  for (const [cx, cy] of [[W, H], [0, 0], [W, 0], [0, H]]) {
    for (const [dx, dy] of [[300, 200], [240, 160], [W - 150, H - 20], [30, 300], [W - 5, H - 5]]) {
      const u = state(cx, cy, dx, dy);
      const len = Math.hypot(cx - dx, cy - dy);
      // half a pixel from the tip, along the pull, the presented pixel shows the back of the page half a pixel from the corner
      const back = shaderRegion(u, dx + 0.5 * u[4], dy + 0.5 * u[5]);
      assert.ok(back.region === 'back' || back.region === 'curl-back', `corner ${cx},${cy} -> ${dx},${dy}: ${back.region}`);
      assert.ok(Math.abs(Math.hypot(back.q[0] - cx, back.q[1] - cy) - 0.5) < 0.01, `the tip samples the corner (${back.q}, pull ${len.toFixed(1)} px)`);
    }
  }
});

test('geometry: a pull shorter than half a pixel is no curl; a short pull uses a thinner cylinder (r <= distance / pi)', () => {
  assert.equal(state(W, H, W - 0.2, H - 0.2)[8], 0);
  const u = state(W, H, W - 20, H);
  assert.equal(u[8], 1);
  assert.ok(Math.abs(u[7] - 20 / Math.PI) < 1e-4);
  assert.ok(Math.abs(state(W, H, 200, H)[7] - 36) < 1e-6);
});

test('the mapper: identity where the shader shows the flat page, the exact point on the front of the curl, NO_TARGET on the back and underneath (every pixel, 6 poses)', () => {
  const poses = [[W, H, 300, 200], [W, H, 420, 300], [0, 0, 200, 150], [W, 0, 100, 250], [0, H, 470, 10], [W, H, 2, 2]];
  for (const [cx, cy, dx, dy] of poses) {
    const u = state(cx, cy, dx, dy);
    const counts = { flat: 0, front: 0, other: 0 };
    for (let y = 0.5; y < H; y += 1) {
      for (let x = 0.5; x < W; x += 1) {
        const m = mapCurlPoint(u, { x, y, width: W, height: H });
        const region = shaderRegion(u, x, y).region;
        const shown = shaderRegion(u, x, y);
        if (region === 'flat') { counts.flat += 1; assert.deepEqual(m, { x, y }); }
        else if (region === 'curl-front') { counts.front += 1; assert.ok(Math.abs(m.x - shown.q[0]) < 1e-3 && Math.abs(m.y - shown.q[1]) < 1e-3, `${x},${y}: ${JSON.stringify(m)} vs ${shown.q}`); }
        else { counts.other += 1; assert.ok(isNoTarget(m), `${x},${y} is ${region}`); }
      }
    }
    assert.ok(counts.other > 500, `pose ${[cx, cy, dx, dy]}: the curl covers ${counts.other} px`);
  }
});

test('released (no curl): the mapper is the identity everywhere, including the hot zones', () => {
  const u = state(W, H, W, H);
  for (const [x, y] of [[0, 0], [W, H], [W - 3, H - 3], [240, 160]]) assert.deepEqual(mapCurlPoint(u, { x, y, width: W, height: H }), { x, y });
});

test('the mapper scales from the presented size to the page size of its frame', () => {
  const u = state(W, H, 300, 200);
  const a = mapCurlPoint(u, { x: 100, y: 100, width: W, height: H });
  const b = mapCurlPoint(u, { x: 200, y: 200, width: 2 * W, height: 2 * H });
  assert.deepEqual(a, { x: 100, y: 100 });
  assert.deepEqual(b, { x: 200, y: 200 });
  assert.ok(isNoTarget(mapCurlPoint(u, { x: 2 * 470, y: 2 * 310, width: 2 * W, height: 2 * H })));
  assert.ok(Number.isFinite(NO_TARGET.x) && Number.isFinite(NO_TARGET.y), 'the host requires finite points');
});

test('hot zones: corners only, `corner` restricts them, points off the page never grab', () => {
  assert.equal(hotCorner(470, 310, W, H, 'any', 64), 'br');
  assert.equal(hotCorner(10, 10, W, H, 'any', 64), 'tl');
  assert.equal(hotCorner(10, 10, W, H, 'br', 64), null);
  assert.equal(hotCorner(240, 160, W, H, 'any', 64), null);
  assert.equal(hotCorner(W + 1, H, W, H, 'any', 64), null);
  assert.equal(hotCorner(W - 70, H, W, H, 'any', 64), null);
});

test('options: colours parse, the release eases from 0 to 1', () => {
  assert.deepEqual(parseColor('#ff0000'), [1, 0, 0]);
  assert.deepEqual(parseColor('#fff'), [1, 1, 1]);
  assert.equal(parseColor('nope').length, 3);
  assert.equal(releaseEase(0), 0);
  assert.equal(releaseEase(1), 1);
  assert.ok(releaseEase(0.5) > 0.5);
});

// ------------------------------------------------------------------------------------------------ the instance, with a recording fake GPU
function fakeEnv({ reduced = false } = {}) {
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
  const writes = [];
  const passes = [];
  const device = {
    createShaderModule: () => ({}), createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }), createBuffer: () => ({ destroy() {} }),
    createSampler: () => ({}), createBindGroup: () => ({}), queue: { writeBuffer: (_b, _o, d) => writes.push(d) },
  };
  const encoder = { beginRenderPass: (d) => { passes.push(d); return { setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }; } };
  const docListeners = new Map();
  const doc = {
    defaultView: { matchMedia: () => ({ matches: reduced }) },
    addEventListener: (type, fn, capture) => { assert.equal(capture, true); docListeners.set(type, fn); },
    removeEventListener: (type, fn) => { if (docListeners.get(type) === fn) docListeners.delete(type); },
  };
  const captured = [];
  const canvas = {
    ownerDocument: doc, clientWidth: W, clientHeight: H,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: W, height: H }),
    setPointerCapture: (id) => captured.push(id), releasePointerCapture: (id) => captured.push(-id),
  };
  const source = {};
  let renders = 0;
  const context = { device, format: 'bgra8unorm', canvas, source, requestRender() { renders += 1; }, listen: () => () => {} };
  /** @param {string} type @param {number} x page css px @param {number} y @param {object} [o] */
  const fire = (type, x, y, o = {}) => {
    const e = {
      type, pointerId: 1, isPrimary: true, button: 0, detail: 1, clientX: 10 + x, clientY: 20 + y, prevented: false, stopped: false,
      composedPath: () => [canvas], preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...o,
    };
    docListeners.get(type)?.(e);
    return e;
  };
  const frame = (now) => ({ now, width: W, height: H, cssWidth: W, cssHeight: H, sourceReady: true, sourceView: {}, destinationView: {}, encoder });
  return { context, writes, passes, docListeners, fire, frame, captured, renders: () => renders };
}

async function created(t, env, options = meta.defaults) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => '// wgsl' }); // source mode loads page-curl.wgsl; Node has no server
  t.after(() => { globalThis.fetch = realFetch; });
  return plugin.create(/** @type {any} */ (env.context), options);
}

test('the grab is the plugin\'s gesture: down/move/up/click are taken from the page, the pointer is captured; elsewhere nothing is taken', async (t) => {
  const env = fakeEnv();
  const inst = await created(t, env);
  const miss = env.fire('pointerdown', 240, 160);
  assert.equal(miss.prevented || miss.stopped, false, 'a press away from the corners belongs to the form');
  const down = env.fire('pointerdown', 470, 312);
  assert.ok(down.prevented && down.stopped, 'the grab never reaches the interposer or the form');
  assert.deepEqual(env.captured, [1]);
  const move = env.fire('pointermove', 300, 200);
  assert.ok(move.prevented && move.stopped);
  inst.render(env.frame(0));
  assert.equal(env.writes.at(-1)[8], 1, 'curled');
  const tip = inst.captureInputMapper(/** @type {any} */ ({}))({ x: 301, y: 201, width: W, height: H });
  assert.ok(isNoTarget(tip));
  assert.deepEqual(inst.captureInputMapper(/** @type {any} */ ({}))({ x: 40, y: 40, width: W, height: H }), { x: 40, y: 40 }, 'the flat page still maps');
  const up = env.fire('pointerup', 300, 200);
  assert.ok(up.prevented && up.stopped);
  assert.deepEqual(env.captured, [1, -1]);
  const click = env.fire('click', 300, 200);
  assert.ok(click.stopped, 'the click that follows the grab is swallowed');
  const keyClick = env.fire('click', 300, 200, { detail: 0 });
  assert.equal(keyClick.stopped, false, 'keyboard / script clicks pass');
  const other = env.fire('pointermove', 300, 200, { pointerId: 2 });
  assert.equal(other.stopped, false);
  inst.destroy();
  assert.equal(env.docListeners.size, 0, 'destroy removes the document listeners');
});

test('the release animates back on the frame clock: the same pose at the same time whatever the frame cap, flat (identity) at the end', async (t) => {
  const poses = [];
  for (const fps of [120, 30, 15]) {
    const env = fakeEnv();
    const inst = await created(t, env);
    env.fire('pointerdown', 475, 315);
    env.fire('pointermove', 260, 180);
    inst.render(env.frame(1000));
    env.fire('pointerup', 260, 180);
    const before = env.renders();
    const at = [];
    for (let now = 1000; now <= 1000 + RELEASE_MS + 100; now += 1000 / fps) {
      inst.render(env.frame(now));
      if (Math.abs(now - 1200) < 0.01 || Math.abs(now - 1000) < 0.01) at.push(Array.from(env.writes.at(-1).slice(4, 9)));
    }
    assert.equal(env.writes.at(-1)[8], 0, 'flat again');
    assert.ok(env.renders() - before >= Math.floor((RELEASE_MS / 1000) * fps) - 1, 'the release asked for its frames');
    const settled = env.renders();
    inst.render(env.frame(5000));
    assert.equal(env.renders(), settled, 'no frame is requested once the page is flat');
    assert.deepEqual(inst.captureInputMapper(/** @type {any} */ ({}))({ x: 470, y: 310, width: W, height: H }), { x: 470, y: 310 });
    poses.push(at);
  }
  for (const p of poses.slice(1)) assert.deepEqual(p, poses[0]);
});

test('prefers-reduced-motion: the page lies flat at once on release and the hover lift does not animate', async (t) => {
  const env = fakeEnv({ reduced: true });
  const inst = await created(t, env);
  env.fire('pointermove', 470, 310);
  inst.render(env.frame(0));
  const lifted = env.renders();
  inst.render(env.frame(8));
  assert.equal(env.renders(), lifted, 'the hover lift is static: no frame requested after it');
  env.fire('pointerdown', 470, 310);
  env.fire('pointermove', 300, 200);
  inst.render(env.frame(0));
  assert.equal(env.writes.at(-1)[8], 1, 'a drag still peels (it follows the hand, it is not an animation)');
  env.fire('pointerup', 300, 200);
  const released = env.renders();
  inst.render(env.frame(16));
  assert.equal(env.writes.at(-1)[8], 0);
  assert.equal(env.renders(), released, 'no animation frames');
});

test('a mapper keeps the curl of its own frame after later frames (frozen slots, gesture snapshot copies)', async (t) => {
  const env = fakeEnv();
  const inst = await created(t, env);
  env.fire('pointerdown', 470, 310);
  env.fire('pointermove', 300, 200);
  inst.render(env.frame(0));
  const first = inst.captureInputMapper(/** @type {any} */ ({}));
  const gesture = first.captureGestureSnapshot();
  const p = { x: 330, y: 230, width: W, height: H };
  assert.ok(isNoTarget(first(p)));
  env.fire('pointerup', 300, 200);
  for (let k = 1; k <= 3; k += 1) { inst.render(env.frame(k * 500)); inst.captureInputMapper(/** @type {any} */ ({})); }
  assert.ok(isNoTarget(first(p)), 'three newer presentations did not change the first mapper');
  assert.ok(isNoTarget(gesture(p)));
  assert.deepEqual(inst.captureInputMapper(/** @type {any} */ ({}))(p), { x: 330, y: 230 }, 'the newest frame is flat');
});

test('the render path allocates nothing per frame: one uniform array, one pass descriptor', async (t) => {
  const env = fakeEnv();
  const inst = await created(t, env);
  env.fire('pointerdown', 470, 310);
  for (let k = 0; k < 20; k += 1) { env.fire('pointermove', 470 - k * 8, 310 - k * 5); inst.render(env.frame(k * 8)); }
  assert.equal(new Set(env.writes).size, 1);
  assert.equal(new Set(env.passes).size, 1);
});

test('the hover lift animates from the first frame after the hover, the same at every frame cap', async (t) => {
  const lifts = [];
  for (const fps of [120, 30]) {
    const env = fakeEnv();
    const inst = await created(t, env);
    inst.render(env.frame(0));                    // a frame long before the hover
    env.fire('pointermove', 470, 312);
    const out = [];
    for (let now = 5000; now <= 5400; now += 1000 / fps) {
      inst.render(env.frame(now));
      if ([5000, 5100, 5400].some((x) => Math.abs(now - x) < 0.01)) out.push(env.writes.at(-1)[8] ? Math.hypot(env.writes.at(-1)[4], env.writes.at(-1)[5]) && env.writes.at(-1)[7] : 0);
    }
    assert.equal(out[0], 0, 'no jump on the first frame');
    assert.ok(out[1] > 0 && out[2] > out[1], `the corner lifts over time: ${out}`);
    lifts.push(out);
  }
  assert.ok(Math.abs(lifts[0][2] - lifts[1][2]) < 0.05 * lifts[0][2], `settled lift at 120 and 30 fps: ${lifts}`);
});
