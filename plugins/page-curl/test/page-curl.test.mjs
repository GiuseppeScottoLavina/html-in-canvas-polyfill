// Node tests of the page-curl plugin: the folder contract; the fold (an isometry, the corner under the pointer, the bound edge flat); the
// mapper against an independent forward rendering of the sheet (every point of the sheet splatted through the camera into a z-buffer);
// the grab gesture (which events are taken from the page); the springs on the frame clock (the same pose at the same time whatever the
// frame cap); the rest pose (dog-ear, hover lift, auto-peek, grab cursor); reduced motion; and the render path (no allocation per frame).
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractTest } from '../../_shared/contract-test.mjs';
import { constrainCorner, foldFor, foldNormal, foldPoint, project } from '../fold.js';
import { NO_TARGET, PEEK_MS, UNIFORM_FLOATS, foldSpan, hintCorner, hintText, hotCorner, isNoTarget, mapCurlPoint, meta, parseColor, peekAt, plugin, poseState } from '../index.js';

const W = 480;
const H = 320;

contractTest(import.meta.url);

test('meta and the definition agree; the defaults are valid options', () => {
  assert.equal(plugin.type, meta.name);
  assert.equal(plugin.apiVersion, 2);
  assert.deepEqual(Object.keys(meta.defaults).sort(), ['autoPeek', 'corner', 'dogEar', 'radius', 'shadow']);
});

// ------------------------------------------------------------------------------------------------ the fold
const fold = (/** @type {number} */ x, /** @type {number} */ y, /** @type {'top'|'bottom'} */ lead = 'bottom', maxR = 48) => {
  const c = constrainCorner({ x, y }, lead, W, H, { x: 0, y: 0 });
  return { f: foldFor(c, lead, W, H, maxR, /** @type {any} */ ({})), c };
};
const poses = [[400, 300], [300, 280], [200, 250], [60, 320], [-150, 300], [250, 160], [420, 40]];

test('fold: the held corner lands exactly where it is held, for both leading corners', () => {
  for (const [x, y] of poses) {
    for (const lead of /** @type {const} */ (['bottom', 'top'])) {
      const { f, c } = fold(x, lead === 'top' ? H - y : y, lead);
      const out = [0, 0, 0];
      foldPoint(W, lead === 'bottom' ? H : 0, f, out);
      assert.ok(Math.hypot(out[0] - c.x, out[1] - c.y) < 1e-6, `${lead} corner at ${out} for ${c.x},${c.y}`);
    }
  }
});

test('fold: an isometry (lengths along the paper are kept) and the bound edge never lifts', () => {
  const length = (/** @type {any} */ f, /** @type {number[]} */ a, /** @type {number[]} */ b) => {
    let L = 0; const p = [0, 0, 0], q = [0, 0, 0];
    foldPoint(a[0], a[1], f, p);
    for (let i = 1; i <= 4000; i += 1) {
      const t = i / 4000;
      foldPoint(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, f, q);
      L += Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]); p[0] = q[0]; p[1] = q[1]; p[2] = q[2];
    }
    return L;
  };
  for (const [x, y] of poses) {
    const { f } = fold(x, y);
    for (const [a, b] of [[[0, H], [W, H]], [[W, 0], [W, H]], [[0, 0], [W, H]]]) {
      const want = Math.hypot(b[0] - a[0], b[1] - a[1]);
      assert.ok(Math.abs(length(f, a, b) - want) < 0.08, `edge ${a}-${b}: ${length(f, a, b)} vs ${want}`);
    }
  }
  for (let x = -600; x <= 500; x += 37) {
    for (let y = -200; y <= 600; y += 41) {
      const { f } = fold(x, y);
      const out = [0, 0, 0];
      for (const yy of [0, H / 2, H]) { foldPoint(0, yy, f, out); assert.ok(out[2] < 1e-9 && Math.abs(out[0]) < 1e-9, `the bound edge lifted at ${x},${y}`); }
    }
  }
  const n = [0, 0, 0];
  foldNormal(W - 2, H - 2, fold(100, H).f, n);
  assert.ok(n[2] < -0.99, 'the folded flap shows its other side');
});

