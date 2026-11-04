// Node tests of the glitch plugin: the folder contract, the block generator (keep-out included), the mapper against an independent port
// of the shader's block loop, the frame function (bursts, the demo script, ambient events, typing hold, reduced motion, the same picture at
// every frame cap, and the time it returns: the picture does not change before it), the triggers, the actions 'burst' and 'demo' through
// the effect handle (plugins/_shared/node-host.mjs), the frames the instance asks for, and the render path (no allocation per frame).
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractTest } from '../../_shared/contract-test.mjs';
import {
  ACTIONS, AMBIENT_CYCLE_MS, AMBIENT_SPLIT, BURST_MS, DEMO_SCRIPT, HEADER_FLOATS, KIND, MAX_BLOCKS, PATTERN_MS, STYLE, TYPING_HOLD_MS, UNIFORM_FLOATS,
  ambientEvent, fillBlocks, fillGlitchFrame, hash01, mapGlitchPoint, meta, plugin, scriptLength,
} from '../index.js';
import { nodeHandle } from '../../_shared/node-host.mjs';

const W = 480;
const H = 320;

contractTest(import.meta.url);

test('meta and the definition agree', () => {
  assert.equal(plugin.type, meta.name);
  assert.equal(plugin.apiVersion, 2);
  assert.deepEqual(meta.defaults, { mode: 'ambient', intensity: 0.35 });
  assert.deepEqual([...plugin.actions], ['burst', 'demo']);
});

const ALL = STYLE.SHIFT | STYLE.SORT | STYLE.MACRO | STYLE.BAND;
const KINDS = Object.values(KIND);

test('the hash is deterministic and spreads over [0, 1)', () => {
  assert.equal(hash01(3, 4), hash01(3, 4));
  const v = Array.from({ length: 4000 }, (_, i) => hash01(7, i));
  assert.ok(v.every((x) => x >= 0 && x < 1));
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  assert.ok(Math.abs(mean - 0.5) < 0.03, `mean ${mean}`);
});

test('blocks: whole pixels, inside the page, at most MAX_BLOCKS, reproducible, different per pattern', () => {
  for (const level of [0.1, 0.5, 1]) {
    for (let pattern = 0; pattern < 30; pattern += 1) {
      const a = new Float32Array(UNIFORM_FLOATS);
      const n = fillBlocks(a, W, H, level, 9, pattern, ALL);
      assert.ok(n >= 3 && n <= MAX_BLOCKS, `${n} blocks`);
      for (let i = 0; i < n; i += 1) {
        const b = Array.from(a.slice(HEADER_FLOATS + i * 8, HEADER_FLOATS + i * 8 + 8));
        assert.ok(b.every((v, j) => j === 6 || Number.isInteger(v)), `whole pixels: ${b}`);
        assert.ok(b[0] >= 0 && b[1] >= 0 && b[2] <= W && b[3] <= H && b[2] > b[0] && b[3] > b[1], `inside: ${b}`);
        assert.ok(KINDS.includes(b[6]), `kind ${b[6]}`);
      }
      const again = new Float32Array(UNIFORM_FLOATS);
      fillBlocks(again, W, H, level, 9, pattern, ALL);
      assert.deepEqual(again, a);
    }
  }
  const p0 = new Float32Array(UNIFORM_FLOATS);
  const p1 = new Float32Array(UNIFORM_FLOATS);
  fillBlocks(p0, W, H, 1, 9, 0, ALL);
  fillBlocks(p1, W, H, 1, 9, 1, ALL);
  assert.notDeepEqual(p0, p1);
  assert.equal(fillBlocks(p0, W, H, 0, 9, 0, ALL), 0, 'level 0: no block');
  const noSort = new Float32Array(UNIFORM_FLOATS);
  const n = fillBlocks(noSort, W, H, 1, 9, 0, STYLE.SHIFT | STYLE.BAND);
  for (let i = 0; i < n; i += 1) assert.ok(noSort[HEADER_FLOATS + i * 8 + 6] < 0.5, 'no colour layer asked for: only blocks that move');
  const kinds = new Set();
  for (let pattern = 0; pattern < 40; pattern += 1) {
    const a = new Float32Array(UNIFORM_FLOATS);
    const m = fillBlocks(a, W, H, 1, 4, pattern, ALL);
    for (let i = 0; i < m; i += 1) kinds.add(a[HEADER_FLOATS + i * 8 + 6]);
  }
  assert.deepEqual([...kinds].sort(), [...KINDS].sort(), 'every kind of block occurs');
});

