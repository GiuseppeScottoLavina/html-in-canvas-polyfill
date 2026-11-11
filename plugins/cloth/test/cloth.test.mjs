// Node tests of the cloth plugin: the folder contract; the simulation against independent oracles (the flat pose as a fixed point, the
// period of a hanging sheet from the hanging chain's Bessel mode, inextensibility, the wall, coming to rest); the surface and the input
// mapper against an oracle written another way (the B-spline from its basis function, Moller-Trumbore in 3D over every triangle); and the
// plugin behind the real effect handle (plugins/_shared/node-host.mjs): the same motion at 30, 60 and 120 frames per second, zero work at
// rest, the actions and their states, reduced motion, the pointer through context.localPoint, and the gestures (a press that does not
// move stays the page's, a press that moves is the cloth's, a slider is never taken, a finger takes the cloth by a sideways move or by its hem).
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractTest } from '../../_shared/contract-test.mjs';
import { nodeHandle } from '../../_shared/node-host.mjs';
import { ACTIONS, FADE_MS, GRAB_SLOP, HEM, LIFT, LIFT_TRAVEL, fabric, gustDirection, isNoTarget, meta, parseColor, plugin, stateOf } from '../index.js';
import { ASSIST_PX, GRAVITY, STEP_HZ, STEP_MS, STEP_S, WALL_GAP, createCloth, drop, gridOf, gust, hangFrom, heldPoint, holdAt, letGo, lowerSeconds, push, setPins, step, stretch, take, wake } from '../sim.js';
import { CAMERA, CLOTH, FLAT, GONE, HEAD, S, SUB, castCloth, mapClothPoint, stateLength, surfacePoint, writeControlPoints } from '../surface.js';
import { drawnSurface, selfCrossings } from './self-crossing.mjs';

contractTest(import.meta.url);

test('meta and the definition agree; the actions are those of the README', () => {
  assert.equal(plugin.type, meta.name);
  assert.equal(plugin.apiVersion, 2);
  assert.deepEqual([...ACTIONS], ['demo', 'gust', 'drop', 'in']);
  assert.deepEqual([.../** @type {string[]} */ (plugin.actions)], [...ACTIONS]);
  assert.equal(/** @type {any} */ (meta).continuous, undefined, 'nothing renders at rest with the defaults');
  assert.equal(meta.defaults.wind, 0);
});

// ---------------------------------------------------------------------------------------------------------------- the simulation

/** run until the cloth sleeps; the seconds it took (Infinity after `limit`) @param {any} c @param {number} [limit] @param {(c: any, n: number) => void} [each] */
function settle(c, limit = 12, each) {
  let n = 0;
  while (!c.asleep && n < limit * STEP_HZ) { step(c); n += 1; each?.(c, n); }
  return c.asleep ? n / STEP_HZ : Infinity;
}

test('gridOf: about 1040 cells, nearly square, on a desktop canvas and on a phone', () => {
  for (const [w, h] of [[1100, 620], [366, 640], [480, 320], [2000, 300]]) {
    const { cols, rows } = gridOf(w, h);
    assert.ok(cols * rows > 700 && cols * rows < 1300, `${w}x${h}: ${cols} x ${rows}`);
    if (w / h < 5) assert.ok(Math.abs(Math.log((w / cols) / (h / rows))) < 0.2, `${w}x${h}: cells ${w / cols} x ${h / rows}`);
  }
});

test('the flat hanging pose is an exact fixed point: a woken cloth that nothing pushes is flat and asleep after one step (control: one push, and it moves)', () => {
  const c = createCloth(1100, 620);
  wake(c);
  step(c);
  assert.ok(c.asleep && c.flat);
  assert.deepEqual(Array.from(c.x), Array.from(c.rest), 'every particle exactly on its place');
  const t = c.time;
  step(c);
  assert.equal(c.time, t, 'a sleeping cloth is not stepped');
  push(c, c.cols / 2, c.rows / 2, 60, 0, 0, -500);
  for (let i = 0; i < 20; i += 1) step(c);
  assert.ok(!c.asleep && c.away > 1, 'control: a pushed cloth moves');
});

/** the first mode of the hanging chain: J0(2.4048 sqrt(s / L)), s from the free end */
const J0 = (/** @type {number} */ x) => { let s = 0, term = 1; for (let k = 0; k < 30; k += 1) { s += term; term *= -(x * x) / (4 * (k + 1) * (k + 1)); } return s; };
/** a cloth in nearly no air, without bending stiffness, displaced by that mode; the time its hem takes to reach the plane: a quarter of the period @param {number} gravityShare */
function quarterPeriod(gravityShare) {
  const c = createCloth(600, 600);
  c.dragN = 0.02; c.dragT = 0.02; c.bend = 1e9; c.gravity *= gravityShare;
  for (let j = 1; j < c.ny; j += 1) for (let i = 0; i < c.nx; i += 1) c.x[3 * (j * c.nx + i) + 2] = 6 * J0(2.4048 * Math.sqrt(1 - j / c.rows));
  c.p.set(c.x);
  wake(c);
  const hem = 3 * ((c.ny - 1) * c.nx + (c.nx >> 1)) + 2;
  let before = c.x[hem];
  for (let n = 1; n <= 6 * STEP_HZ; n += 1) {
    step(c);
    if (c.x[hem] <= 0) return (n - 1 + before / (before - c.x[hem])) * STEP_S;
    before = c.x[hem];
  }
  return NaN;
}

test('the swing of the hanging cloth has the period of a hanging sheet (the first mode of the hanging chain: omega = 1.2024 sqrt(g / L))', () => {
  const quarter = quarterPeriod(1);
  const period = (2 * Math.PI) / (1.2024 * Math.sqrt(GRAVITY));   // g / L = GRAVITY: gravity is GRAVITY canvas heights per second squared
  assert.ok(Math.abs(4 * quarter - period) < 0.04 * period, `period ${(4 * quarter).toFixed(3)} s, a hanging sheet has ${period.toFixed(3)} s`);
  // control: with a quarter of the gravity the period doubles
  const slow = quarterPeriod(0.25);
  assert.ok(Math.abs(slow / quarter - 2) < 0.08, `a quarter of the gravity: ${(slow / quarter).toFixed(3)} times the period`);
});

test('woven, not rubber: a gust, a hard pull and the cloth\'s own weight stretch no thread by more than a few percent, and no particle leaves the reach of its pin', () => {
  const W = 1100, H = 620;
  const c = createCloth(W, H);
  let most = 0, reach = 0;
  const watch = (/** @type {any} */ k, /** @type {number} */ n) => {
    if (n % 6) return;
    most = Math.max(most, stretch(k));
    for (let p = k.nx; p < k.n; p += 1) {
      const q = 3 * (p % k.nx), o = 3 * p;
      reach = Math.max(reach, Math.hypot(k.x[o] - k.x[q], k.x[o + 1] - k.x[q + 1], k.x[o + 2] - k.x[q + 2]) / k.rest[o + 1]);
    }
  };
  gust(c, 0, 1, 0, 2);
  assert.ok(settle(c, 12, watch) < 6, 'the strongest gust dies out');
  assert.ok(most < 0.04, `a gust of strength 2 stretched a thread by ${(most * 100).toFixed(2)} %`);
  assert.ok(reach < 1 + 1e-9, `a particle was ${reach} times its thread away from its pin`);
  // a hand pulls the lower right corner far beyond what the cloth allows
  most = 0;
  take(c, c.cols - 0.5, c.rows - 0.5, W, H, 0);
  for (let n = 1; n <= STEP_HZ; n += 1) { holdAt(c, W + 300, H + 400, 0); step(c); watch(c, n); }
  assert.ok(most < 0.06, `a pull beyond reach stretched a thread by ${(most * 100).toFixed(2)} %`);
  assert.ok(reach < 1 + 1e-9, 'the hand does not pull the cloth off its pins');
  letGo(c);
  assert.ok(settle(c) < 6 && c.flat, 'released, it hangs flat again');
});