// ------------------------------------------------------------------------------------------------ the mapper against a forward rendering
/**
 * Independent forward rendering (written from page-curl.wgsl's vertex stage, not from mapCurlPoint): every point of the sheet, 4 per css px
 * in each direction, is folded, projected and kept per pixel when it is the nearest to the eye. Returns, per pixel, which side is seen
 * (0 flat page, 1 front of the lifted sheet, 2 back) and the source point.
 * @param {Float32Array} st
 */
function splat(st) {
  const f = { nx: st[4], ny: st[5], ax: st[6], ay: st[7], R: st[8], L: st[9] };
  const m = st[10], D = st[11];
  const z = new Float32Array(W * H).fill(-1);
  const kind = new Int8Array(W * H).fill(-1);
  const sx = new Float32Array(W * H), sy = new Float32Array(W * H);
  const p = [0, 0, 0], n = [0, 0, 0], q = { x: 0, y: 0 };
  for (let ly = 0; ly <= H; ly += 0.25) {
    for (let lx = 0; lx <= W; lx += 0.25) {
      foldPoint(lx, ly, f, p);
      const X = m > 0 ? p[0] : W - p[0];
      project(X, p[1], p[2], W, H, D, q);
      const i = Math.floor(q.x), j = Math.floor(q.y);
      if (i < 0 || j < 0 || i >= W || j >= H) continue;
      const k = j * W + i;
      if (p[2] <= z[k]) continue;
      foldNormal(lx, ly, f, n);
      const facing = n[0] * m * (W / 2 - X) + n[1] * (H / 2 - p[1]) + n[2] * (D - p[2]);
      z[k] = p[2];
      kind[k] = p[2] < 1e-6 ? 0 : facing >= 0 ? 1 : 2;
      sx[k] = m > 0 ? lx : W - lx; sy[k] = ly;
    }
  }
  return { kind, sx, sy, z };
}

test('the mapper answers what the forward rendering shows: the page point on the flat page and on the front of the roll, NO_TARGET on the back and beneath (every pixel, 8 poses)', () => {
  const cases = [['br', 300, 200], ['br', 200, 250], ['br', 60, 300], ['tr', 260, 120], ['bl', 260, 150], ['tl', 120, 200], ['br', 455, 300], ['tr', 420, 40]];
  for (const [key, x, y] of /** @type {[any, number, number][]} */ (cases)) {
    const st = foldSpan(poseState(new Float32Array(UNIFORM_FLOATS), W, H, key, x, y, 48), W, H);
    const { kind, sx, sy, z } = splat(st);
    const f = { nx: st[4], ny: st[5], ax: st[6], ay: st[7], R: st[8], L: st[9] }, m = st[10];
    const p = [0, 0, 0], q = { x: 0, y: 0 };
    const counts = { flat: 0, front: 0, back: 0, under: 0, skipped: 0 };
    for (let j = 1; j < H - 1; j += 1) {
      for (let i = 1; i < W - 1; i += 1) {
        const k = j * W + i;
        // pixels next to a change of layer are ambiguous at the resolution of the splat
        let mixed = false;
        for (let dj = -1; dj <= 1 && !mixed; dj += 1) for (let di = -1; di <= 1; di += 1) if (kind[k + dj * W + di] !== kind[k]) { mixed = true; break; }
        if (mixed) { counts.skipped += 1; continue; }
        const got = mapCurlPoint(st, { x: i + 0.5, y: j + 0.5, width: W, height: H });
        if (kind[k] === -1) { counts.under += 1; assert.ok(isNoTarget(got), `${key} ${x},${y}: ${i},${j} lies beneath the sheet`); }
        else if (kind[k] === 2) { counts.back += 1; assert.ok(isNoTarget(got), `${key} ${x},${y}: ${i},${j} shows the back`); }
        else {
          if (kind[k] === 0) counts.flat += 1; else counts.front += 1;
          assert.ok(!isNoTarget(got), `${key} ${x},${y}: ${i},${j} shows the page, the mapper says no target`);
          if (kind[k] === 0) assert.ok(Math.hypot(got.x - sx[k], got.y - sy[k]) < 0.75, `${key} ${x},${y}: ${i},${j} shows ${sx[k]},${sy[k]}, mapped to ${JSON.stringify(got)}`);
          else {
            // on the roll a pixel spans several source px (the paper is seen at a slant): the mapped point must be drawn at this pixel,
            // at the height of the nearest layer there (near its silhouette the roll is seen edge-on: its height varies by several px across one pixel)
            const lx = m > 0 ? got.x : W - got.x;
            foldPoint(lx, got.y, f, p);
            project(m > 0 ? p[0] : W - p[0], p[1], p[2], W, H, st[11], q);
            assert.ok(Math.hypot(q.x - (i + 0.5), q.y - (j + 0.5)) < 1 && p[2] > z[k] - 8, `${key} ${x},${y}: ${i},${j} maps to ${JSON.stringify(got)}, drawn at ${q.x},${q.y} height ${p[2]} (top ${z[k]})`);
          }
        }
      }
    }
    assert.ok(counts.back > 20 && counts.flat > 10000, `${key} ${x},${y}: ${JSON.stringify(counts)}`);
  }
});