test('keep-out: no block meets the rectangle, and the others are the same blocks as without it', () => {
  const keep = [150, 100, 330, 160];
  let dropped = 0;
  for (let pattern = 0; pattern < 30; pattern += 1) {
    const free = new Float32Array(UNIFORM_FLOATS);
    const kept = new Float32Array(UNIFORM_FLOATS);
    const n = fillBlocks(free, W, H, 0.8, 5, pattern, ALL);
    const m = fillBlocks(kept, W, H, 0.8, 5, pattern, ALL, keep);
    const rects = (u, c) => Array.from({ length: c }, (_, i) => Array.from(u.slice(HEADER_FLOATS + i * 8, HEADER_FLOATS + i * 8 + 8)).join());
    const meets = (r) => { const [x0, y0, x1, y1] = r.split(',').map(Number); return x0 < keep[2] && x1 > keep[0] && y0 < keep[3] && y1 > keep[1]; };
    assert.deepEqual(rects(kept, m), rects(free, n).filter((r) => !meets(r)));
    dropped += n - m;
  }
  assert.ok(dropped > 30, `the keep-out removed ${dropped} blocks: it was really in the way`);
});

/**
 * Independent port of glitch.wgsl (written from the shader): instance 0 draws the page, instance i block i - 1 on top, so the last block
 * whose rectangle covers the point decides; a shift block samples the page at the wrapped, shifted point, a sort streak at the point.
 */
function shaderSource(u, x, y) {
  let shown = null;
  const n = Math.min(32, Math.trunc(u[8]));
  for (let i = 0; i < n; i += 1) {
    const [x0, y0, x1, y1] = u.slice(12 + 8 * i, 12 + 8 * i + 4);
    if (x >= x0 && y >= y0 && x < x1 && y < y1) shown = u.slice(12 + 8 * i + 4, 12 + 8 * i + 8);
  }
  if (!shown || shown[2] >= 0.5) return { x, y };
  const qx = x - shown[0], qy = y - shown[1];
  return { x: qx - Math.floor(qx / u[2]) * u[2], y: qy - Math.floor(qy / u[3]) * u[3] };
}

/** @param {Partial<import('../index.js').GlitchFrameParams>} o */
const params = (o) => ({
  width: W, height: H, cssWidth: W, cssHeight: H, now: 0, ready: true, mode: 'ambient', intensity: 0.35, seed: 1,
  burstAt: -1, burstSerial: 1, reduced: false, split: true, sort: true, noise: true, ...o,
});

test('the mapper is the shader\'s layering: identity outside the displaced blocks, the wrapped inverse offset of the top block inside (every pixel, 12 frames)', () => {
  let moved = 0;
  for (let k = 0; k < 12; k += 1) {
    const u = new Float32Array(UNIFORM_FLOATS);
    fillGlitchFrame(u, params({ now: 1000 + k * PATTERN_MS, burstAt: 1000, intensity: 1 }));
    for (let y = 0.5; y < H; y += 1) {
      for (let x = 0.5; x < W; x += 1) {
        const m = mapGlitchPoint(u, { x, y, width: W, height: H });
        const s = shaderSource(u, x, y);
        assert.ok(m.x === s.x && m.y === s.y, `${x},${y}: ${JSON.stringify(m)} vs ${JSON.stringify(s)}`);
        if (m.x !== x || m.y !== y) moved += 1;
      }
    }
  }
  assert.ok(moved > 20000, `${moved} displaced pixels`);
});