test('energy dies out: pushed, blown at, pulled or hung again, the cloth ends asleep on the flat pose exactly; the last part of the way is smooth', () => {
  for (const [name, start] of /** @type {[string, (c: any) => void][]} */ ([
    ['a push', (c) => push(c, 12, 9, 70, 40, 0, -900)],
    ['a gust', (c) => gust(c, 0, 0.7, 0.7, 1.4)],
    ['hung again', (c) => hangFrom(c, -1.1 * c.height, 0.4, 'top', lowerSeconds(c, 1.1 * c.height))],
    ['the corners, then the top edge again', (c) => { setPins(c, 'corners'); for (let i = 0; i < 2 * STEP_HZ; i += 1) step(c); setPins(c, 'top'); }],
  ])) {
    const c = createCloth(900, 600);
    start(c);
    let jump = 0, last = c.away, moved = 0;
    const t = settle(c, 12, (k) => { moved = Math.max(moved, k.away); if (k.away < ASSIST_PX && last < ASSIST_PX) jump = Math.max(jump, Math.abs(k.away - last)); last = k.away; });
    assert.ok(t < 6, `${name}: asleep after ${t} s`);
    assert.ok(moved > 3, `${name}: it moved (${moved} px)`);
    assert.ok(c.flat && c.speed === 0);
    assert.deepEqual(Array.from(c.x), Array.from(c.rest), `${name}: on the flat pose exactly`);
    assert.ok(jump < 0.05, `${name}: no step of the last ${ASSIST_PX} px moved a particle by more than 0.05 px (${jump})`);
  }
});

test('the wall: no particle goes behind it, however hard it is pushed', () => {
  const c = createCloth(900, 600);
  push(c, c.cols / 2, c.rows / 2, 90, 0, 0, -6000);
  let behind = 0, touched = false;
  settle(c, 8, (k) => { for (let o = 2; o < 3 * k.n; o += 3) { if (k.x[o] < k.wall - 1e-9) behind += 1; if (k.x[o] === k.wall) touched = true; } });
  assert.equal(behind, 0);
  assert.ok(touched, 'control: the push reached the wall');
  assert.ok(Math.abs(c.wall + WALL_GAP * 600) < 1e-9);
});

test('held by two corners the cloth sags, folds out of its plane and comes to rest there; drop lets it fall out of the frame', () => {
  const c = createCloth(900, 600);
  setPins(c, 'corners');
  assert.ok(settle(c) < 8, 'asleep');
  assert.ok(!c.flat);
  const mid = 3 * (c.nx >> 1);
  let depth = 0;
  for (let o = 2; o < 3 * c.n; o += 3) depth = Math.max(depth, Math.abs(c.x[o]));
  assert.ok(c.x[mid + 1] > 10, `the middle of the top edge sags (${c.x[mid + 1]} px)`);
  assert.ok(depth > 10, `it folds out of its plane (${depth} px)`);
  assert.ok(stretch(c) < 0.05, `stretch ${stretch(c)}`);
  const flat = createCloth(900, 600);
  drop(flat, 0.3);
  let top = 0;
  for (let n = 0; n < 2 * STEP_HZ && top < 602; n += 1) { step(flat); top = Infinity; for (let o = 1; o < 3 * flat.n; o += 3) top = Math.min(top, flat.x[o]); }
  assert.ok(top >= 602 && flat.time < 1.5, `gone after ${flat.time} s`);
  assert.equal(flat.pins, 'none');
});

test('fabric, gustDirection, parseColor', () => {
  assert.ok(fabric(0).dragN > fabric(1).dragN && fabric(0).bend > fabric(1).bend && fabric(0).push > fabric(1).push, 'a light cloth: more air, softer folds, a bigger push');
  assert.deepEqual(fabric(-3), fabric(0));
  const d = gustDirection(90);
  assert.ok(Math.abs(d.x) < 1e-12 && Math.abs(d.y - 1) < 1e-12, '90 degrees: downwards');
  assert.deepEqual(parseColor('#fff', [0, 0, 0]), [1, 1, 1]);
  assert.deepEqual(parseColor('nope', [0.1, 0.2, 0.3]), [0.1, 0.2, 0.3]);
  assert.ok(Math.abs(parseColor('#808080', [0, 0, 0])[0] - 0.2158605) < 1e-6, 'sRGB to linear');
});

// ---------------------------------------------------------------------------------------------------------------- the surface and the mapper

/** a state as render() writes it @param {any} c */
function stateOfCloth(c, mode = CLOTH) {
  const state = new Float32Array(stateLength(c.cols, c.rows));
  state[S.W] = c.width; state[S.H] = c.height; state[S.CAMERA] = CAMERA * Math.max(c.width, c.height); state[S.COLS] = c.cols; state[S.ROWS] = c.rows; state[S.MODE] = mode; state[S.SERIAL] = 1;
  writeControlPoints(state, c, 1);
  return state;
}
/** a cloth blown at and pulled by its lower right corner: folds, a lifted corner that shows its back, the wall beside it */
function tousled(W = 480, H = 320) {
  const c = createCloth(W, H);
  gust(c, 0, 1, 0, 1.5);
  take(c, c.cols - 1, c.rows - 1, W - 5, H - 5, 20);
  for (let i = 0; i < 300; i += 1) { holdAt(c, W - 5 - i * 0.9, H - 5 - i * 0.8, 60); step(c); }
  return c;
}

// The oracle, written another way: the surface from the B-spline's basis function (not from the four weights), the triangles in 3D, the
// line of sight against each of them (Moller-Trumbore), the nearest one; the page point from the barycentric coordinates in 3D.
const B3 = (/** @type {number} */ t) => { const a = Math.abs(t); return a < 1 ? 2 / 3 - a * a + (a * a * a) / 2 : a < 2 ? ((2 - a) ** 3) / 6 : 0; };
/** @param {Float32Array} state */
function oracleSurface(state) {
  const cols = state[S.COLS], rows = state[S.ROWS], pw = cols + 3;
  const at = (/** @type {number} */ s, /** @type {number} */ t) => {
    const ci = Math.min(cols - 1, Math.floor(s)), cj = Math.min(rows - 1, Math.floor(t));
    let x = 0, y = 0, z = 0;
    for (let j = cj - 1; j <= cj + 2; j += 1) for (let i = ci - 1; i <= ci + 2; i += 1) {
      const w = B3(s - i) * B3(t - j), o = HEAD + 4 * ((j + 1) * pw + i + 1);
      x += w * state[o]; y += w * state[o + 1]; z += w * state[o + 2];
    }
    return [x, y, z];
  };
  const fw = cols * SUB + 1, fh = rows * SUB + 1;
  /** @type {number[][]} */ const V = [];
  for (let gy = 0; gy < fh; gy += 1) for (let gx = 0; gx < fw; gx += 1) V.push(at(gx / SUB, gy / SUB));
  return { V, fw, fh, at };
}
/** @param {Float32Array} state @param {ReturnType<typeof oracleSurface>} surface @param {number} px @param {number} py */
function oracleCast(state, surface, px, py) {
  const { V, fw, fh } = surface;
  const Ex = state[S.W] / 2, Ey = state[S.H] / 2, Ez = state[S.CAMERA];
  const dx = px - Ex, dy = py - Ey, dz = -Ez;
  let best = Infinity;
  /** @type {{u: number, v: number, front: boolean, z: number}|null} */ let out = null;
  for (let gy = 0; gy < fh - 1; gy += 1) for (let gx = 0; gx < fw - 1; gx += 1) {
    const tl = gy * fw + gx, tr = tl + 1, bl = tl + fw, br = bl + 1;
    for (let half = 0; half < 2; half += 1) {
      // the triangles (tl, bl, tr) and (tr, bl, br), with the page coordinates of their corners (in vertices of the drawn grid)
      const A = V[half ? tr : tl], B = V[bl], C = V[half ? br : tr];
      const ua = half ? gx + 1 : gx, va = gy, ub = gx, vb = gy + 1, uc = gx + 1, vc = half ? gy + 1 : gy;
      const e1x = B[0] - A[0], e1y = B[1] - A[1], e1z = B[2] - A[2], e2x = C[0] - A[0], e2y = C[1] - A[1], e2z = C[2] - A[2];
      const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
      const a = e1x * hx + e1y * hy + e1z * hz;
      if (Math.abs(a) < 1e-12) continue;
      const f = 1 / a, sx = Ex - A[0], sy = Ey - A[1], sz = Ez - A[2];
      const u = f * (sx * hx + sy * hy + sz * hz);
      if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const v = f * (dx * qx + dy * qy + dz * qz);
      if (v < 0 || u + v > 1) continue;
      const t = f * (e2x * qx + e2y * qy + e2z * qz);
      if (!(t > 0 && t < best)) continue;
      best = t;
      // (B - A) x (C - A) points away from the viewer on the flat cloth: the printed side faces the viewer where it points along the line of sight
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      out = { u: ((1 - u - v) * ua + u * ub + v * uc) / (fw - 1), v: ((1 - u - v) * va + u * vb + v * vc) / (fh - 1), front: nx * dx + ny * dy + nz * dz > 0, z: Ez + t * dz };
    }
  }
  return out;
}