test('released (no pull): the mapper is the identity everywhere, including the hot zones; it scales from the presented size', () => {
  const st = poseState(new Float32Array(UNIFORM_FLOATS), W, H, 'br', W, H, 48);
  assert.equal(st[9], 0);
  for (const [x, y] of [[0, 0], [W, H], [W - 3, H - 3], [240, 160]]) assert.deepEqual(mapCurlPoint(st, { x, y, width: W, height: H }), { x, y });
  const curled = poseState(new Float32Array(UNIFORM_FLOATS), W, H, 'br', 300, 200, 48);
  assert.deepEqual(mapCurlPoint(curled, { x: 200, y: 200, width: 2 * W, height: 2 * H }), { x: 200, y: 200 });
  assert.ok(isNoTarget(mapCurlPoint(curled, { x: 2 * 470, y: 2 * 310, width: 2 * W, height: 2 * H })));
  assert.ok(Number.isFinite(NO_TARGET.x) && Number.isFinite(NO_TARGET.y), 'the host requires finite points');
});

test('hot zones: corners only, `corner` restricts them, points off the page never grab; colours parse', () => {
  assert.equal(hotCorner(470, 310, W, H, 'any', 64), 'br');
  assert.equal(hotCorner(10, 10, W, H, 'any', 64), 'tl');
  assert.equal(hotCorner(10, 10, W, H, 'br', 64), null);
  assert.equal(hotCorner(240, 160, W, H, 'any', 64), null);
  assert.equal(hotCorner(W + 1, H, W, H, 'any', 64), null);
  assert.deepEqual(parseColor('#ff0000'), [1, 0, 0]);
  assert.deepEqual(parseColor('#fff'), [1, 1, 1]);
  assert.deepEqual(parseColor('nope', [0.5, 0.5, 0.5]), [0.5, 0.5, 0.5]);
});

// ------------------------------------------------------------------------------------------------ the instance, with a recording fake GPU
/** options without the rest-pose hints: the page lies flat at rest */
const FLAT = { ...meta.defaults, dogEar: 0, autoPeek: 0 };