test('the mapper scales between the presented size and the page size of its frame', () => {
  const u = new Float32Array(UNIFORM_FLOATS);
  fillGlitchFrame(u, params({ now: 0, burstAt: 0, intensity: 1 }));
  for (let i = 0; i < 200; i += 1) {
    const x = (i * 37) % W + 0.5;
    const y = (i * 53) % H + 0.5;
    const a = mapGlitchPoint(u, { x, y, width: W, height: H });
    const b = mapGlitchPoint(u, { x: 2 * x, y: 2 * y, width: 2 * W, height: 2 * H });
    assert.ok(Math.abs(b.x - 2 * a.x) < 1e-9 && Math.abs(b.y - 2 * a.y) < 1e-9);
  }
});

test('a burst: blocks for BURST_MS, a clean pattern every fifth, the envelope fades, then nothing moves', () => {
  const u = new Float32Array(UNIFORM_FLOATS);
  const counts = [];
  for (let e = 0; e < BURST_MS; e += PATTERN_MS) { fillGlitchFrame(u, params({ mode: 'burst', now: 5000 + e, burstAt: 5000 })); counts.push(u[8]); }
  assert.equal(counts[3], 0);
  assert.equal(counts[8], 0);
  assert.ok(counts.filter((c) => c > 0).length >= 8);
  assert.equal(fillGlitchFrame(u, params({ mode: 'burst', now: 5000 + BURST_MS, burstAt: 5000 })), Infinity, 'burst mode is still once the burst ended: no next change');
  assert.equal(u[8], 0);
  assert.equal(u[5], 0, 'no split in burst mode at rest');
});

test('ambient: a still damaged signal, an event once per cycle (slices, a tracking band or a chroma jolt), identity between events', () => {
  const u = new Float32Array(UNIFORM_FLOATS);
  let glitched = 0, frames = 0, still = null;
  const styles = new Set();
  for (let now = 0; now < 20 * AMBIENT_CYCLE_MS; now += 1000 / 120) {
    const next = fillGlitchFrame(u, params({ now }));
    assert.ok(next > 0 && Number.isFinite(next), 'ambient always has a next change');
    assert.ok(u[5] >= 0.8 && u[7] >= 0.13, `split ${u[5]} px, scanlines ${u[7]}`);
    frames += 1;
    const cycle = Math.floor(now / AMBIENT_CYCLE_MS);
    const ev = ambientEvent(1, cycle);
    const inEvent = now >= ev.start && now < ev.start + ev.length;
    if (inEvent) { glitched += 1; styles.add(ev.draw < 0.45 ? 'slices' : ev.draw < 0.8 ? 'band' : 'jolt'); }
    else {
      assert.equal(u[8], 0, 'no block between events');
      if (still) assert.deepEqual(Array.from(u), still, 'between events the picture is the same still frame');
      still = Array.from(u);
    }
  }
  const share = glitched / frames;
  assert.ok(share > 0.05 && share < 0.2, `events ${(share * 100).toFixed(1)}% of the time`);
  assert.deepEqual([...styles].sort(), ['band', 'jolt', 'slices']);
});

/** frames a host asks for in `ms` when it renders at `fps` only at the instants fillGlitchFrame returns (as the plugin does) */
function framesAsked(o, ms, fps = 120) {
  const u = new Float32Array(UNIFORM_FLOATS);
  const vsync = 1000 / fps;
  let frames = 0;
  for (let now = o.now ?? 0; now < (o.now ?? 0) + ms;) {
    const next = fillGlitchFrame(u, params({ ...o, now }));
    frames += 1;
    if (!Number.isFinite(next)) break;
    now = Math.ceil((now + Math.max(next, 0.001)) / vsync) * vsync;   // the first vsync at or after the change
  }
  return frames;
}