test('the surface: flat control points give the flat page exactly; its corners are the corner particles; surfacePoint equals the basis-function oracle', () => {
  const flat = createCloth(700, 500);
  const fs = stateOfCloth(flat);
  const out = [0, 0, 0];
  for (const [s, t] of [[0, 0], [flat.cols, flat.rows], [3.3, 7.9], [flat.cols - 0.01, 0.2], [11.5, flat.rows]]) {
    surfacePoint(fs, s, t, out);
    assert.ok(Math.abs(out[0] - s * flat.lx) < 2e-4 && Math.abs(out[1] - t * flat.ly) < 2e-4 && Math.abs(out[2]) < 1e-6, `flat at ${s}, ${t}: ${out}`);
  }
  const c = tousled();
  const state = stateOfCloth(c);
  const { at } = oracleSurface(state);
  for (const [s, t] of [[0.25, 0.5], [7.75, 3.1], [c.cols - 0.5, c.rows - 0.5], [c.cols / 2, c.rows]]) {
    surfacePoint(state, s, t, out);
    const o = at(s, t);
    assert.ok(Math.hypot(out[0] - o[0], out[1] - o[1], out[2] - o[2]) < 1e-6, `at ${s}, ${t}: ${out} vs ${o}`);
  }
  // the four corners of the surface are the four corner particles (as 32-bit floats)
  for (const [s, t, k] of [[0, 0, 0], [c.cols, 0, c.nx - 1], [0, c.rows, (c.ny - 1) * c.nx], [c.cols, c.rows, c.n - 1]]) {
    surfacePoint(state, s, t, out);
    assert.ok(Math.hypot(out[0] - c.x[3 * k], out[1] - c.x[3 * k + 1], out[2] - c.x[3 * k + 2]) < 1e-3, `corner ${s}, ${t}`);
  }
});

test('castCloth equals the brute-force oracle on a tousled cloth: the same page point, the same side, the wall where the oracle sees the wall', () => {
  const c = tousled();
  const state = stateOfCloth(c);
  const surface = oracleSurface(state);
  const hit = { u: 0, v: 0, z: 0, front: true };
  let n = 0, wall = 0, backs = 0, worst = 0, sides = 0;
  for (let py = 2.5; py < 320; py += 7) for (let px = 2.5; px < 480; px += 7) {
    const o = oracleCast(state, surface, px, py);
    const ok = castCloth(state, px, py, hit);
    n += 1;
    assert.equal(ok, !!o, `at ${px}, ${py}: ${ok ? 'cloth' : 'wall'}, the oracle says ${o ? 'cloth' : 'wall'}`);
    if (!o) { wall += 1; continue; }
    if (!o.front) backs += 1;
    if (o.front !== hit.front) sides += 1;
    worst = Math.max(worst, Math.hypot((o.u - hit.u) * 480, (o.v - hit.v) * 320), Math.abs(o.z - hit.z));
  }
  assert.ok(wall > 50 && backs > 50 && n - wall - backs > 1000, `the scene has wall (${wall}), back (${backs}) and printed side (${n - wall - backs})`);
  assert.equal(sides, 0, 'the same side everywhere');
  assert.ok(worst < 1e-3, `the page point differs by at most ${worst} px`);
});

test('mapClothPoint: the page point on the printed side, NO_TARGET on the back and on the wall, the identity while flat, NO_TARGET when gone; a later frame maps elsewhere', () => {
  const c = tousled();
  const state = stateOfCloth(c);
  const surface = oracleSurface(state);
  let mapped = 0, none = 0, moved = 0;
  for (let py = 4; py < 320; py += 11) for (let px = 4; px < 480; px += 11) {
    const o = oracleCast(state, surface, px, py);
    // presented at twice the size: the result is in the presented point's units
    const m = mapClothPoint(state, { x: 2 * px, y: 2 * py, width: 960, height: 640 });
    if (!o || !o.front) { assert.ok(isNoTarget(m), `at ${px}, ${py}: ${JSON.stringify(m)}`); none += 1; continue; }
    assert.ok(!isNoTarget(m) && Math.hypot(m.x - o.u * 960, m.y - o.v * 640) < 2e-3, `at ${px}, ${py}: ${JSON.stringify(m)} vs ${o.u * 960}, ${o.v * 640}`);
    mapped += 1;
    if (Math.hypot(m.x - 2 * px, m.y - 2 * py) > 2) moved += 1;
  }
  assert.ok(mapped > 300 && none > 50 && moved > 100, `mapped ${mapped}, no target ${none}, away from the identity ${moved}`);
  const p = { x: 123.25, y: 45.5, width: 480, height: 320 };
  const flat = new Float32Array(state); flat[S.MODE] = FLAT;
  assert.deepEqual(mapClothPoint(flat, p), { x: 123.25, y: 45.5 });
  const gone = new Float32Array(state); gone[S.MODE] = GONE;
  assert.ok(isNoTarget(mapClothPoint(gone, p)));
  // control: the same cloth 12 steps later maps the same points elsewhere
  for (let i = 0; i < 12; i += 1) { holdAt(c, 480 - 5 - 300 * 0.9 - i * 3, 320 - 5 - 300 * 0.8 - i * 3, 60); step(c); }
  const later = stateOfCloth(c);
  let differ = 0;
  for (let py = 4; py < 320; py += 11) for (let px = 4; px < 480; px += 11) {
    const a = mapClothPoint(state, { x: px, y: py, width: 480, height: 320 }), b = mapClothPoint(later, { x: px, y: py, width: 480, height: 320 });
    if (isNoTarget(a) !== isNoTarget(b) || (!isNoTarget(a) && Math.hypot(a.x - b.x, a.y - b.y) > 0.5)) differ += 1;
  }
  assert.ok(differ > 100, `control: ${differ} points map elsewhere 12 steps later`);
});

test('a state that is written again is seen again: the cache of castCloth follows the state\'s serial', () => {
  const c = tousled();
  const state = stateOfCloth(c);
  /** @type {{x: number, y: number, width: number, height: number}[]} */ const points = [];
  for (let y = 20; y < 320; y += 40) for (let x = 20; x < 480; x += 40) points.push({ x, y, width: 480, height: 320 });
  const first = points.map((p) => mapClothPoint(state, p));
  // the hand lets go: the cloth swings back; the same array is written again, with another serial, as a mapper slot is
  letGo(c);
  for (let i = 0; i < 60; i += 1) step(c);
  writeControlPoints(state, c, 1);
  state[S.SERIAL] = 2;
  const fresh = stateOfCloth(c);
  let differ = 0;
  points.forEach((p, i) => {
    const now = mapClothPoint(state, p);
    assert.deepEqual(now, mapClothPoint(fresh, p), `at ${p.x}, ${p.y}`);
    if (isNoTarget(now) !== isNoTarget(first[i]) || Math.hypot(now.x - first[i].x, now.y - first[i].y) > 0.5) differ += 1;
  });
  assert.ok(differ > 10, `control: ${differ} of ${points.length} points map elsewhere than before`);
});