function fakeEnv({ reduced = false, timers = false } = {}) {
  Object.assign(globalThis, {
    GPUBufferUsage: { UNIFORM: 1, COPY_DST: 2, VERTEX: 4, INDEX: 8 },
    GPUShaderStage: { VERTEX: 1, FRAGMENT: 2 },
    GPUTextureUsage: { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2 },
  });
  /** @type {any[]} */ const writes = [];
  /** @type {any[]} */ const passes = [];
  let draws = 0;
  const device = {
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}), createRenderPipeline: () => ({}),
    createBuffer: () => ({ destroy() {} }), createSampler: () => ({}), createBindGroup: () => ({}),
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    queue: { writeBuffer: (/** @type {any} */ _b, /** @type {any} */ _o, /** @type {any} */ d) => writes.push(d) },
  };
  const encoder = { beginRenderPass: (/** @type {any} */ d) => { passes.push(d); return { setPipeline() {}, setBindGroup() {}, draw() { draws += 1; }, end() {} }; } };
  const docListeners = new Map();
  /** @type {{fn: any, ms: number}[]} */ const pending = [];
  /** @type {any} */ const view = { matchMedia: () => ({ matches: reduced }) };
  if (timers) Object.assign(view, { setTimeout: (/** @type {any} */ fn, /** @type {number} */ ms) => { pending.push({ fn, ms }); return pending.length; }, clearTimeout: (/** @type {number} */ id) => { if (pending[id - 1]) pending[id - 1].fn = null; } });
  const doc = {
    defaultView: view,
    addEventListener: (/** @type {string} */ type, /** @type {any} */ fn, /** @type {boolean} */ capture) => { assert.equal(capture, true); docListeners.set(type, fn); },
    removeEventListener: (/** @type {string} */ type, /** @type {any} */ fn) => { if (docListeners.get(type) === fn) docListeners.delete(type); },
  };
  /** @type {any[]} */ const captured = [];
  const canvas = {
    ownerDocument: doc, clientWidth: W, clientHeight: H,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: W, height: H }),
    setPointerCapture: (/** @type {number} */ id) => captured.push(id), releasePointerCapture: (/** @type {number} */ id) => captured.push(-id),
  };
  let renders = 0;
  const layerListeners = new Map();
  const attrs = new Map();
  const layer = { setAttribute: (/** @type {string} */ k, /** @type {string} */ v) => attrs.set(k, v), removeAttribute: (/** @type {string} */ k) => attrs.delete(k),
    setPointerCapture: (/** @type {number} */ id) => captured.push(`layer${id}`), releasePointerCapture: (/** @type {number} */ id) => captured.push(`layer-${id}`) };
  const context = { device, format: 'bgra8unorm', canvas, source: {}, requestRender() { renders += 1; }, listen: (/** @type {string} */ type, /** @type {any} */ fn) => { layerListeners.set(type, fn); return () => {}; } };
  const fire = (/** @type {string} */ type, /** @type {number} */ x, /** @type {number} */ y, o = {}) => {
    const e = {
      type, pointerId: 1, isPrimary: true, button: 0, detail: 1, clientX: 10 + x, clientY: 20 + y, prevented: false, stopped: false,
      composedPath: () => [canvas], preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...o,
    };
    docListeners.get(type)?.(e);
    return e;
  };
  const frame = (/** @type {number} */ now) => ({ now, width: W, height: H, cssWidth: W, cssHeight: H, sourceReady: true, sourceView: {}, destinationView: {}, encoder });
  const atLayer = (/** @type {string} */ type) => layerListeners.get(type)?.({ type, currentTarget: layer });
  return { context, writes, passes, docListeners, fire, frame, captured, renders: () => renders, draws: () => draws, pending, atLayer, attrs };
}

/** @param {any} t @param {any} env @param {Record<string, unknown>} [options] */
async function created(t, env, options = meta.defaults) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async () => ({ ok: true, text: async () => '// wgsl' })); // source mode loads the .wgsl files; Node has no server
  t.after(() => { globalThis.fetch = realFetch; });
  return /** @type {any} */ (await plugin.create(/** @type {any} */ (env.context), options));
}
/** the written uniform block of the last frame */
const last = (/** @type {any} */ env) => /** @type {Float32Array} */ (env.writes.filter((/** @type {any} */ w) => w.length === UNIFORM_FLOATS).at(-1));
/** where the held corner of a written state lies (page css px) */
const cornerOf = (/** @type {Float32Array} */ s) => { const lx = s[2] - s[4] * s[9], ly = s[3] - s[5] * s[9]; return [s[10] > 0 ? lx : s[2] - lx, ly]; };

test('the grab is the plugin\'s gesture: down/move/up/click are taken from the page, the pointer is captured; elsewhere nothing is taken', async (t) => {
  const env = fakeEnv();
  const inst = await created(t, env, FLAT);
  const miss = env.fire('pointerdown', 240, 160);
  assert.equal(miss.prevented || miss.stopped, false, 'a press away from the corners belongs to the form');
  const down = env.fire('pointerdown', 470, 312);
  assert.ok(down.prevented && down.stopped, 'the grab never reaches the interposer or the form');
  assert.deepEqual(env.captured, [1]);
  const move = env.fire('pointermove', 300, 200);
  assert.ok(move.prevented && move.stopped);
  for (let now = 0; now <= 1000; now += 16) inst.render(env.frame(now));
  assert.ok(last(env)[9] > 100, 'curled');
  const m = inst.captureInputMapper({});
  assert.ok(isNoTarget(m({ x: 302, y: 202, width: W, height: H })), 'the corner under the pointer is the back of the sheet');
  assert.deepEqual(m({ x: 40, y: 40, width: W, height: H }), { x: 40, y: 40 }, 'the flat page still maps');
  const up = env.fire('pointerup', 300, 200);
  assert.ok(up.prevented && up.stopped);
  assert.deepEqual(env.captured, [1, -1]);
  assert.ok(env.fire('click', 300, 200).stopped, 'the click that follows the grab is swallowed');
  assert.equal(env.fire('click', 300, 200, { detail: 0 }).stopped, false, 'keyboard / script clicks pass');
  assert.equal(env.fire('pointermove', 300, 200, { pointerId: 2 }).stopped, false);
  inst.destroy();
  assert.equal(env.docListeners.size, 0, 'destroy removes the document listeners');
});