test('the time it returns is honest: the picture does not change before it, and it does change at it (bursts, the demo, ambient)', () => {
  let changes = 0, checks = 0;
  const cases = [
    { mode: 'burst', burstAt: 1000 }, { mode: 'ambient', burstAt: 1000, intensity: 1 }, { mode: 'ambient' }, { mode: 'ambient', intensity: 1 },
    { mode: 'burst', burstAt: 1000, script: DEMO_SCRIPT }, { mode: 'ambient', reduced: true, burstAt: 1000 },
  ];
  for (const o of cases) {
    for (let now = 900; now < 4500; now += 7.3) {
      const u = new Float32Array(UNIFORM_FLOATS);
      const next = fillGlitchFrame(u, params({ ...o, now }));
      if (!Number.isFinite(next) || next < 0.5) continue;
      for (const f of [0.3, 0.7, 0.98]) {
        const v = new Float32Array(UNIFORM_FLOATS);
        fillGlitchFrame(v, params({ ...o, now: now + f * next }));
        assert.deepEqual(v, u, `${JSON.stringify(o)} at ${now}: changed before ${next.toFixed(1)} ms`);
        checks += 1;
      }
      const w = new Float32Array(UNIFORM_FLOATS);
      fillGlitchFrame(w, params({ ...o, now: now + next + 0.01 }));
      if (w.some((x, i) => x !== u[i])) changes += 1;
    }
  }
  assert.ok(checks > 1000 && changes > 300, `${checks} checks, ${changes} changes at the returned time`);
});

test('frames asked for: ambient only while an event plays (a few per second), a burst at its pattern and grain steps, nothing at rest', () => {
  const ambient = framesAsked({ mode: 'ambient' }, 14000) / 14;
  assert.ok(ambient > 1 && ambient < 12, `ambient: ${ambient.toFixed(1)} frames per second at 120 Hz (it rendered every vsync before: 120)`);
  const burst = framesAsked({ mode: 'burst', now: 1000, burstAt: 1000 }, BURST_MS);
  assert.ok(burst >= BURST_MS / PATTERN_MS && burst <= 2.5 * (BURST_MS / PATTERN_MS) + 2, `a burst: ${burst} frames (patterns ${Math.ceil(BURST_MS / PATTERN_MS)})`);
  assert.equal(framesAsked({ mode: 'burst', now: 1000 }, 5000), 1, 'burst mode at rest: one frame, then nothing');
  assert.equal(framesAsked({ mode: 'ambient', reduced: true, now: 1000 }, 5000), 1, 'reduced motion at rest: one frame, then nothing');
});

test('the demo script: about 3 s, every step glitches, the gaps between steps are clean and wait for the next step', () => {
  const total = scriptLength(DEMO_SCRIPT);
  assert.ok(total >= 2500 && total <= 4000, `${total} ms`);
  const u = new Float32Array(UNIFORM_FLOATS);
  for (const [start, length] of DEMO_SCRIPT) {
    fillGlitchFrame(u, params({ mode: 'burst', script: DEMO_SCRIPT, burstAt: 0, now: start + 1 }));
    assert.ok(u[8] > 0, `step at ${start} ms glitches`);
    const gap = DEMO_SCRIPT.find((s) => s[0] > start + length);
    if (gap && gap[0] > start + length + 2) {
      const next = fillGlitchFrame(u, params({ mode: 'burst', script: DEMO_SCRIPT, burstAt: 0, now: start + length + 1 }));
      assert.equal(u[8], 0, 'a clean gap');
      assert.ok(Math.abs(next - (gap[0] - start - length - 1)) < 1e-6, 'it waits for the next step');
    }
  }
  assert.equal(fillGlitchFrame(u, params({ mode: 'burst', script: DEMO_SCRIPT, burstAt: 0, now: total })), Infinity, 'then calm');
});