// ---------------------------------------------------------------------------------------------------------------- the cloth against itself

/**
 * Brisk mouse paths over a canvas of w x h css px, a point every `eventMs`: wide pulls back and forth, each leg eased in and out, as a hand
 * pulls fast (the legs cover up to 0.8 of the width in 240 ms: about 4000 css px/s at their fastest on a canvas 1100 px wide).
 * @param {number} w @param {number} h @param {number} [eventMs]
 * @returns {[string, number[][]][]}
 */
function briskPaths(w, h, eventMs = 1000 / 120) {
  const path = (/** @type {number[]} */ from, /** @type {number[][]} */ to, /** @type {number} */ legMs) => {
    const points = [from];
    let a = from;
    for (const b of to) {
      const n = Math.max(1, Math.round(legMs / eventMs));
      for (let i = 1; i <= n; i += 1) { const s = i / n, e = s * s * (3 - 2 * s); points.push([a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e]); }
      a = b;
    }
    return points;
  };
  return [
    ['the lower third, sideways three times', path([0.4 * w, 0.72 * h], [[0.9 * w, 0.6 * h], [0.1 * w, 0.75 * h], [0.9 * w, 0.6 * h], [0.1 * w, 0.75 * h], [0.9 * w, 0.6 * h], [0.4 * w, 0.7 * h]], 240)],
    ['the hem, up and across', path([0.6 * w, 0.95 * h], [[0.2 * w, 0.25 * h], [0.85 * w, 0.4 * h], [0.15 * w, 0.2 * h], [0.8 * w, 0.5 * h]], 300)],
    ['a lower corner, diagonally twice', path([0.92 * w, 0.9 * h], [[0.15 * w, 0.2 * h], [0.9 * w, 0.85 * h], [0.1 * w, 0.15 * h], [0.85 * w, 0.8 * h]], 280)],
  ];
}

/**
 * A pressed mouse along `path`, as index.js turns it into the hand: the cloth is taken where the path starts, then held on the pointer's
 * line of sight, lifted off its plane as the drag goes on; let go at the end, and 0.5 s more. `frame` sees the state of a frame every 4
 * steps (120 frames a second) and its number.
 * @param {any} c @param {number[][]} path @param {(state: Float32Array, n: number) => void} frame @param {number} [eventMs]
 */
function dragAlong(c, path, frame, eventMs = 1000 / 120) {
  const D = CAMERA * Math.max(c.width, c.height), state = new Float32Array(stateLength(c.cols, c.rows));
  state[S.W] = c.width; state[S.H] = c.height; state[S.CAMERA] = D; state[S.COLS] = c.cols; state[S.ROWS] = c.rows; state[S.MODE] = CLOTH;
  const [x0, y0] = path[0];
  take(c, (x0 / c.width) * c.cols, (y0 / c.height) * c.rows, 0, 0, 0);
  const held = heldPoint(c, [0, 0, 0]);
  holdAt(c, held[0], held[1], held[2]);
  let travel = 0, steps = 0, frames = 0, clock = 0;
  const until = (/** @type {number} */ ms) => {
    while (clock + STEP_MS <= ms) {
      step(c); clock += STEP_MS; steps += 1;
      if (steps % 4 === 0) { writeControlPoints(state, c, 1); state[S.SERIAL] = frames; frame(state, frames); frames += 1; }
    }
  };
  path.forEach(([x, y], i) => {
    until(i * eventMs);
    travel = Math.max(travel, Math.hypot(x - x0, y - y0));
    const z = held[2] + LIFT * c.height * (1 - Math.exp(-travel / LIFT_TRAVEL)), k = (D - z) / D;
    holdAt(c, c.width / 2 + (x - c.width / 2) * k, c.height / 2 + (y - c.height / 2) * k, z);
  });
  letGo(c);
  until(path.length * eventMs + 500);
  return frames;
}

test('the cloth against itself: in brisk wide drags the drawn sheet never passes through itself, at 120 and at 30 events a second (control: switched off, it does in most frames)', () => {
  for (const eventMs of [1000 / 120, 1000 / 30]) {
    for (const [name, path] of briskPaths(800, 500, eventMs)) {
      const c = createCloth(800, 500);
      let checked = 0, crossed = 0, worst = 0, closest = Infinity;
      dragAlong(c, path, (state, n) => {
        if (n % 4) return;   // every 33 ms: a crossing lasts longer than that (and is checked frame by frame through the handle below)
        checked += 1;
        const x = selfCrossings(drawnSurface(state));
        if (x.length) { crossed += 1; worst = Math.max(worst, x.length); }
      }, eventMs);
      assert.ok(checked > 30, `${name}: ${checked} frames checked`);
      assert.equal(crossed, 0, `${name}, events every ${eventMs.toFixed(1)} ms: ${crossed} of ${checked} frames show the sheet through itself (up to ${worst} edges of the drawn grid)`);
      // the layers keep their distance: no two particles that are not linked are much closer than the gap at the end
      for (let a = 0; a < c.n; a += 1) for (let b = a + 1; b < c.n; b += 1) {
        if (Math.abs((a % c.nx) - (b % c.nx)) + Math.abs(Math.floor(a / c.nx) - Math.floor(b / c.nx)) <= 1) continue;
        closest = Math.min(closest, Math.hypot(c.x[3 * a] - c.x[3 * b], c.x[3 * a + 1] - c.x[3 * b + 1], c.x[3 * a + 2] - c.x[3 * b + 2]));
      }
      assert.ok(closest > 0.85 * Math.max(c.lx, c.ly), `${name}: two particles ${closest.toFixed(1)} px apart after the drag`);
    }
  }
  // control: the same drags with the cloth against itself switched off (the solver before it)
  for (const [name, path] of briskPaths(800, 500)) {
    const c = createCloth(800, 500);
    c.self.on = false;
    let checked = 0, crossed = 0;
    dragAlong(c, path, (state, n) => { if (n % 4) return; checked += 1; if (selfCrossings(drawnSurface(state)).length) crossed += 1; });
    assert.ok(crossed > 0.3 * checked, `control, ${name}: switched off, ${crossed} of ${checked} frames show the sheet through itself`);
  }
});

test('the cloth against itself, through the handle: a brisk mouse drag of the real plugin presents no frame in which the sheet passes through itself', async (t) => {
  for (const fps of [120, 30]) {
    const k = await rig(t);
    k.run(1000, 1000);
    const [, path] = briskPaths(k.w, k.h, 1000 / fps)[1];
    k.fire('pointerdown', path[0][0], path[0][1], { buttons: 1 });
    let crossed = 0, checked = 0, cloth = 0;
    path.slice(1).forEach(([x, y], i) => {
      k.fire('pointermove', x, y, { buttons: 1 });
      const m = k.run(1016 + (i * 1000) / fps, 1016 + (i * 1000) / fps);
      const s = /** @type {Float32Array} */ (stateOf(m));
      if (s[S.MODE] !== CLOTH) return;
      cloth += 1; checked += 1;
      if (selfCrossings(drawnSurface(s)).length) crossed += 1;
    });
    k.fire('pointerup', path.at(-1)[0], path.at(-1)[1]);
    assert.ok(cloth > 15, `${fps} fps: ${cloth} frames drawn as cloth`);
    assert.equal(crossed, 0, `${fps} fps: ${crossed} of ${checked} presented frames show the sheet through itself`);
    k.handle.remove();
  }
});