test('the corner follows the pointer on a spring (weight, no jump) and settles exactly under it, seen through the camera', async (t) => {
  const env = fakeEnv();
  const inst = await created(t, env, FLAT);
  env.fire('pointerdown', 475, 315);
  env.fire('pointermove', 200, 150);
  inst.render(env.frame(0));
  inst.render(env.frame(16));
  const early = cornerOf(last(env));
  assert.ok(early[0] > 380, `16 ms after the move the corner has only started to follow: ${early}`);
  for (let now = 32; now <= 1500; now += 16) inst.render(env.frame(now));
  const s = last(env);
  const [cx, cy] = cornerOf(s);
  const q = project(cx, cy, 2 * s[8], W, H, s[11], { x: 0, y: 0 });
  assert.ok(Math.hypot(q.x - 200, q.y - 150) < 0.5, `settled: the corner is seen at ${q.x}, ${q.y}`);
});

test('the release springs back on the frame clock: the same pose at the same time whatever the frame cap, flat (identity) at the end', async (t) => {
  /** @type {number[][][]} */ const poses = [];
  for (const fps of [120, 30, 15]) {
    const env = fakeEnv();
    const inst = await created(t, env, FLAT);
    env.fire('pointerdown', 475, 315);
    env.fire('pointermove', 260, 180);
    for (let now = 0; now <= 1000; now += 20) inst.render(env.frame(now));
    env.fire('pointerup', 260, 180);
    const before = env.renders();
    /** @type {number[][]} */ const at = [];
    for (let k = 0; ; k += 1) {
      const now = 1000 + (k * 1000) / fps;
      if (now > 3000) break;
      inst.render(env.frame(now));
      if ([1000, 1200, 1400].some((x) => Math.abs(now - x) < 1e-6)) at.push(Array.from(last(env).slice(4, 10)));
    }
    assert.equal(last(env)[9], 0, 'flat again');
    assert.ok(env.renders() - before >= 0.25 * fps, 'the release asked for its frames');
    const settled = env.renders();
    inst.render(env.frame(5000));
    assert.equal(env.renders(), settled, 'no frame is requested once the page is flat');
    assert.deepEqual(inst.captureInputMapper({})({ x: 470, y: 310, width: W, height: H }), { x: 470, y: 310 });
    poses.push(at);
  }
  for (const p of poses.slice(1)) p.forEach((pose, i) => pose.forEach((v, j) => assert.ok(Math.abs(v - poses[0][i][j]) < 1e-3, `pose ${i}: ${pose} vs ${poses[0][i]}`)));
});

test('prefers-reduced-motion: the drag follows the hand at once; the page lies flat at once on release; the hover lift is static', async (t) => {
  const env = fakeEnv({ reduced: true });
  const inst = await created(t, env, FLAT);
  env.fire('pointermove', 470, 310);
  inst.render(env.frame(0));
  const lifted = env.renders();
  inst.render(env.frame(8));
  assert.equal(env.renders(), lifted, 'the hover lift is static: no frame requested after it');
  env.fire('pointerdown', 470, 310);
  env.fire('pointermove', 300, 200);
  inst.render(env.frame(16));
  assert.ok(last(env)[9] > 100, 'a drag still curls (it follows the hand, it is not an animation)');
  env.fire('pointerup', 300, 200);
  const released = env.renders();
  inst.render(env.frame(32));
  assert.equal(last(env)[9], 0);
  assert.equal(env.renders(), released, 'no animation frames');
});