test('typing holds the ambient events off: none starts before quietUntil, and the next change is the first event after it', () => {
  const u = new Float32Array(UNIFORM_FLOATS);
  const quietUntil = 3 * AMBIENT_CYCLE_MS + 300;
  for (let now = 2 * AMBIENT_CYCLE_MS; now < quietUntil; now += 5) {
    const next = fillGlitchFrame(u, params({ now, quietUntil }));
    assert.equal(u[8], 0);
    assert.ok(Math.abs(u[5] - AMBIENT_SPLIT * 0.35) < 1e-5, 'no chroma jolt either');
    let c = Math.floor(now / AMBIENT_CYCLE_MS);
    while (ambientEvent(1, c).start <= now || ambientEvent(1, c).start < quietUntil) c += 1;
    assert.ok(Math.abs(now + next - ambientEvent(1, c).start) < 1e-6, `at ${now}: the next change is the first event after the hold`);
  }
  assert.equal(TYPING_HOLD_MS, 1200);
  // control: without the hold, events do play in that window
  let played = 0;
  for (let now = 2 * AMBIENT_CYCLE_MS; now < quietUntil; now += 5) { fillGlitchFrame(u, params({ now })); if (u[8] > 0 || u[5] > AMBIENT_SPLIT * 0.35 + 1e-5) played += 1; }
  assert.ok(played > 0, 'without the hold an event plays in the same window');
});

test('the keep-out of the focused field: no ambient block meets it; bursts ignore it', () => {
  const keepOut = [0, 120, W, 170];
  let blocks = 0, burstHits = 0;
  for (let now = 0; now < 30 * AMBIENT_CYCLE_MS; now += 10) {
    const u = new Float32Array(UNIFORM_FLOATS);
    fillGlitchFrame(u, params({ now, keepOut, intensity: 1 }));
    for (let i = 0; i < u[8]; i += 1) {
      const b = HEADER_FLOATS + i * 8;
      assert.ok(!(u[b] < keepOut[2] && u[b + 2] > keepOut[0] && u[b + 1] < keepOut[3] && u[b + 3] > keepOut[1]), 'a block over the focused field');
      blocks += 1;
    }
  }
  for (let e = 0; e < BURST_MS; e += PATTERN_MS) {
    const u = new Float32Array(UNIFORM_FLOATS);
    fillGlitchFrame(u, params({ now: 1000 + e, burstAt: 1000, keepOut, intensity: 1 }));
    for (let i = 0; i < u[8]; i += 1) { const b = HEADER_FLOATS + i * 8; if (u[b + 1] < keepOut[3] && u[b + 3] > keepOut[1]) burstHits += 1; }
  }
  assert.ok(blocks > 50 && burstHits > 0, `${blocks} ambient blocks, ${burstHits} burst blocks over the field`);
});

test('the same instant gives the same uniform block at every frame cap', () => {
  const at = (fps) => {
    const u = new Float32Array(UNIFORM_FLOATS);
    const out = new Map();
    for (let i = 0; i <= fps; i += 1) {
      const now = 2000 + (i * 1000) / fps;
      fillGlitchFrame(u, params({ now, burstAt: 2000, intensity: 0.8 }));
      if ([2000, 2200, 2400, 3000].includes(Math.round(now * 1000) / 1000)) out.set(Math.round(now), Array.from(u));
    }
    return out;
  };
  const ref = at(120);
  for (const fps of [60, 30, 15]) for (const [k, v] of at(fps)) assert.deepEqual(v, ref.get(k), `${fps} fps at ${k} ms`);
});