// ---------------------------------------------------------------------------------------------------------------- the plugin behind the handle

/** a fake GPU device that accepts what the plugin creates, and counts what it submits */
function fakeGpu() {
  const G = /** @type {any} */ (globalThis);
  G.GPUBufferUsage = { UNIFORM: 64, COPY_DST: 8 };
  G.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
  G.GPUTextureUsage = { COPY_DST: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 };
  const log = { passes: 0, draws: /** @type {number[][]} */ ([]), uniforms: /** @type {number[][]} */ ([]), pointWrites: 0, textures: 0, destroyed: 0 };
  const pass = { setPipeline() {}, setBindGroup() {}, draw(/** @type {number} */ a, /** @type {number} */ b = 1) { log.draws.push([a, b]); }, end() {} };
  const device = {
    createShaderModule: () => ({}), createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}), createRenderPipeline: () => ({}), createSampler: () => ({}),
    createBuffer: () => ({ destroy() { log.destroyed += 1; } }), createBindGroup: () => ({}),
    createTexture: () => { log.textures += 1; return { createView: () => ({}), destroy() { log.destroyed += 1; } }; },
    queue: { writeBuffer: (/** @type {any} */ _b, /** @type {number} */ _o, /** @type {Float32Array} */ d) => { log.uniforms.push(Array.from(d)); }, writeTexture: () => { log.pointWrites += 1; } },
  };
  const encoder = { beginRenderPass: () => { log.passes += 1; return pass; } };
  return { device, log, encoder };
}

/**
 * The plugin behind the real handle, on a fake canvas and document; `fire` delivers an event to the plugin's document listeners, `touch`
 * to those it added through context.listen. `reducedMotion` is what the host reads at a trigger, `media` what the plugin reads when it is created.
 * @param {any} t @param {Record<string, unknown>} [options]
 * @param {{reducedMotion?: boolean, media?: boolean, w?: number, h?: number, localPoint?: (p: {x: number, y: number}) => {x: number, y: number}|null}} [o]
 */
async function rig(t, options = {}, { reducedMotion = false, media = reducedMotion, w = 800, h = 500, localPoint } = {}) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async () => ({ ok: true, text: async () => '// wgsl' }));   // source mode loads cloth.wgsl; Node has no server
  t.after(() => { globalThis.fetch = realFetch; });
  const gpu = fakeGpu();
  /** @type {Map<string, Function[]>} */ const listeners = new Map();
  const state = { under: /** @type {any} */ (null), cursor: '', last: /** @type {number|undefined} */ (undefined) };
  class Element {}
  const doc = {
    addEventListener: (/** @type {string} */ type, /** @type {Function} */ fn) => { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
    removeEventListener: (/** @type {string} */ type, /** @type {Function} */ fn) => { listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn)); },
    defaultView: { matchMedia: () => ({ matches: media }), Element },
    elementFromPoint: () => state.under,
    documentElement: { setAttribute: (/** @type {string} */ _n, /** @type {string} */ v) => { state.cursor = v; }, removeAttribute: () => { state.cursor = ''; } },
    getSelection: () => ({ removeAllRanges() {} }),
  };
  /** @type {Map<string, Function[]>} */ const own = new Map();
  const canvas = {
    ownerDocument: doc, clientWidth: w, clientHeight: h, clientLeft: 0, clientTop: 0,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
    addEventListener: (/** @type {string} */ type, /** @type {Function} */ fn) => { own.set(type, [...(own.get(type) ?? []), fn]); },
    removeEventListener: (/** @type {string} */ type, /** @type {Function} */ fn) => { own.set(type, (own.get(type) ?? []).filter((f) => f !== fn)); },
  };
  const k = await nodeHandle(plugin, options, { device: gpu.device, canvas, source: {}, reducedMotion, ...(localPoint ? { localPoint } : {}) });
  const frame = (/** @type {number} */ now) => ({ now, width: w, height: h, cssWidth: w, cssHeight: h, sourceReady: true, sourceView: {}, destinationView: {}, encoder: gpu.encoder });
  const event = (/** @type {string} */ type, /** @type {number} */ x, /** @type {number} */ y, /** @type {Record<string, unknown>} */ more = {}) => ({
    type, pointerId: 1, isPrimary: true, button: 0, buttons: 0, pointerType: 'mouse', clientX: x, clientY: y, detail: 1, cancelable: true, target: new Element(),
    prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, composedPath: () => [canvas], ...more,
  });
  return {
    handle: k.handle, requests: k.requests, get inst() { return k.inst; }, gpu, canvas, state, listeners, w, h, frame,
    /** deliver an event to the document's capture listeners; returns it */
    fire(/** @type {string} */ type, /** @type {number} */ x, /** @type {number} */ y, /** @type {Record<string, unknown>} */ more = {}) {
      const e = event(type, x, y, more);
      for (const fn of listeners.get(type) ?? []) fn(e);
      return e;
    },
    /** deliver a touch event to the listeners of context.listen */
    touch(/** @type {string} */ type, /** @type {number} */ x, /** @type {number} */ y, { cancelable = true } = {}) {
      const e = { type, touches: [{ identifier: 0, clientX: x, clientY: y }], cancelable, prevented: false, preventDefault() { this.prevented = true; } };
      for (const fn of own.get(type) ?? []) fn(e);
      return e;
    },
    /** frames from `from` ms every `every` ms until `until` (inclusive), each followed by the mapper capture, as the host does; the last mapper */
    run(/** @type {number} */ from, /** @type {number} */ until, every = 1000 / 60) {
      /** @type {any} */ let mapper = null;
      for (let i = 0, now = from; now <= until + 1e-6; i += 1, now = from + i * every) { k.inst.render(frame(now)); mapper = k.inst.captureInputMapper(frame(now)); }
      return mapper;
    },
    /** the particle (i, j) of a mapper's state */
    particle(/** @type {any} */ mapper, /** @type {number} */ i, /** @type {number} */ j) {
      const s = /** @type {Float32Array} */ (stateOf(mapper)), o = HEAD + 4 * ((j + 1) * (s[S.COLS] + 3) + i + 1);
      return [s[o], s[o + 1], s[o + 2]];
    },
  };
}
/** let the promises of the handle resolve */
const tick = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

test('at rest the frame is the page: one full-screen pass, the identity mapper, nothing requested (control: a gust renders the cloth and asks for frames)', async (t) => {
  const k = await rig(t);
  const mapper = k.run(1000, 1100);
  assert.equal(k.inst.continuous, false);
  assert.deepEqual(k.gpu.log.draws.at(-1), [3, 1], 'one full-screen triangle');
  assert.equal(k.gpu.log.pointWrites, 0);
  assert.equal(stateOf(mapper)?.[S.MODE], FLAT);
  assert.deepEqual(mapper({ x: 321.5, y: 77, width: 800, height: 500 }), { x: 321.5, y: 77 });
  assert.equal(await k.handle.settled(), 'hanging');
  const before = k.requests();
  k.inst.render(k.frame(5000));
  assert.equal(k.requests(), before, 'a frame at rest requests no other');
  const blown = k.handle.trigger('gust');
  assert.equal(k.inst.continuous, true);
  assert.ok(k.requests() > before, 'control: the gust asks for a frame');
  const m2 = k.run(6000, 6400);
  assert.equal(stateOf(m2)?.[S.MODE], CLOTH);
  assert.ok(k.gpu.log.pointWrites > 10 && k.gpu.log.draws.some(([, b]) => b > 1), 'the mesh is drawn');
  const far = m2({ x: 400, y: 480, width: 800, height: 500 });
  assert.ok(isNoTarget(far) || Math.hypot(far.x - 400, far.y - 480) > 0.5, 'the hem has moved');
  k.handle.remove();
  assert.equal(await blown, null);
});