test('a mapper keeps the curl of its own frame after later frames (frozen slots, gesture snapshot copies)', async (t) => {
  const env = fakeEnv();
  const inst = await created(t, env, FLAT);
  env.fire('pointerdown', 470, 310);
  env.fire('pointermove', 300, 200);
  for (let now = 0; now <= 800; now += 16) inst.render(env.frame(now));
  const first = inst.captureInputMapper({});
  const gesture = first.captureGestureSnapshot();
  const p = { x: 330, y: 230, width: W, height: H };
  assert.ok(isNoTarget(first(p)));
  env.fire('pointerup', 300, 200);
  for (let k = 1; k <= 3; k += 1) { inst.render(env.frame(800 + k * 1000)); inst.captureInputMapper({}); }
  assert.ok(isNoTarget(first(p)), 'three newer presentations did not change the first mapper');
  assert.ok(isNoTarget(gesture(p)));
  assert.deepEqual(inst.captureInputMapper({})(p), { x: 330, y: 230 }, 'the newest frame is flat');
});

test('the render path allocates nothing per frame: one uniform array, the same pass descriptors; the shadow passes run only when the fold moved', async (t) => {
  const env = fakeEnv();
  const inst = await created(t, env);
  inst.render(env.frame(0));
  const writes0 = env.writes.length;
  env.fire('pointerdown', 470, 310);
  for (let k = 1; k <= 20; k += 1) { env.fire('pointermove', 470 - k * 8, 310 - k * 5); inst.render(env.frame(k * 8)); }
  assert.equal(new Set(env.writes.slice(writes0)).size, 1);
  assert.ok(new Set(env.passes).size <= 2, 'the shadow pass and the main pass reuse their descriptors');
  const passes = env.passes.length;
  inst.render(env.frame(1000)); inst.render(env.frame(1000));   // the same time twice: the fold did not move
  assert.equal(env.passes.length - passes, (1 + 6 + 1) + 1, 'the first frame: shadow, 6 blurs, main; the second frame at the same pose: the main pass only');
});

// ------------------------------------------------------------------------------------------------ the rest pose: dog-ear, hover, auto-peek
test('the hint: top-right unless one corner is allowed; the label names it; the peek schedule', () => {
  assert.equal(hintCorner('any'), 'tr');
  assert.equal(hintCorner('bl'), 'bl');
  assert.match(hintText('any'), /Drag the top-right corner to turn the page \(any corner works\)/);
  assert.match(hintText('br'), /Drag the bottom-right corner/);
  assert.equal(peekAt(0, 5), 0);
  assert.equal(peekAt(1500 + PEEK_MS / 2, 5), 1, 'half way through the first peek the dog-ear is fully open');
  assert.equal(peekAt(1500 + PEEK_MS + 10, 5), 0);
  assert.ok(peekAt(1500 + 5000 + PEEK_MS / 2, 5) > 0.99, 'the next peek, 5 s later');
  assert.equal(peekAt(1500 + PEEK_MS / 2, 0), 0, 'autoPeek 0: never');
});

test('at rest the top-right corner is a dog-ear: curled from the first frame, no frame requested, NO_TARGET on the dog-ear only', async (t) => {
  const env = fakeEnv();
  const inst = await created(t, env, { ...meta.defaults, autoPeek: 0 });
  inst.render(env.frame(0));
  const u = last(env);
  assert.ok(u[9] > 0, 'curled at rest');
  assert.equal(u[10], 1, 'a right-hand corner: the sheet is bound on the left');
  assert.ok(u[4] > 0 && u[5] < 0, `the fold points to the top-right corner: ${u[4]}, ${u[5]}`);
  const r0 = env.renders();
  inst.render(env.frame(16));
  assert.equal(env.renders(), r0, 'static: no frame requested');
  const m = inst.captureInputMapper({});
  assert.ok(isNoTarget(m({ x: W - 4, y: 4, width: W, height: H })), 'the dog-ear itself is not the page');
  for (const [x, y] of [[3, 3], [W - 3, H - 3], [3, H - 3], [W - 90, 90], [240, 160]]) assert.deepEqual(m({ x, y, width: W, height: H }), { x, y });
});

test('hovering a hot zone lifts its corner further and shows the grab cursor on the layer; dragging shows grabbing; leaving restores', async (t) => {
  const env = fakeEnv();
  const inst = await created(t, env, { ...meta.defaults, autoPeek: 0 });
  env.atLayer('pointerover');
  inst.render(env.frame(0));
  const rest = last(env)[9];
  env.fire('pointermove', W - 10, 10);
  env.atLayer('pointermove');
  assert.equal(env.attrs.get('data-hic-curl-cursor'), 'grab');
  for (let now = 1000; now <= 1800; now += 8) inst.render(env.frame(now));
  assert.ok(last(env)[9] > rest * 1.5, `the corner lifts further: ${rest} -> ${last(env)[9]}`);
  env.fire('pointerdown', W - 10, 10);
  assert.equal(env.attrs.get('data-hic-curl-cursor'), 'grabbing');
  assert.deepEqual(env.captured, ['layer1'], 'the pointer is captured to the layer');
  env.fire('pointerup', 300, 200);
  assert.equal(env.attrs.has('data-hic-curl-cursor'), false);
  env.fire('pointermove', 240, 160);
  assert.equal(env.attrs.has('data-hic-curl-cursor'), false, 'off the hot zones: no grab cursor');
  inst.destroy();
});