test('prefers-reduced-motion: no block ever moves, no grain animation, a burst is one steady colour frame', () => {
  const u = new Float32Array(UNIFORM_FLOATS);
  for (let now = 0; now < 4 * AMBIENT_CYCLE_MS; now += 10) {
    const next = fillGlitchFrame(u, params({ now, reduced: true, burstAt: 1000, intensity: 1 }));
    assert.equal(u[8], 0);
    assert.equal(u[4], 0);
    assert.equal(next, now < 1000 ? 1000 - now : now < 1000 + BURST_MS ? 1000 + BURST_MS - now : Infinity, 'a steady picture: the next change is the start or the end of the burst');
    if (now >= 1000 && now < 1000 + BURST_MS) assert.ok(u[10] > 0 && u[5] >= 6, 'the burst is a steady colour change');
    else assert.equal(u[10], 0);
  }
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
  const source = new EventTarget();
  const canvas = Object.assign(new EventTarget(), { ownerDocument: { defaultView: { matchMedia: () => ({ matches: reduced }) } } });
  let renders = 0;
  const context = { device, format: 'bgra8unorm', canvas, source, requestRender() { renders += 1; }, listen: () => () => {} };
  const frame = (now) => ({ now, width: W, height: H, cssWidth: W, cssHeight: H, sourceReady: true, sourceView: {}, destinationView: {}, encoder });
  return { context, writes, passes, source, frame, renders: () => renders };
}

async function created(t, env, options) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => '// wgsl' }); // source mode loads glitch.wgsl; Node has no server
  t.after(() => { globalThis.fetch = realFetch; });
  return plugin.create(/** @type {any} */ (env.context), options);
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('triggers: an `invalid` event in the page and the action \'burst\' start a burst on the next frame; the action resolves \'idle\' at the frame that ends it', async (t) => {
  const env = fakeEnv();
  const inst = await created(t, env, { mode: 'burst', intensity: 1 });
  inst.render(env.frame(100));
  assert.equal(env.writes.at(-1)[8], 0, 'burst mode at rest');
  assert.equal(await inst.settled(), 'idle', 'nothing plays: at once');
  env.source.dispatchEvent(new Event('invalid'));
  inst.render(env.frame(200));
  assert.ok(env.writes.at(-1)[8] > 0, 'the burst started on this frame');
  inst.render(env.frame(200 + BURST_MS + 1));
  assert.equal(env.writes.at(-1)[8], 0);
  await new Promise((r) => setTimeout(r, 260));   // the triggers are debounced (one burst per validation pass)
  let state = 'pending';
  Promise.resolve(inst.runAction('burst', {}, { reducedMotion: false })).then((v) => { state = v; });
  inst.render(env.frame(2000));
  assert.ok(env.writes.at(-1)[8] > 0, 'the action played a burst');
  inst.render(env.frame(2000 + BURST_MS - 1));
  await flush();
  assert.equal(state, 'pending', 'still playing');
  inst.render(env.frame(2000 + BURST_MS));
  await flush();
  assert.equal(state, 'idle', 'resolved with the frame that ends the burst');
  inst.setOptions({ mode: 'burst', intensity: 1, trigger: 1 });
  inst.render(env.frame(3000));
  assert.equal(env.writes.at(-1)[8], 0, 'an option named `trigger` is no trigger: actions go through handle.trigger');
  inst.destroy();
});

test('the action burst through the effect handle: a newer trigger supersedes; removal resolves null; reduced motion ends on the timer frame', async (t) => {
  const env = fakeEnv();
  const realFetch = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async () => ({ ok: true, text: async () => '// wgsl' }));
  t.after(() => { globalThis.fetch = realFetch; });
  const { handle, inst } = await nodeHandle(plugin, { mode: 'burst', intensity: 1 }, { device: env.context.device, canvas: env.context.canvas, source: env.source });
  assert.deepEqual([...handle.actions], ['burst', 'demo']);
  assert.deepEqual([...ACTIONS], [...(plugin.actions ?? [])]);
  await assert.rejects(handle.trigger('play'), /unknown action "play" of the plugin "glitch"; its actions are 'burst'/);
  inst.render(env.frame(0));
  const first = handle.trigger('burst');
  const second = handle.trigger('burst');
  assert.equal(await first, null, 'superseded by the newer trigger (the bursts are one: debounced)');
  inst.render(env.frame(10));
  inst.render(env.frame(10 + BURST_MS));
  assert.equal(await second, 'idle');
  await new Promise((r) => setTimeout(r, 260));
  const pending = handle.trigger('burst');
  handle.remove();
  assert.equal(await pending, null);
  const calm = fakeEnv({ reduced: true });
  const c = await nodeHandle(plugin, { mode: 'ambient', intensity: 1 }, { device: calm.context.device, canvas: calm.context.canvas, source: calm.source, reducedMotion: true });
  c.inst.render(calm.frame(0));
  const steady = c.handle.trigger('burst');
  c.inst.render(calm.frame(16));
  assert.ok(calm.writes.at(-1)[10] > 0 && calm.writes.at(-1)[8] === 0, 'reduced motion: colour only, no block');
  await new Promise((r) => setTimeout(r, BURST_MS + 30));   // the plugin asks for the frame that ends the steady burst
  c.inst.render(calm.frame(16 + BURST_MS));
  assert.equal(await steady, 'idle');
  c.handle.remove();
});