test('the same motion at 30, 60 and 120 frames per second: the cloth of a gust is the same at the same instants (control: a frame later it is elsewhere)', async (t) => {
  /** @param {number} fps @param {number} [late] */
  const play = async (fps, late = 0) => {
    const k = await rig(t);
    k.run(900, 900);
    k.handle.trigger('gust', { direction: 20, strength: 1.3 });
    // the cloth's clock starts with the first frame that renders the gust: here the frame at 1000 ms, at every frame rate
    /** @type {number[][]} */ const seen = [];
    let next = 1000;
    for (const at of [1200, 1500, 2000]) {
      const m = k.run(next, at + late, 1000 / fps);
      next += (Math.round(((at - next) * fps) / 1000) + 1) * (1000 / fps);
      seen.push([...k.particle(m, 10, 20), ...k.particle(m, 30, 12)]);
    }
    k.handle.remove();
    return seen;
  };
  // frames every 1/30, 1/60 and 1/120 s from the same first frame: the instants 200, 500 and 1000 ms after it are frames of all three
  const [a, b, c] = [await play(30), await play(60), await play(120)];
  let worst = 0, moved = 0;
  for (let i = 0; i < a.length; i += 1) for (let j = 0; j < a[i].length; j += 1) worst = Math.max(worst, Math.abs(a[i][j] - b[i][j]), Math.abs(a[i][j] - c[i][j]));
  for (let i = 0; i < a.length; i += 1) moved = Math.max(moved, Math.abs(a[i][2]), Math.abs(a[i][5]));
  assert.ok(moved > 10, `the gust moved the cloth (${moved} px)`);
  assert.ok(worst < 1e-3, `the largest difference between the frame rates is ${worst} px`);
  const late = await play(120, 1000 / 120);
  let apart = 0;
  for (let i = 0; i < a.length; i += 1) for (let j = 0; j < a[i].length; j += 1) apart = Math.max(apart, Math.abs(a[i][j] - late[i][j]));
  assert.ok(apart > 0.3, `control: one frame of 1/120 s later the cloth is ${apart} px elsewhere`);
});

test('a frame shows the cloth between its last two steps: half a step later, half a step further', async (t) => {
  const k = await rig(t);
  k.run(900, 900);
  k.handle.trigger('gust', { strength: 2 });
  k.run(1000, 1300, STEP_MS * 4);
  const at = (/** @type {number} */ now) => k.particle(k.run(now, now), 20, 20)[2];
  const z0 = at(1300 + 10 * STEP_MS), zh = at(1300 + 10.5 * STEP_MS), z1 = at(1300 + 11 * STEP_MS);
  assert.ok(Math.abs(z1 - z0) > 0.05, `the cloth moves (${z1 - z0} px a step)`);
  assert.ok(Math.abs(zh - (z0 + z1) / 2) < 0.02 * Math.abs(z1 - z0), `half way: ${zh} between ${z0} and ${z1}`);
  k.handle.remove();
});

test('the demo, through the effect handle: one gust, the cloth billows and comes to rest within 4 s, resolves hanging, and no frame is requested after it', async (t) => {
  const k = await rig(t);
  k.run(1000, 1000);
  /** @type {any} */ let state;
  const run = k.handle.trigger('demo').then((s) => { state = s; });
  let most = 0, ms = 0;
  for (let now = 1000 + 1000 / 60; state === undefined && now < 9000; now += 1000 / 60) {
    const m = k.run(now, now);
    if (stateOf(m)?.[S.MODE] === CLOTH) most = Math.max(most, k.particle(m, 20, 24)[2]);
    ms = now - 1000;
    await tick();
  }
  await run;
  assert.equal(state, 'hanging');
  assert.ok(most > 0.08 * k.h, `the hem billowed ${most} px towards the viewer`);
  assert.ok(ms <= 4000, `the demo took ${ms} ms`);
  assert.equal(k.inst.continuous, false);
  const m = k.run(9000, 9000);
  assert.equal(stateOf(m)?.[S.MODE], FLAT, 'the last frame is the page');
  const before = k.requests();
  k.inst.render(k.frame(9500));
  assert.equal(k.requests(), before, 'zero work at rest');
});

test('actions through the handle: gust options, unknown action, superseding, drop to dropped (no target), in back to hanging, removal', async (t) => {
  const k = await rig(t);
  k.run(1000, 1000);
  await assert.rejects(k.handle.trigger('billow'), /its actions are 'demo', 'gust', 'drop', 'in'/);
  await assert.rejects(k.handle.trigger('gust', { direction: 'left' }), /`direction` must be a finite number/);
  await assert.rejects(k.handle.trigger('gust', { strength: NaN }), /`strength` must be a finite number/);
  const older = k.handle.trigger('gust', { direction: 180 });
  const newer = k.handle.trigger('drop');
  assert.equal(await older, null, 'superseded');
  /** @type {any} */ let state;
  newer.then((s) => { state = s; });
  let now = 1000;
  /** @type {any} */ let gone = null;
  while (state === undefined && now < 6000) { now += 1000 / 60; gone = k.run(now, now); await tick(); }
  assert.equal(state, 'dropped');
  assert.ok(now - 1000 < 2500, `the cloth fell out of the frame in ${now - 1000} ms`);
  assert.equal(stateOf(gone)?.[S.MODE], GONE);
  assert.ok(isNoTarget(gone({ x: 400, y: 250, width: 800, height: 500 })), 'nothing of the page is shown');
  assert.equal(k.inst.continuous, false);
  assert.equal(await k.handle.settled(), 'dropped');
  assert.equal(await k.handle.trigger('gust'), 'dropped', 'nothing blows at a cloth that is not there');
  /** @type {any} */ let back;
  k.handle.trigger('in').then((s) => { back = s; });
  const t0 = now;
  let low = 0;
  while (back === undefined && now < t0 + 8000) { now += 1000 / 60; const m = k.run(now, now); if (stateOf(m)?.[S.MODE] === CLOTH) low = Math.min(low, k.particle(m, 0, 0)[1]); await tick(); }
  assert.equal(back, 'hanging');
  assert.ok(low < -0.5 * k.h, `it came down from above the frame (${low} px)`);
  assert.ok(now - t0 < 5000, `hung again in ${now - t0} ms`);
  assert.deepEqual(k.run(now + 100, now + 100)({ x: 10, y: 20, width: 800, height: 500 }), { x: 10, y: 20 });
  const pending = k.handle.trigger('gust');
  k.handle.remove();
  assert.equal(await pending, null);
  assert.ok(k.gpu.log.destroyed >= 5, 'buffers and textures are destroyed');
});

test('in while the cloth still falls: it falls out first, then it is hung again', async (t) => {
  const k = await rig(t);
  k.run(1000, 1000);
  k.handle.trigger('drop');
  k.run(1016, 1200);
  /** @type {any} */ let back;
  k.handle.trigger('in').then((s) => { back = s; });
  let now = 1200, below = false, above = false;
  while (back === undefined && now < 9000) {
    now += 1000 / 60;
    const m = k.run(now, now);
    if (stateOf(m)?.[S.MODE] === CLOTH) { const y = k.particle(m, 0, 0)[1]; below ||= y > k.h; above ||= below && y < -0.5 * k.h; }
    await tick();
  }
  assert.equal(back, 'hanging');
  assert.ok(below && above, 'its top edge left the frame at the bottom, and then came down from above it');
});