test('the release of the dog-eared corner ends on the dog-ear; another corner ends flat and the dog-ear comes back', async (t) => {
  const env = fakeEnv();
  const inst = await created(t, env, { ...meta.defaults, autoPeek: 0 });
  inst.render(env.frame(0));
  const rest = Array.from(last(env).slice(4, 10));
  env.fire('pointerdown', W - 4, 4);
  env.fire('pointermove', 200, 200);
  for (let now = 16; now <= 600; now += 16) inst.render(env.frame(now));
  env.fire('pointerup', 200, 200);
  for (let now = 616; now <= 3000; now += 8) inst.render(env.frame(now));
  const after = Array.from(last(env).slice(4, 10));
  after.forEach((v, i) => assert.ok(Math.abs(v - rest[i]) < 1e-3, `back on the dog-ear: ${after} vs ${rest}`));
  env.fire('pointerdown', 4, H - 4);
  env.fire('pointermove', 200, 100);
  for (let now = 3016; now <= 3600; now += 16) inst.render(env.frame(now));
  assert.equal(last(env)[10], -1, 'a left-hand corner: the sheet is bound on the right');
  env.fire('pointerup', 200, 100);
  for (let now = 3616; now <= 8000; now += 8) inst.render(env.frame(now));
  const back = Array.from(last(env).slice(4, 10));
  back.forEach((v, i) => assert.ok(Math.abs(v - rest[i]) < 1e-3, `the dog-ear is back on the top-right corner: ${back} vs ${rest}`));
});

test('auto-peek: until the first drag the dog-ear opens now and then on its own (a timer wakes the host); the first drag ends it', async (t) => {
  const env = fakeEnv({ timers: true });
  const inst = await created(t, env, { ...meta.defaults, autoPeek: 5 });
  inst.render(env.frame(0));
  const rest = last(env)[9];
  assert.equal(env.pending.length, 1, 'at rest a timer is set for the first peek');
  assert.equal(env.pending[0].ms, 1500);
  const r0 = env.renders();
  env.pending[0].fn();
  assert.equal(env.renders(), r0 + 1, 'the timer asks for a frame');
  let max = 0;
  for (let now = 1500; now <= 1500 + PEEK_MS + 900; now += 16) { inst.render(env.frame(now)); max = Math.max(max, last(env)[9]); }
  assert.ok(max > rest * 2, `the dog-ear peeks open: pull ${rest} -> ${max}`);
  assert.ok(env.renders() - r0 > PEEK_MS / 16 - 5, 'frames are requested while it peeks');
  assert.ok(Math.abs(last(env)[9] - rest) < 0.05, 'and it closes again');
  assert.ok(env.pending.at(-1)?.fn && /** @type {any} */ (env.pending.at(-1)).ms > 1000, 'the next peek is scheduled');
  env.fire('pointerdown', W - 4, 4);
  env.fire('pointermove', 300, 100);
  inst.render(env.frame(4300));
  env.fire('pointerup', 300, 100);
  for (let now = 4316; now <= 20000; now += 16) inst.render(env.frame(now));
  assert.ok(env.pending.slice(1).every((p) => p.fn === null), 'after the first drag no peek is pending');
  assert.ok(Math.abs(last(env)[9] - rest) < 0.05, 'and the dog-ear stays still');
  const reduced = fakeEnv({ reduced: true, timers: true });
  const still = await created(t, reduced, { ...meta.defaults, autoPeek: 5 });
  for (let now = 0; now <= 5000; now += 16) still.render(reduced.frame(now));
  assert.equal(reduced.pending.length, 0, 'reduced motion: no auto-peek');
  assert.ok(last(reduced)[9] > 0, 'reduced motion: the dog-ear is still there');
});