test('a mapper keeps the blocks of its own frame (frozen slots; the gesture snapshot copies)', async (t) => {
  const env = fakeEnv();
  const inst = await created(t, env, { mode: 'burst', intensity: 1 });
  env.source.dispatchEvent(new Event('invalid'));
  inst.render(env.frame(0));
  const first = inst.captureInputMapper(/** @type {any} */ ({}));
  const gesture = first.captureGestureSnapshot();
  const probe = Array.from({ length: 400 }, (_, i) => ({ x: (i * 37) % W + 0.5, y: (i * 53) % H + 0.5, width: W, height: H }));
  const before = probe.map((p) => first(p));
  for (let k = 1; k <= 3; k += 1) { inst.render(env.frame(k * PATTERN_MS)); inst.captureInputMapper(/** @type {any} */ ({})); }
  assert.deepEqual(probe.map((p) => first(p)), before);
  assert.deepEqual(probe.map((p) => gesture(p)), before);
  assert.ok(before.some((m, i) => m.x !== probe[i].x || m.y !== probe[i].y), 'the first frame displaced something');
});

test('the render path allocates nothing per frame: one uniform array, one pass descriptor', async (t) => {
  const env = fakeEnv();
  const inst = await created(t, env, { mode: 'ambient', intensity: 1 });
  for (let k = 0; k < 400; k += 1) inst.render(env.frame(k * 8));
  assert.equal(new Set(env.writes).size, 1);
  assert.equal(new Set(env.passes).size, 1);
  inst.destroy();
});

test('ambient asks for a frame only when its picture changes next (one timer, no frame before it); burst mode at rest asks for none', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = fakeEnv();
  const inst = await created(t, env, { mode: 'ambient' });
  let c = 3;
  while (ambientEvent(1, c).start - c * AMBIENT_CYCLE_MS < 200) c += 1;
  const ev = ambientEvent(1, c);
  const now = c * AMBIENT_CYCLE_MS + 20;   // between the events of cycles c - 1 and c
  inst.render(env.frame(now));
  const n0 = env.renders();
  assert.equal(env.writes.at(-1)[8], 0, 'a still frame');
  t.mock.timers.tick(ev.start - now - 5);
  assert.equal(env.renders(), n0, 'no frame asked for before the event starts');
  t.mock.timers.tick(10);
  assert.equal(env.renders(), n0 + 1, 'one frame at the start of the event');
  inst.render(env.frame(ev.start + 0.5));
  assert.ok(env.writes.at(-1)[8] > 0 || env.writes.at(-1)[5] > AMBIENT_SPLIT * 0.35 + 1e-5, 'the event plays');
  // a render for another reason (the page changed) re-arms the same single timer: one frame, not two
  inst.render(env.frame(ev.start + 1));
  t.mock.timers.tick(60);
  assert.equal(env.renders(), n0 + 2, 'one frame at the next pattern or grain step');
  inst.destroy();
  t.mock.timers.tick(10000);
  assert.equal(env.renders(), n0 + 2, 'destroy cancels the timer');
  const quiet = fakeEnv();
  const still = await created(t, quiet, { mode: 'burst' });
  still.render(quiet.frame(0));
  const n = quiet.renders();
  still.render(quiet.frame(8));
  t.mock.timers.tick(10000);
  assert.equal(quiet.renders(), n, 'nothing moves: no frame requested');
  still.destroy();
});