test('reduced motion: nothing moves; demo and gust resolve at once; drop and in crossfade to the wall and back; the pointer pushes nothing', async (t) => {
  const k = await rig(t, {}, { reducedMotion: true });
  k.run(1000, 1000);
  assert.equal(await k.handle.trigger('demo'), 'hanging');
  assert.equal(await k.handle.trigger('gust', { strength: 2 }), 'hanging');
  assert.equal(k.inst.continuous, false, 'nothing moves');
  assert.equal(stateOf(k.run(1100, 1200))?.[S.MODE], FLAT, 'the frames after them are the page');
  k.fire('pointermove', 100, 100); k.fire('pointermove', 140, 120); k.fire('pointerdown', 140, 120, { buttons: 1 });
  assert.equal(k.inst.continuous, false, 'the pointer does not wake the cloth');
  /** @type {any} */ let state;
  k.handle.trigger('drop').then((s) => { state = s; });
  k.run(2000, 2000);
  await tick();
  assert.equal(state, undefined, 'the crossfade takes time');
  const fades = [];
  for (let now = 2020; now <= 2000 + FADE_MS + 40; now += 20) { k.run(now, now); fades.push(/** @type {number[]} */ (k.gpu.log.uniforms.at(-1))[15]); await tick(); }
  assert.equal(state, 'dropped');
  assert.ok(fades.every((f, i) => i === 0 || f >= fades[i - 1]) && fades[0] > 0 && fades[0] < 1 && fades.at(-1) === 1, `the fade rises to 1: ${fades.map((f) => f.toFixed(2))}`);
  assert.ok(k.gpu.log.draws.every(([a, b]) => a === 3 && b === 1), 'only full-screen passes: the mesh is never drawn');
  assert.ok(isNoTarget(k.run(3000, 3000)({ x: 5, y: 5, width: 800, height: 500 })));
  /** @type {any} */ let back;
  k.handle.trigger('in').then((s) => { back = s; });
  for (let now = 4000; now <= 4000 + FADE_MS + 40; now += 20) { k.run(now, now); await tick(); }
  assert.equal(back, 'hanging');
  assert.deepEqual(k.run(5000, 5000)({ x: 5, y: 5, width: 800, height: 500 }), { x: 5, y: 5 });
  assert.equal(/** @type {number[]} */ (k.gpu.log.uniforms.at(-1))[15], 0);
  // the preference set only when the action is triggered (the host reads it at every trigger): the demo resolves at once, nothing moves
  const live = await rig(t, {}, { reducedMotion: true, media: false });
  live.run(1000, 1000);
  assert.equal(await live.handle.trigger('demo'), 'hanging');
  assert.equal(live.inst.continuous, false);
  // control: without the preference the same trigger moves the cloth
  const free = await rig(t);
  free.run(1000, 1000);
  free.handle.trigger('demo');
  assert.equal(free.inst.continuous, true);
});

/** where the cloth of a mapper is pushed in deepest: the particle furthest behind its plane @param {any} k @param {any} mapper */
function deepest(k, mapper) {
  const s = /** @type {Float32Array} */ (stateOf(mapper));
  let best = [0, 0, 0];
  for (let j = 1; j <= s[S.ROWS]; j += 1) for (let i = 0; i <= s[S.COLS]; i += 1) { const p = k.particle(mapper, i, j); if (p[2] < best[2]) best = p; }
  return best;
}

test('a moving pointer pushes a dent where it passes, through context.localPoint: under a later plugin the dent is where the user sees the pointer', async (t) => {
  // without a later plugin: the dent is under the pointer
  const plain = await rig(t);
  plain.run(1000, 1000);
  for (let i = 0; i <= 10; i += 1) plain.fire('pointermove', 300 + 4 * i, 300);
  const dentAt = deepest(plain, plain.run(1016, 1100));
  assert.ok(dentAt[2] < -1, `a dent of ${-dentAt[2]} px`);
  assert.ok(Math.hypot(dentAt[0] - 320, dentAt[1] - 300) < 45, `under the pointer: ${dentAt}`);
  // a later plugin shows this plugin's picture 250 px further right: the pointer at 550 is over the cloth's point 300
  const shifted = await rig(t, {}, { localPoint: (p) => ({ x: p.x - 250, y: p.y }) });
  shifted.run(1000, 1000);
  for (let i = 0; i <= 10; i += 1) shifted.fire('pointermove', 550 + 4 * i, 300);
  const seenAt = deepest(shifted, shifted.run(1016, 1100));
  assert.ok(Math.hypot(seenAt[0] - 320, seenAt[1] - 300) < 45, `where the user sees the pointer: ${seenAt}`);
  // where a later plugin shows nothing of the cloth: no push
  const hidden = await rig(t, {}, { localPoint: () => null });
  hidden.run(1000, 1000);
  for (let i = 0; i <= 10; i += 1) hidden.fire('pointermove', 300 + 4 * i, 300);
  assert.equal(hidden.inst.continuous, false, 'nothing of the cloth under the pointer: it stays asleep');
});

test('gestures: a press that does not move is the page\'s click (a poke, nothing swallowed); once it has moved it is the cloth\'s (held, swallowed, no click); a slider is never taken', async (t) => {
  const k = await rig(t);
  k.run(1000, 1000);
  // a click: down and up at one place
  let e = k.fire('pointerdown', 600, 400, { buttons: 1 });
  assert.ok(!e.prevented && !e.stopped, 'the press reaches the page');
  assert.equal(k.inst.continuous, true, 'the press pokes the cloth');
  e = k.fire('pointermove', 600 + GRAB_SLOP - 2, 400, { buttons: 1 });
  assert.ok(!e.stopped, 'inside the slop the move is the page\'s');
  e = k.fire('pointerup', 600 + GRAB_SLOP - 2, 400);
  assert.ok(!e.prevented && !e.stopped);
  e = k.fire('click', 600, 400);
  assert.ok(!e.prevented && !e.stopped, 'the click reaches the page');
  assert.equal(k.state.cursor, '');
  // a drag
  k.fire('pointerdown', 600, 400, { buttons: 1 });
  e = k.fire('pointermove', 600 - GRAB_SLOP - 1, 400, { buttons: 1 });
  assert.ok(e.prevented && e.stopped, 'past the slop the gesture is the cloth\'s');
  assert.equal(k.state.cursor, 'grabbing');
  for (let i = 1; i <= 30; i += 1) { k.fire('pointermove', 600 - 8 * i, 400 - 6 * i, { buttons: 1 }); k.run(1000 + 16 * i, 1000 + 16 * i); }
  let now = 1480;
  /** @type {any} */ let heldMapper = null;
  while (k.inst.continuous && now < 9000) { now += 1000 / 60; heldMapper = k.run(now, now); }
  assert.ok(now < 6000, `held still, the cloth comes to rest in the hand (${now - 1480} ms): no frame while nothing moves`);
  // the cloth that was pressed (the particle nearest the page point 600, 400) is under the pointer (360, 220), as the camera sees it
  const s = /** @type {Float32Array} */ (stateOf(heldMapper));
  const P = k.particle(heldMapper, Math.round((600 / 800) * s[S.COLS]), Math.round((400 / 500) * s[S.ROWS]));
  const f = s[S.CAMERA] / (s[S.CAMERA] - P[2]);
  const seen = [400 + (P[0] - 400) * f, 250 + (P[1] - 250) * f];
  assert.ok(Math.hypot(seen[0] - 360, seen[1] - 220) < 25, `the held cloth is seen at ${seen}, the pointer is at 360, 220`);
  assert.ok(P[2] > 10, `lifted off its plane (${P[2]} px)`);
  e = k.fire('mousemove', 360, 220);
  assert.ok(e.stopped, 'the mouse events of the held gesture do not reach the page');
  e = k.fire('pointerup', 360, 220);
  assert.ok(e.prevented && e.stopped);
  e = k.fire('click', 360, 220);
  assert.ok(e.prevented && e.stopped, 'the click after the drag is swallowed');
  e = k.fire('click', 360, 220);
  assert.ok(!e.stopped, 'only that one');
  assert.equal(k.state.cursor, '');
  assert.equal(k.inst.continuous, true, 'released: it swings back');
  // a press on a control that is dragged itself never becomes the cloth's gesture
  const flat = await rig(t);
  flat.run(1000, 1000);
  flat.state.under = { closest: (/** @type {string} */ sel) => (/input/.test(sel) ? {} : null) };
  flat.fire('pointerdown', 600, 400, { buttons: 1 });
  e = flat.fire('pointermove', 500, 300, { buttons: 1 });
  assert.ok(!e.prevented && !e.stopped, 'the slider keeps its drag');
  assert.equal(flat.state.cursor, '');
});

test('touch: the first move of a finger decides. Sideways anywhere on the cloth, or any way from its hem, takes the cloth (claimed); vertical elsewhere scrolls the page; a tap taps; a slider keeps its drag', async (t) => {
  const k = await rig(t);
  k.run(1000, 1000);
  const touch = { pointerType: 'touch', buttons: 1 };
  // vertical, in the middle of the cloth: the page's, and it stays the page's when the finger then turns sideways
  k.touch('touchstart', 300, 250);
  assert.equal(k.touch('touchmove', 302, 238).prevented, false, 'a vertical drag in the middle scrolls the page');
  assert.equal(k.touch('touchmove', 340, 236).prevented, false, 'decided at the first move');
  k.fire('pointerdown', 300, 250, touch);
  let e = k.fire('pointermove', 300, 200, touch);
  assert.ok(!e.stopped && k.state.cursor === '', 'the finger does not take the cloth');
  k.fire('pointercancel', 300, 200, { pointerType: 'touch' });
  // sideways, in the middle: the cloth's
  assert.equal(k.touch('touchstart', 300, 250).prevented, false, 'the touchstart is never prevented: a tap still taps');
  k.fire('pointerdown', 300, 250, touch);
  e = k.fire('pointermove', 312, 254, touch);
  assert.ok(!e.stopped, 'the pointermove before the first touchmove decides nothing');
  assert.equal(k.touch('touchmove', 312, 254).prevented, true, 'a sideways first move claims the gesture');
  e = k.fire('pointermove', 340, 256, touch);
  assert.ok(e.stopped && k.state.cursor === 'grabbing', 'the finger holds the cloth');
  assert.equal(k.touch('touchmove', 340, 320).prevented, true, 'and keeps it whatever way it then moves');
  k.fire('pointerup', 340, 320, { pointerType: 'touch' });
  assert.equal(k.state.cursor, '');
  // control: a first move only a little wider than tall stays the page's
  k.touch('touchstart', 300, 250);
  assert.equal(k.touch('touchmove', 312, 241).prevented, false, 'dx = 1.33 dy: the page scrolls');
  // the hem: any direction
  const y = k.h - HEM / 2;
  k.touch('touchstart', 300, y);
  assert.equal(k.touch('touchmove', 300, y - 12).prevented, true, 'from the hem a vertical first move claims the gesture');
  k.fire('pointerdown', 300, y, touch);
  e = k.fire('pointermove', 300, y - 30, touch);
  assert.ok(e.stopped && k.state.cursor === 'grabbing', 'the finger holds the cloth by its hem');
  k.fire('pointerup', 300, y - 30, { pointerType: 'touch' });
  // control: just above the hem a vertical move scrolls
  k.touch('touchstart', 300, k.h - HEM - 6);
  assert.equal(k.touch('touchmove', 300, k.h - HEM - 20).prevented, false);
  // a move that can no longer be prevented (the browser scrolls already) is the page's, and so are the ones after it
  k.touch('touchstart', 300, 250);
  const late = k.touch('touchmove', 330, 250, { cancelable: false });
  assert.equal(late.prevented, false);
  assert.equal(k.touch('touchmove', 360, 250).prevented, false);
  // a tap: no move, nothing claimed, the click is the page's
  k.touch('touchstart', 500, 300);
  assert.ok(!k.fire('pointerdown', 500, 300, touch).stopped);
  assert.ok(!k.fire('pointerup', 500, 300, { pointerType: 'touch' }).stopped);
  assert.ok(!k.fire('click', 500, 300).stopped, 'the tap reaches the page');
  // a slider (a control that is dragged itself) keeps a sideways drag
  k.state.under = { closest: (/** @type {string} */ sel) => (/input/.test(sel) ? {} : null) };
  k.touch('touchstart', 300, 250);
  assert.equal(k.touch('touchmove', 330, 250).prevented, false, 'a sideways drag on a slider is the slider\'s');
  k.fire('pointerdown', 300, 250, touch);
  e = k.fire('pointermove', 340, 250, touch);
  assert.ok(!e.stopped && k.state.cursor === '');
});

test('a press takes over from the demo: its gust stops at once; a press on the bare wall hangs the cloth again', async (t) => {
  const k = await rig(t);
  k.run(1000, 1000);
  /** @type {any} */ let state;
  k.handle.trigger('demo').then((s) => { state = s; });
  k.run(1016, 1150);
  k.fire('pointerdown', 200, 200, { buttons: 1 });
  k.fire('pointerup', 200, 200);
  let now = 1150;
  while (state === undefined && now < 8000) { now += 1000 / 60; k.run(now, now); await tick(); }
  assert.equal(state, 'hanging');
  // control: the demo left alone takes longer
  const alone = await rig(t);
  alone.run(1000, 1000);
  /** @type {any} */ let s2;
  alone.handle.trigger('demo').then((s) => { s2 = s; });
  let n2 = 1000;
  while (s2 === undefined && n2 < 8000) { n2 += 1000 / 60; alone.run(n2, n2); await tick(); }
  assert.ok(now < n2 - 150, `with the press ${now - 1000} ms, without ${n2 - 1000} ms`);
  // dropped: a press anywhere asks for 'in' through the host
  k.handle.trigger('drop');
  for (let i = 0; i < 200; i += 1) { now += 1000 / 60; k.run(now, now); }
  assert.equal(await k.handle.settled(), 'dropped');
  k.fire('pointerdown', 400, 250, { buttons: 1 });
  assert.equal(k.inst.continuous, true, 'the cloth comes down again');
});

test('each mapper keeps the cloth of its own frame; a gesture snapshot is not changed by later frames', async (t) => {
  const k = await rig(t);
  k.run(1000, 1000);
  k.handle.trigger('gust', { strength: 1.5 });
  const early = k.run(1016, 1300);
  const p = { x: 420, y: 470, width: 800, height: 500 };
  const then = early(p);
  const frozen = early.captureGestureSnapshot();
  // 4 slots: after more than 4 frames the slot of `early` holds another frame, the snapshot does not
  k.run(1316, 1500);
  assert.deepEqual(frozen(p), then, 'the snapshot still answers for its frame');
  const later = k.run(1516, 1600)(p);
  assert.ok(isNoTarget(later) !== isNoTarget(then) || Math.hypot(later.x - then.x, later.y - then.y) > 0.3, 'control: the cloth has moved since');
  k.handle.remove();
});

test('options: wind keeps the cloth moving (continuous on purpose) until it is 0 again; pins switches to the corners and back', async (t) => {
  const k = await rig(t, { wind: 0.6 });
  k.run(1000, 1400);
  assert.equal(k.inst.continuous, true, 'a breeze: the cloth does not rest');
  k.handle.setOptions({ wind: 0 });
  let now = 1400;
  while (k.inst.continuous && now < 9000) { now += 1000 / 60; k.run(now, now); }
  assert.ok(now < 7000, `the breeze off: at rest after ${now - 1400} ms`);
  k.handle.setOptions({ pins: 'corners' });
  assert.equal(k.inst.continuous, true);
  while (k.inst.continuous && now < 20000) { now += 1000 / 60; k.run(now, now); }
  const hung = k.run(now + 16, now + 16);
  assert.equal(stateOf(hung)?.[S.MODE], CLOTH, 'asleep in its folds: still drawn as cloth when the page changes');
  assert.ok(k.particle(hung, 20, 0)[1] > 8, 'the top edge sags between the corners');
  assert.equal(await k.handle.settled(), 'hanging');
  k.handle.setOptions({ pins: 'top' });
  while (k.inst.continuous && now < 30000) { now += 1000 / 60; k.run(now, now); }
  assert.equal(stateOf(k.run(now + 16, now + 16))?.[S.MODE], FLAT);
});