test('typing in the page holds the ambient events off; a key press or a press during the demo ends it (resolves null) and the page is clean', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = fakeEnv();
  const inst = await created(t, env, { mode: 'ambient', intensity: 1 });
  inst.render(env.frame(performance.now()));
  env.source.dispatchEvent(new Event('keydown'));
  const typedAt = performance.now();
  for (let now = typedAt; now < typedAt + TYPING_HOLD_MS - 20; now += 10) {
    inst.render(env.frame(now));
    assert.equal(env.writes.at(-1)[8], 0, 'no ambient block while the user types');
  }
  let state = 'pending';
  Promise.resolve(inst.runAction('demo', {}, { reducedMotion: false })).then((v) => { state = v; });
  const t0 = typedAt + 3000;
  inst.render(env.frame(t0));
  assert.ok(env.writes.at(-1)[8] > 0, 'the demo plays');
  env.source.dispatchEvent(new Event('keydown'));
  await flush();
  assert.equal(state, null, 'the user took over: the demo resolves null');
  inst.render(env.frame(t0 + 20));
  assert.equal(env.writes.at(-1)[8], 0, 'and the next frame is the page');
  inst.destroy();
});

test('the action demo through the effect handle: the scripted sequence, then \'idle\'; a press cuts it short', async (t) => {
  const env = fakeEnv();
  const realFetch = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async () => ({ ok: true, text: async () => '// wgsl' }));
  t.after(() => { globalThis.fetch = realFetch; });
  const { handle, inst } = await nodeHandle(plugin, { mode: 'burst', intensity: 0.35 }, { device: env.context.device, canvas: env.context.canvas, source: env.source });
  inst.render(env.frame(0));
  let state = 'pending';
  handle.trigger('demo').then((v) => { state = v; });
  const total = scriptLength(DEMO_SCRIPT);
  let glitched = 0;
  for (let now = 100; now < 100 + total; now += 1000 / 60) {
    inst.render(env.frame(now));
    if (env.writes.at(-1)[8] > 0) glitched += 1;
    await flush();
    assert.equal(state, 'pending');
  }
  inst.render(env.frame(100 + total));
  await flush();
  assert.equal(state, 'idle');
  assert.ok(glitched > 60, `${glitched} glitched frames of the demo at 60 Hz`);
  assert.equal(await handle.settled(), 'idle');
  const cut = handle.trigger('demo');
  inst.render(env.frame(10000));
  env.context.canvas.dispatchEvent(new Event('pointerdown'));
  assert.equal(await cut, null);
  handle.remove();
});

test('prefers-reduced-motion, the instance: a burst asks for no frame while it lasts, then one frame that ends it', async (t) => {
  const env = fakeEnv({ reduced: true });
  const inst = await created(t, env, { mode: 'ambient', intensity: 1 });
  inst.render(env.frame(0));
  const atRest = env.renders();
  inst.render(env.frame(16));
  assert.equal(env.renders(), atRest, 'ambient with reduced motion is still');
  env.source.dispatchEvent(new Event('invalid'));
  const triggered = env.renders();
  inst.render(env.frame(100));
  inst.render(env.frame(116));
  assert.equal(env.renders(), triggered, 'no frame requested during the steady burst');
  assert.ok(env.writes.at(-1)[10] > 0 && env.writes.at(-1)[8] === 0, 'colour only, no block');
  await new Promise((r) => setTimeout(r, BURST_MS + 30));
  assert.equal(env.renders(), triggered + 1, 'one frame at the end of the burst');
  inst.render(env.frame(100 + BURST_MS + 5));
  assert.equal(env.writes.at(-1)[10], 0);
  inst.destroy();
});
