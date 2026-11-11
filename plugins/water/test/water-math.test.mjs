import test from 'node:test';
import assert from 'node:assert/strict';
import { contractTest } from '../../_shared/contract-test.mjs';
import { ACTIONS, AMBIENT_PX, DROP_DEPTH, G, LIGHT_GRACE_MS, LIGHT_INSET_PX, MESH_PX, POND_DEPTH, causticMesh, causticRegion, POND_RADIUS, dropDepth, GLOBALS_LENGTH, demoRain, mapWaterPoint, meta, plugin as WaterEffectPlugin } from '../index.js';
import { AMBIENT_WAVES, CAUSTIC_DEPTH_PX, CAUSTIC_PX, DAMPING, PAD, VISCOSITY, REFRACT_PX, STEP_HZ, clear, createField, mirror, quiet, slopeBound, stamp, step, surfaceAt } from '../sim.js';
import { nodeHandle } from '../../_shared/node-host.mjs';
import { readFileSync } from 'node:fs';
import { HDR_PEAK, SHOULDER_WGSL } from '../../_lib/hdr.js';

contractTest(import.meta.url);

// ---- an independent oracle: the centred cubic B-spline basis, its gradient by central differences, the ambient waves by central differences ----
const B3 = (t) => { const a = Math.abs(t); return a < 1 ? 2 / 3 - a * a + (a * a * a) / 2 : a < 2 ? ((2 - a) ** 3) / 6 : 0; };
/** height of the B-spline surface at padded grid coordinate (gx, gy) */
function oracleHeight(field, offset, pw, gx, gy) {
  let h = 0;
  for (let j = Math.floor(gy) - 1; j <= Math.floor(gy) + 2; j += 1) for (let i = Math.floor(gx) - 1; i <= Math.floor(gx) + 2; i += 1) h += field[offset + j * pw + i] * B3(gx - i) * B3(gy - j);
  return h;
}
const ambientHeight = (x, y, t, amp) => AMBIENT_WAVES.reduce((s, [kx, ky, w, a, p]) => s + Math.sin(kx * x + ky * y - w * t + p) * a * amp, 0);
function oracle(state, point) {
  const W = point.width, H = point.height, cssW = state[G.CSS], cssH = state[G.CSS + 1];
  const gw = state[G.GRID], gh = state[G.GRID + 1], pw = gw + 2 * PAD;
  const u = point.x / W, v = point.y / H;
  let dx = 0, dy = 0;
  if (state[G.ACTIVE] > 0.5) {
    const e = 1e-4, gx = u * gw - 0.5 + PAD, gy = v * gh - 0.5 + PAD;
    const hx = (oracleHeight(state, GLOBALS_LENGTH, pw, gx + e, gy) - oracleHeight(state, GLOBALS_LENGTH, pw, gx - e, gy)) / (2 * e);
    const hy = (oracleHeight(state, GLOBALS_LENGTH, pw, gx, gy + e) - oracleHeight(state, GLOBALS_LENGTH, pw, gx, gy - e)) / (2 * e);
    // per cell -> per css px, times the refraction at this intensity
    dx = state[G.REFRACT] * hx * (gw / cssW);
    dy = state[G.REFRACT] * hy * (gh / cssH);
  }
  if (state[G.AMBIENT] > 0) {
    const e = 1e-3, x = u * cssW, y = v * cssH, t = state[G.TIME], a = state[G.AMBIENT];
    dx += (state[G.REFRACT] * (ambientHeight(x + e, y, t, a) - ambientHeight(x - e, y, t, a))) / (2 * e);
    dy += (state[G.REFRACT] * (ambientHeight(x, y + e, t, a) - ambientHeight(x, y - e, t, a))) / (2 * e);
  }
  return { x: Math.min(0.999, Math.max(0.001, u + dx / cssW)) * W, y: Math.min(0.999, Math.max(0.001, v + dy / cssH)) * H };
}

/** A mapper state over a field with random dents, laid out as render() writes it. */
function stateOf(cssW, cssH, { intensity = 1, ambient = 0, time = 1.7, seed = 1, steps = 30 } = {}) {
  const f = createField(cssW, cssH);
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let i = 0; i < 6; i += 1) stamp(f, rnd() * cssW, rnd() * cssH, 6 + 14 * rnd(), -2 - 6 * rnd());
  for (let i = 0; i < steps; i += 1) step(f);
  mirror(f);
  const state = new Float32Array(GLOBALS_LENGTH + f.pw * f.ph);
  const refract = REFRACT_PX * intensity;
  state[G.CSS] = cssW; state[G.CSS + 1] = cssH; state[G.K] = refract / f.cellX; state[G.K + 1] = refract / f.cellY;
  state[G.INV_CELL] = 1 / f.cellX; state[G.INV_CELL + 1] = 1 / f.cellY; state[G.GRID] = f.gw; state[G.GRID + 1] = f.gh;
  state[G.TIME] = time; state[G.INTENSITY] = intensity; state[G.AMBIENT] = ambient; state[G.ACTIVE] = 1; state[G.REFRACT] = refract;
  state.set(f.h, GLOBALS_LENGTH);
  return { state, field: f };
}

test('mapWaterPoint equals the independent oracle (B-spline basis, numeric gradient) on a grid, several sizes, intensities and the ambient swell', () => {
  let moved = 0;
  for (const [w, h] of [[640, 480], [300, 900], [1100, 620]]) {
    for (const o of [{}, { intensity: 0.35, seed: 7 }, { ambient: AMBIENT_PX, seed: 3, time: 12.5 }]) {
      const { state } = stateOf(w, h, o);
      for (let i = 0; i <= 16; i += 1) {
        for (let j = 0; j <= 16; j += 1) {
          const p = { x: (i / 16) * w, y: (j / 16) * h, width: w, height: h };
          const a = mapWaterPoint(state, p);
          const b = oracle(state, p);
          assert.ok(Math.abs(a.x - b.x) < 1e-3 && Math.abs(a.y - b.y) < 1e-3, `${w}x${h} ${JSON.stringify(o)} (${p.x},${p.y}): ${a.x},${a.y} vs ${b.x},${b.y}`);
          if (Math.hypot(a.x - p.x, a.y - p.y) > 0.5) moved += 1;
        }
      }
    }
  }
  assert.ok(moved > 200, `the states really displace (${moved} points moved by more than 0.5 px)`);
});

test('intensity 0 and a flat field (ACTIVE 0) map to the identity, up to the border clamp of the shader', () => {
  const { state } = stateOf(400, 300, { intensity: 0 });
  const p = { x: 200, y: 100, width: 400, height: 300 };
  assert.deepEqual(mapWaterPoint(state, p), { x: 200, y: 100 });
  assert.equal(mapWaterPoint(state, { ...p, x: 0, y: 300 }).x, 0.001 * 400, 'clamped like the shader (0.001 / 0.999)');
  assert.ok(Math.abs(mapWaterPoint(state, { ...p, x: 0, y: 300 }).y - 0.999 * 300) < 1e-9);
  const { state: flat } = stateOf(400, 300, { intensity: 1 });
  assert.notDeepEqual(mapWaterPoint(flat, { ...p, x: 210 }), { x: 210, y: 100 }, 'control: this field displaces');
  flat[G.ACTIVE] = 0;
  assert.deepEqual(mapWaterPoint(flat, p), { x: 200, y: 100 }, 'ACTIVE 0: the field is not read');
});

test('a dent is a diverging lens: points beside it map further out (the page looks smaller there)', () => {
  const f = createField(400, 400);
  stamp(f, 200, 200, 20, -6);
  mirror(f);
  const state = new Float32Array(GLOBALS_LENGTH + f.pw * f.ph);
  state[G.CSS] = 400; state[G.CSS + 1] = 400; state[G.GRID] = f.gw; state[G.GRID + 1] = f.gh;
  state[G.K] = REFRACT_PX / f.cellX; state[G.K + 1] = REFRACT_PX / f.cellY; state[G.ACTIVE] = 1;
  state.set(f.h, GLOBALS_LENGTH);
  const right = mapWaterPoint(state, { x: 210, y: 200, width: 400, height: 400 });
  const above = mapWaterPoint(state, { x: 200, y: 190, width: 400, height: 400 });
  assert.ok(right.x > 212 && Math.abs(right.y - 200) < 0.01, `right of the dent: ${JSON.stringify(right)}`);
  assert.ok(above.y < 188 && Math.abs(above.x - 200) < 0.01, `above it: ${JSON.stringify(above)}`);
});

test('surfaceAt: the B-spline reproduces a linear field exactly (height and gradient), so the grid leaves no pattern', () => {
  const pw = 12, ph = 10;
  const lin = new Float32Array(pw * ph).map((_, i) => 0.5 * (i % pw) - 0.25 * Math.floor(i / pw) + 3);
  for (const [gx, gy] of [[3.2, 4.7], [5.5, 5.5], [7.99, 3.01]]) {
    const s = surfaceAt(lin, 0, pw, ph, gx, gy);
    assert.ok(Math.abs(s.hx - 0.5) < 1e-6 && Math.abs(s.hy + 0.25) < 1e-6, JSON.stringify(s));
    assert.ok(Math.abs(s.h - (0.5 * gx - 0.25 * gy + 3)) < 1e-5);
  }
});

test('the wave equation: a drop becomes a ring that travels at about the wave speed, the walls mirror, and the surface comes back to rest', () => {
  const f = createField(600, 600);
  assert.ok(f.gw * f.gh <= 65536 && f.cellX >= 2.99, `grid ${f.gw}x${f.gh}, cell ${f.cellX}`);
  stamp(f, 300, 300, 12, -6);
  const at = (x, y) => f.h[(Math.round(y / f.cellY - 0.5) + PAD) * f.pw + Math.round(x / f.cellX - 0.5) + PAD];
  for (let i = 0; i < STEP_HZ / 4; i += 1) step(f);   // 0.25 s
  let best = 0, where = 0;
  for (let r = 0; r < 250; r += 1) { const v = Math.abs(at(300 + r, 300)); if (v > best) { best = v; where = r; } }
  const speed = Math.sqrt(f.c2) * f.cellX * STEP_HZ;
  assert.ok(where > 0.5 * speed * 0.25 && where < 1.3 * speed * 0.25 + 12, `the ring is at ${where} px after 0.25 s (wave speed ${speed.toFixed(0)} px/s)`);
  for (let k = 1; k <= PAD; k += 1) {
    const row = (PAD + 5) * f.pw;
    assert.equal(f.h[row + PAD - k], f.h[row + PAD + k - 1], 'left wall mirrored');
    assert.equal(f.h[(PAD + f.gh - 1 + k) * f.pw + PAD + 5], f.h[(PAD + f.gh - k) * f.pw + PAD + 5], 'bottom wall mirrored');
  }
  assert.equal(quiet(f), false, 'still moving');
  let steps = 0;
  while (!quiet(f) && steps < STEP_HZ * 8) { step(f); steps += 1; }
  assert.ok(steps < STEP_HZ * 3, `at rest ${(steps / STEP_HZ).toFixed(2)} s later`);
  clear(f);
  assert.ok(f.h.every((v) => v === 0) && f.v.every((v) => v === 0) && f.lap.every((v) => v === 0), 'cleared: exactly flat and still');
});

test('the simulation is stable for every cell size it uses (noise stays bounded and dies out)', () => {
  for (const [w, h] of [[200, 150], [390, 700], [1100, 620], [2400, 1600]]) {
    const f = createField(w, h);
    let s = 9;
    for (let i = 0; i < f.h.length; i += 1) { s = (s * 16807) % 2147483647; f.h[i] = (s / 2147483647 - 0.5) * 4; }
    mirror(f);
    for (let i = 0; i < STEP_HZ * 4; i += 1) step(f);
    let max = 0;
    for (const v of f.h) max = Math.max(max, Math.abs(v));
    assert.ok(Number.isFinite(max) && max < 0.5, `${w}x${h} (c2 ${f.c2.toFixed(2)}): max |h| ${max} after 4 s`);
  }
});

/** The step as it was before the field kept its box: every interior cell, every step (the oracle of the bounded step). */
function fullStep(f) {
  const { h, v, lap, pw, gw, gh, c2 } = f;
  for (let y = PAD; y < PAD + gh; y += 1) for (let i = y * pw + PAD, end = i + gw; i < end; i += 1) {
    const l = (4 * (h[i - 1] + h[i + 1] + h[i - pw] + h[i + pw]) + h[i - pw - 1] + h[i - pw + 1] + h[i + pw - 1] + h[i + pw + 1] - 20 * h[i]) / 6;
    v[i] = (v[i] + c2 * l + VISCOSITY * (l - lap[i])) * DAMPING;
    lap[i] = l;
  }
  for (let y = PAD; y < PAD + gh; y += 1) for (let i = y * pw + PAD, end = i + gw; i < end; i += 1) h[i] += v[i];
  mirror(f);
}

test('the step and the check for a still surface work only where the field can be non-zero (its box), with bit-identical results: pebbles in the middle, at a wall and in a corner, against the full step; the box grows by one cell a step and covers every non-zero cell; control: a box one cell too small changes the field', () => {
  const same = (a, b) => a.h.every((x, i) => Object.is(x, b.h[i]) || (x === 0 && b.h[i] === 0)) && a.v.every((x, i) => x === b.v[i]) && a.lap.every((x, i) => x === b.lap[i]);
  for (const [x, y] of [[200, 150], [3, 140], [396, 297]]) {
    const f = createField(400, 300), g = createField(400, 300);
    clear(f); clear(g);
    assert.ok(f.box[0] > f.box[2], 'a cleared field is flat: its box is empty');
    stamp(f, x, y, 22, -12); stamp(g, x, y, 22, -12);
    const width0 = f.box[2] - f.box[0];
    for (let k = 0; k < 90; k += 1) {
      if (k === 40) { stamp(f, 120, 90, 14, 5); stamp(g, 120, 90, 14, 5); }
      step(f); fullStep(g);
      assert.equal(quiet(f, 0.5), quiet(g, 0.5));
    }
    assert.ok(same(f, g), `the bounded step equals the full step bit for bit (pebble at ${x}, ${y})`);
    for (let j = 0; j < f.ph; j += 1) for (let i = 0; i < f.pw; i += 1) {
      const k = j * f.pw + i;
      if (f.h[k] !== 0 || f.v[k] !== 0 || f.lap[k] !== 0) assert.ok(i >= f.box[0] && i <= f.box[2] && j >= f.box[1] && j <= f.box[3], `cell ${i}, ${j} is non-zero outside the box`);
    }
    if (x === 200) assert.ok(f.box[2] - f.box[0] <= width0 + 2 * 90 && f.box[2] - f.box[0] > width0, 'the box grows by at most one cell on each side a step');
  }
  // the box starts small: a pebble from rest steps a small region, not the grid
  const f = createField(1100, 640);
  clear(f);
  stamp(f, 550, 320, 22, -12);
  step(f);
  const cells = (f.box[2] - f.box[0] + 1) * (f.box[3] - f.box[1] + 1);
  assert.ok(cells < 0.03 * f.pw * f.ph, `one pebble from rest: ${cells} of ${f.pw * f.ph} cells`);
  // control: a box one cell too small is not enough (the step's reach is one cell)
  const a = createField(400, 300), b = createField(400, 300);
  clear(a); clear(b);
  stamp(a, 200, 150, 22, -12); stamp(b, 200, 150, 22, -12);
  for (let k = 0; k < 5; k += 1) { a.box[0] += 1; a.box[2] -= 1; step(a); fullStep(b); }
  assert.ok(!same(a, b), 'control: a box that misses one cell gives another field');
});

test('the plugin\'s first pebble steps its own region: the box in the uniform block covers the pebble and a cell a step around it, not the grid; it grows with the rings', async () => {
  const w = await createWater({ intensity: 1 });
  const t0 = performance.now();
  w.pointer('pointerdown', 300, 200);
  w.instance.render(w.frame(t0 + 20));
  const g = w.gpu.writes.at(-1);
  const box = [g[G.BOX], g[G.BOX + 1], g[G.BOX + 2], g[G.BOX + 3]];
  const pw = g[G.GRID] + 2 * PAD, ph = g[G.GRID + 1] + 2 * PAD;
  const share = ((box[2] - box[0] + 1) * (box[3] - box[1] + 1)) / (pw * ph);
  assert.ok(g[G.ACTIVE] === 1 && share > 0 && share < 0.08, `the first frame's box ${box} is ${(share * 100).toFixed(1)} % of the grid`);
  w.run(t0 + 30, 600);
  const later = w.gpu.writes.at(-1);
  assert.ok(later[G.BOX + 2] - later[G.BOX] > box[2] - box[0], 'it grows with the rings');
});

test('quiet() is a visibility threshold: a ripple that moves the page by 0.2 px is not quiet, one of 0.02 px is; NaN resets to flat', () => {
  const f = createField(400, 400);
  // a raised cosine of radius r and height a has a largest slope of a * pi / (2 r): this one moves the page by 0.2 px at intensity 1
  const a = ((0.2 / REFRACT_PX) * 2 * 40) / Math.PI;
  stamp(f, 200, 200, 40, a);
  mirror(f);
  assert.equal(quiet(f), false);
  clear(f);
  stamp(f, 200, 200, 40, a / 10);
  mirror(f);
  assert.equal(quiet(f), true);
  // a NaN can only come from the cells the step computes, the ones that may be non-zero (f.box): one in the middle of the pebble
  f.h[(PAD + 66) * f.pw + PAD + 66] = NaN;
  assert.equal(quiet(f), true);
  assert.ok(f.h.every((v) => v === 0), 'a broken field is reset rather than run forever');
  assert.ok(CAUSTIC_PX > REFRACT_PX, 'the light focuses deeper than the view refracts');
});

/**
 * Where water.wgsl's caustic mesh puts each vertex (vs_caustics, in f64): the slope of the B-spline at p (css px, flat outside the canvas),
 * tilted by the intensity, and the light refracted by it from straight above, `depth` css px down. @param {any} f @param {number} intensity
 */
function causticVertices(f, intensity, mesh) {
  const out = [];
  for (let row = 0; row <= mesh.rows; row += 1) for (let col = 0; col <= mesh.columns; col += 1) {
    const px = -mesh.margin + col * MESH_PX, py = -mesh.margin + row * MESH_PX;
    let sx = 0, sy = 0;
    if (px >= 0 && py >= 0 && px <= f.cssWidth && py <= f.cssHeight) {
      const s = surfaceAt(f.h, 0, f.pw, f.ph, (px / f.cssWidth) * f.gw - 0.5 + PAD, (py / f.cssHeight) * f.gh - 0.5 + PAD);
      sx = (s.hx / f.cellX) * intensity; sy = (s.hy / f.cellY) * intensity;
    }
    const nl = Math.hypot(sx, sy, 1), nx = -sx / nl, ny = -sy / nl, nz = 1 / nl;
    const eta = 1 / 1.333, d = -nz, k = 1 - eta * eta * (1 - d * d), a = eta * d + Math.sqrt(k);
    const rx = -a * nx, ry = -a * ny, rz = -eta - a * nz;
    out.push({ col, row, px, py, flat: sx === 0 && sy === 0, qx: px + (CAUSTIC_DEPTH_PX * rx) / Math.max(-rz, 0.05), qy: py + (CAUSTIC_DEPTH_PX * ry) / Math.max(-rz, 0.05) });
  }
  return out;
}

test('causticRegion: every vertex of the caustic mesh outside the region it draws is exactly flat (a rim of flat vertices inside it too), and all the light of the moving surface lands inside the box the picture reads, 2 px inside its edge (random pebbles, wakes, a wall, a corner; intensity 1 and 0.4); the region is smaller than the mesh for a pebble and the whole mesh with the swell; control: the region of a lower intensity (less spill) lets light land outside the box', () => {
  const W0 = 400, H0 = 300;
  const mesh = causticMesh(W0, H0, CAUSTIC_DEPTH_PX);
  let rnd = 0x1234567;
  const r = () => { rnd = (rnd * 1103515245 + 12345) >>> 0; return rnd / 4294967296; };
  const cases = [];
  for (const [name, pebbles, steps] of [['a pebble', [[200, 150]], 0], ['a pebble after 0.2 s', [[120, 90]], 24], ['a wall', [[4, 150]], 10], ['a corner', [[396, 296]], 40], ['random pebbles', Array.from({ length: 3 }, () => [20 + 360 * r(), 20 + 260 * r()]), 30], ['a wake', [[150, 140], [170, 142], [190, 145], [210, 150]], 6]]) {
    const f = createField(W0, H0);
    clear(f);
    for (const [x, y] of pebbles) stamp(f, x, y, 22, -12);
    mirror(f);
    for (let k = 0; k < steps; k += 1) step(f);
    cases.push({ name, f });
  }
  let smaller = 0, outsideControl = 0;
  for (const { name, f } of cases) for (const intensity of [1, 0.4]) {
    const slope = slopeBound(f);
    const reg = causticRegion(f, intensity, 0, mesh, slope);
    const verts = causticVertices(f, intensity, mesh);
    const moving = verts.filter((v) => !v.flat);
    assert.ok(moving.length > 0, `${name}: the surface moves`);
    for (const v of verts) {
      const inside = v.col > reg.c0 && v.col < reg.c1 && v.row > reg.r0 && v.row < reg.r1;
      if (!v.flat) assert.ok(inside, `${name} at ${intensity}: a moving vertex (${v.px}, ${v.py}) lies inside the drawn region, off its rim`);
      if (v.flat) assert.ok(v.qx === v.px && v.qy === v.py, 'a flat vertex is not refracted');
    }
    const [x0, y0, x1, y1] = reg.light;
    for (const v of moving) assert.ok(v.qx >= x0 + 2 && v.qx <= x1 - 2 && v.qy >= y0 + 2 && v.qy <= y1 - 2, `${name} at ${intensity}: the light of (${v.px}, ${v.py}) lands at (${v.qx.toFixed(1)}, ${v.qy.toFixed(1)}), inside the box ${reg.light.map((n) => n.toFixed(1))}`);
    const maxSpill = Math.max(...moving.map((v) => Math.hypot(v.qx - v.px, v.qy - v.py)));
    assert.ok(maxSpill <= reg.spill, `${name}: the spill bound ${reg.spill.toFixed(2)} holds (${maxSpill.toFixed(2)} px)`);
    assert.equal(x0, -mesh.margin + reg.c0 * MESH_PX + LIGHT_INSET_PX);
    if ((reg.c1 - reg.c0) * (reg.r1 - reg.r0) < mesh.columns * mesh.rows) smaller += 1;
    assert.ok(maxSpill > reg.spill * 0.5, `${name}: the bound is not loose by more than half (${maxSpill.toFixed(2)} of ${reg.spill.toFixed(2)} px)`);
    // the control: the region of the same box with no slope (no spill allowed for) lets the light of the moving surface land outside the box
    if (intensity === 1) {
      const low = causticRegion(f, intensity, 0, mesh, { dx: 0, dy: 0 });
      const [a0, b0, a1, b1] = low.light;
      if (moving.some((v) => v.qx < a0 + 2 || v.qx > a1 - 2 || v.qy < b0 + 2 || v.qy > b1 - 2)) outsideControl += 1;
    }
  }
  assert.ok(smaller >= 4, `a pebble draws less than the whole mesh (${smaller} of ${cases.length * 2})`);
  assert.ok(outsideControl >= 3, `control: without the spill, light lands outside the box (${outsideControl} of ${cases.length})`);
  const swellRegion = causticRegion(cases[0].f, 1, 0.5, mesh, slopeBound(cases[0].f));
  assert.deepEqual([swellRegion.c0, swellRegion.c1, swellRegion.r0, swellRegion.r1], [0, mesh.columns, 0, mesh.rows], 'the swell: the whole mesh');
  const flat = createField(W0, H0);
  clear(flat);
  assert.deepEqual(slopeBound(flat), { dx: 0, dy: 0 });
});

test('slopeBound bounds the B-spline gradient everywhere (random fields, 4000 random points, the clamp at the border included); control: half of it does not', () => {
  const f = createField(160, 120);
  clear(f);
  let rnd = 99;
  const r = () => { rnd = (rnd * 1103515245 + 12345) >>> 0; return rnd / 4294967296; };
  for (let k = 0; k < 5; k += 1) stamp(f, 160 * r(), 120 * r(), 6 + 20 * r(), (r() - 0.5) * 30);
  mirror(f);
  for (let k = 0; k < 7; k += 1) step(f);
  const { dx, dy } = slopeBound(f);
  let maxX = 0, maxY = 0;
  for (let k = 0; k < 4000; k += 1) {
    const s = surfaceAt(f.h, 0, f.pw, f.ph, -1 + (f.pw + 1) * r(), -1 + (f.ph + 1) * r());
    maxX = Math.max(maxX, Math.abs(s.hx)); maxY = Math.max(maxY, Math.abs(s.hy));
  }
  assert.ok(maxX <= dx + 1e-9 && maxY <= dy + 1e-9, `the gradient ${maxX.toFixed(4)}, ${maxY.toFixed(4)} within the bound ${dx.toFixed(4)}, ${dy.toFixed(4)}`);
  assert.ok(maxX > dx / 2 && maxY > dy / 2, 'control: the bound is not loose by half');
});

test('the plugin definition: ABI v2, spatial, direct canvas attachment, the actions drop and demo', () => {
  assert.equal(WaterEffectPlugin.type, 'water');
  assert.equal(WaterEffectPlugin.apiVersion, 2);
  assert.equal(WaterEffectPlugin.outputCapabilities?.directCanvasRenderAttachment, true);
  assert.deepEqual([...ACTIONS], ['drop', 'demo']);
  assert.deepEqual([...(WaterEffectPlugin.actions ?? [])], ['drop', 'demo']);
  assert.ok(Object.isFrozen(WaterEffectPlugin));
  assert.equal(meta.defaults.intensity, 0.5);
});

/** A GPU device that records what the plugin submits. */
function fakeGpu() {
  const writes = [];
  const textures = [];
  const tables = [];
  const created = [];
  /** the descriptors of the pipelines the plugin made */
  const pipelines = [];
  const device = {
    createShaderModule: () => ({}), createRenderPipeline: (d) => { pipelines.push(d); return {}; }, createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}),
    createBuffer: () => ({ destroy() {} }), createSampler: () => ({}), createBindGroup: () => ({}),
    createTexture: (d) => { const t = { d, destroyed: false, createView: () => ({}), destroy() { t.destroyed = true; } }; created.push(t); return t; },
    queue: {
      writeBuffer: (buf, off, data) => writes.push(new Float32Array(data)),
      // the height field (r32float) is recorded in `textures`; the drop table's rows (rgba16float) in `tables`
      writeTexture: (dst, data, layout, size) => (dst.texture?.d?.format === 'rgba16float' ? tables : textures).push({ data: dst.texture?.d?.format === 'rgba16float' ? data : new Float32Array(data), layout, size }),
    },
  };
  const pass = { setPipeline() {}, setBindGroup() {}, draw() {}, end() {} };
  const encoder = { beginRenderPass: () => pass };
  return { device, writes, textures, tables, created, pipelines, encoder };
}

const W = 400, H = 300;
/** `localPoint` stands for the plugins added after the water (context.localPoint); without it the context has none */
async function createWater(options = {}, { reduced = false, localPoint = undefined, hdr = undefined } = {}) {
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
  const gpu = fakeGpu();
  const listeners = {};
  const listenOptions = {};
  let renders = 0;
  const win = { matchMedia: (q) => ({ matches: reduced && q === '(prefers-reduced-motion: reduce)' }), PointerEvent: class { constructor(o) { Object.assign(this, o); } } };
  const rect = { left: 0, top: 0 };   // where the canvas is in the viewport (a test scrolls the page by moving it)
  const context = {
    apiVersion: 2, device: gpu.device, format: 'bgra8unorm', requestRender() { renders += 1; },
    canvas: { ownerDocument: { defaultView: win }, getBoundingClientRect: () => ({ ...rect }), clientWidth: W, clientHeight: H, clientLeft: 0, clientTop: 0 },
    listen: (type, fn, o) => { listeners[type] = fn; listenOptions[type] = o; return () => {}; },
    viewport: () => ({}),
    ...(localPoint ? { localPoint } : {}),
    ...(hdr === undefined ? {} : { hdr }),
  };
  const instance = await WaterEffectPlugin.create(context, { shader: '// wgsl', ...options });
  const frame = (now) => ({ now, width: W * 2, height: H * 2, cssWidth: W, cssHeight: H, dpr: 2, sourceReady: true, sourceView: {}, destinationView: {}, encoder: gpu.encoder });
  const pointer = (type, x, y, extra = {}) => listeners[type](new win.PointerEvent({ clientX: x, clientY: y, buttons: 0, pointerType: 'mouse', timeStamp: performance.now(), ...extra }));
  /** render frames at 120 Hz from `t` until `done()` or `maxMs`; returns the frame time reached */
  const run = (t, maxMs, done = () => false) => { let now = t; for (; now <= t + maxMs && !done(); now += 1000 / 120) instance.render(frame(now)); return now; };
  /** a touch event with one finger (id 1) at client (x, y) */
  const touch = (type, x, y, t = performance.now()) => listeners[type]({ type, timeStamp: t, changedTouches: [{ identifier: 1, clientX: x, clientY: y }] });
  return { instance, gpu, frame, listeners, listenOptions, win, pointer, touch, rect, run, renders: () => renders };
}

test('at rest nothing works: not continuous, settled at once, the field is never uploaded, the mapper is the identity, no frame requested', async () => {
  const w = await createWater({ intensity: 1 });
  assert.equal(w.instance.continuous, false);
  assert.equal(await w.instance.settled(), 'calm');
  w.instance.render(w.frame(performance.now()));
  w.instance.render(w.frame(performance.now() + 500));
  assert.equal(w.gpu.textures.length, 0, 'a flat field is not uploaded');
  assert.equal(w.gpu.writes.at(-1)[G.ACTIVE], 0);
  assert.equal(w.instance.continuous, false, 'rendering a frame (the page changed) does not wake it');
  const m = w.instance.captureInputMapper();
  assert.deepEqual(m({ x: 123, y: 45, width: W, height: H }), { x: 123, y: 45 });
  assert.equal(w.renders(), 0, 'it never asked for a frame');
});

test('a pointerdown drops a pebble: continuous, its impulses go into the field (uploaded); it comes back to rest by itself, then continuous is false again and nothing is uploaded; the listeners are passive', async () => {
  const w = await createWater({ intensity: 1 });
  for (const type of ['pointerdown', 'pointermove', 'touchstart', 'touchmove', 'touchend', 'touchcancel']) assert.equal(w.listenOptions[type]?.passive, true, `${type} is passive: a finger keeps scrolling`);
  w.listeners.pointerdown({ clientX: 200, clientY: 150 });
  assert.equal(w.instance.continuous, false, 'not a PointerEvent: ignored');
  const t0 = performance.now();
  w.pointer('pointerdown', 200, 150);
  assert.equal(w.instance.continuous, true);
  assert.ok(w.renders() >= 1, 'it asked for a frame');
  let settledState = 'pending';
  w.instance.settled().then((s) => { settledState = s; });
  w.instance.render(w.frame(t0 + 100));
  assert.equal(w.gpu.writes.at(-1).length, GLOBALS_LENGTH);
  assert.equal(w.gpu.writes.at(-1)[G.ACTIVE], 1, 'the field holds the pebble');
  assert.ok(w.gpu.textures.at(-1).data.some((v) => Math.abs(v) > 1), 'the pebble is in the uploaded field');
  const end = w.run(t0 + 110, 6000, () => !w.instance.continuous);
  await new Promise((r) => setImmediate(r));
  assert.ok(end - t0 < 4500, `at rest ${Math.round(end - t0)} ms after the tap (intensity 1, a small canvas: the walls reflect)`);
  assert.equal(settledState, 'calm');
  assert.equal(w.gpu.writes.at(-1)[G.ACTIVE], 0, 'the last frame shows a flat surface');
  const uploads = w.gpu.textures.length;
  w.instance.render(w.frame(end + 100));
  assert.equal(w.gpu.textures.length, uploads, 'no upload at rest');
});

/** the field of the last upload: heights of the interior cells, and their centres in css px @param {any} w */
function lastField(w) {
  const t = w.gpu.textures.at(-1);
  const pw = t.size.width, ph = t.size.height, gw = pw - 2 * PAD, gh = ph - 2 * PAD;
  const at = (/** @type {number} */ i, /** @type {number} */ j) => t.data[(j + PAD) * pw + i + PAD];
  return { gw, gh, at, cx: W / gw, cy: H / gh };
}
/** the rings of a radial profile: its crests and troughs beyond 15 % of its largest |h| @param {number[]} prof */
function ringsOf(prof) {
  const max = Math.max(...prof.map(Math.abs));
  let n = 0;
  for (let i = 1; i < prof.length - 1; i += 1) if (Math.abs(prof[i]) > 0.15 * max && (prof[i] - prof[i - 1]) * (prof[i + 1] - prof[i]) <= 0 && prof[i] !== prof[i - 1]) n += 1;
  return n;
}
/** the rings of the last uploaded field along +x from (x0, y0) css px @param {any} w @param {number} x0 @param {number} y0 */
function crestsAlong(w, x0, y0) {
  const f = lastField(w);
  const j = Math.round(y0 / f.cy - 0.5), i0 = Math.round(x0 / f.cx - 0.5);
  const prof = []; for (let i = i0; i < f.gw; i += 1) prof.push(f.at(i, j));
  return ringsOf(prof);
}

test('a tap is a pebble on the wake field, centred on the tap (within 0.5 css px), ringing out as several separated rings that live about 2 s; controls: a wake dent of the same size makes fewer rings; another point moves the centre', async () => {
  const w = await createWater({ intensity: 0.5 });
  const t0 = performance.now();
  w.pointer('pointerdown', 180, 140);
  w.instance.render(w.frame(t0 + 60));
  assert.equal(w.gpu.writes.at(-1)[G.ACTIVE], 1, 'the field holds it');
  const centre = () => { const f = lastField(w); let m = 0, sx = 0, sy = 0; for (let j = 0; j < f.gh; j += 1) for (let i = 0; i < f.gw; i += 1) { const a = Math.abs(f.at(i, j)); m += a; sx += a * (i + 0.5) * f.cx; sy += a * (j + 0.5) * f.cy; } return [sx / m, sy / m]; };
  const [x, y] = centre();
  assert.ok(Math.hypot(x - 180, y - 140) < 0.5, `centred on the tap: (${x.toFixed(2)}, ${y.toFixed(2)})`);
  let now = w.run(t0 + 70, 380);
  const rings = crestsAlong(w, 180, 140);
  assert.ok(rings >= 4, `several rings (crests and troughs) 450 ms later (${rings})`);
  now = w.run(now, 700);
  assert.equal(w.instance.continuous, true, 'still ringing after 1.2 s');
  const end = w.run(now, 6000, () => !w.instance.continuous);
  assert.ok(end - t0 < 4200, `at rest ${Math.round(end - t0)} ms after the tap`);
  // control: one wake dent of the pebble's size and depth (stamp) at the same point, as long after
  const field = createField(W, H);
  stamp(field, 180, 140, POND_RADIUS, -POND_DEPTH);
  for (let k = 0; k < 54; k += 1) step(field);
  const j = Math.round(140 / field.cellY - 0.5) + PAD, i0 = Math.round(180 / field.cellX - 0.5) + PAD;
  const prof = []; for (let i = i0; i < field.gw + PAD; i += 1) prof.push(field.h[j * field.pw + i]);
  const single = ringsOf(prof);
  assert.ok(single < rings, `control: a single dent rings out as fewer rings (${single} vs ${rings})`);
  const o = await createWater({ intensity: 0.5 });
  o.pointer('pointerdown', 186, 140);
  o.instance.render(o.frame(performance.now() + 60));
  const of = lastField(o); let m = 0, sx = 0; for (let jj = 0; jj < of.gh; jj += 1) for (let i = 0; i < of.gw; i += 1) { const a = Math.abs(of.at(i, jj)); m += a; sx += a * (i + 0.5) * of.cx; }
  assert.ok(Math.abs(sx / m - 186) < 0.5 && Math.abs(sx / m - 180) > 5, 'control: a tap 6 px away is centred 6 px away');
});

test('one pointerdown is one pebble, also when it reaches both listen targets; control: two pointerdowns stir twice as deep', async () => {
  const depthAfter = async (/** @type {number} */ n, /** @type {boolean} */ same) => {
    const w = await createWater({ intensity: 1 });
    const e = new w.win.PointerEvent({ clientX: 200, clientY: 150, buttons: 0, pointerType: 'mouse', timeStamp: performance.now() });
    for (let k = 0; k < n; k += 1) w.listeners.pointerdown(same ? e : new w.win.PointerEvent({ clientX: 200, clientY: 150, buttons: 0, pointerType: 'mouse', timeStamp: performance.now() }));
    w.instance.render(w.frame(performance.now() + 30));
    return -Math.min(...w.gpu.textures.at(-1).data);
  };
  const once = await depthAfter(1, true), twiceSame = await depthAfter(2, true), twice = await depthAfter(2, false);
  assert.ok(Math.abs(twiceSame - once) < 1e-6, `the same event twice: one pebble (${once.toFixed(3)} vs ${twiceSame.toFixed(3)})`);
  assert.ok(twice > 1.8 * once, `control: two events, twice as deep (${twice.toFixed(3)})`);
});

test('a long gap between frames (a frame cap of 1, a pause) is skipped by the pebbles as by the field: after a 1 s gap a pebble shows at most 167 ms of water; control: frames all along show a full second', async () => {
  /** how far from the tap the field moves, css px @param {any} w */
  const reach = (w) => { const t = w.gpu.textures.at(-1); const pw = t.size.width, gw = pw - 2 * PAD, cx = W / gw; let max = 0, r = 0;
    for (const v of t.data) max = Math.max(max, Math.abs(v));
    const j = Math.floor(t.size.height / 2); for (let i = PAD; i < pw - PAD; i += 1) if (Math.abs(t.data[j * pw + i]) > 0.01 * max) r = Math.max(r, Math.abs((i - PAD + 0.5) * cx - 200)); return r; };
  const gap = await createWater({ intensity: 1 });
  const t0 = performance.now();
  gap.pointer('pointerdown', 200, 150);
  gap.instance.render(gap.frame(t0 + 1000));
  const near = reach(gap);
  const all = await createWater({ intensity: 1 });
  const t1 = performance.now();
  all.pointer('pointerdown', 200, 150);
  all.run(t1, 1000);
  const far = reach(all);
  assert.ok(near < 120 && far > near + 40, `after a 1 s gap the rings reach ${near.toFixed(0)} px; with frames all along ${far.toFixed(0)} px`);
});

test('a pebble animates at the display rate: at 120 Hz with jittered frame times, every frame from the first after the tap to rest shows a new field, wherever the tap falls in the frame, also after a pause; control: at 144 Hz (faster than the simulation) frames without a new field are seen', async () => {
  /** frames rendered from a tap `delta` ms after a frame until rest, and how many of them uploaded no new field @param {number} hz @param {number} delta @param {number} jitter */
  const ring = async (hz, delta, jitter, pause = 0) => {
    const w = await createWater({ intensity: 1 });
    let s = 11;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const period = 1000 / hz, tk = performance.now() - delta;   // the tap is delivered `delta` ms after the frame at tk
    w.pointer('pointerdown', 200, 150, { pointerType: 'touch', buttons: 1 });
    let frames = 0, stale = 0;
    for (let k = 1; k < hz * 8; k += 1) {
      const before = w.gpu.textures.length;
      // `pause`: frames stop for that long after 30 frames (a frame cap of 1, a hidden tab); the gap is skipped, and the steps keep their phase
      w.instance.render(w.frame(tk + k * period + (k > 30 ? pause : 0) + (rnd() * 2 - 1) * jitter));
      if (!w.instance.continuous) break;                          // the frame that found it at rest
      frames += 1;
      if (w.gpu.textures.length === before) stale += 1;
    }
    return { frames, stale };
  };
  for (const delta of [0.02, 0.3, 2, 4.2, 8.3]) {
    for (const jitter of [0, 0.3, 0.6]) {
      const { frames, stale } = await ring(120, delta, jitter);
      assert.ok(frames > 200, `it rang (${frames} frames)`);
      assert.equal(stale, 0, `tap ${delta} ms after a frame, ±${jitter} ms jitter: ${stale} of ${frames} frames showed no new water`);
    }
  }
  for (const pause of [1000, 1000.02, 1004.2]) {
    const { frames, stale } = await ring(120, 0.3, 0.3, pause);
    assert.equal(stale, 0, `after a pause of ${pause} ms: ${stale} of ${frames} frames showed no new water`);
  }
  const control = await ring(144, 0.3, 0.3);
  assert.ok(control.stale > control.frames / 10, `control: at 144 Hz ${control.stale} of ${control.frames} frames have no new step (the counter sees a missed frame)`);
});

test('the mapper evaluates the very uniform block and field that were submitted for the frame', async () => {
  const w = await createWater({ intensity: 1 });
  const t0 = performance.now();
  w.pointer('pointerdown', 150, 120);
  w.pointer('pointerdown', 260, 160);
  // and a wake across them
  for (let i = 0; i <= 6; i += 1) w.pointer('pointermove', 100 + 30 * i, 140, { timeStamp: t0 + 10 * i });
  w.instance.render(w.frame(t0 + 120));
  const field = w.gpu.created.find((t) => t.d.format === 'r32float').d.size;
  const submitted = new Float32Array(GLOBALS_LENGTH + field.width * field.height);
  submitted.set(w.gpu.writes.at(-1));
  submitted.set(w.gpu.textures.at(-1).data, GLOBALS_LENGTH);
  assert.equal(submitted[G.ACTIVE], 1, 'the field is in use');
  const mapper = w.instance.captureInputMapper();
  let moved = 0;
  for (let x = 100; x <= 320; x += 10) {
    for (let y = 80; y <= 220; y += 10) {
      const pt = { x, y, width: W, height: H };
      assert.deepEqual(mapper(pt), mapWaterPoint(submitted, pt));
      if (Math.hypot(mapper(pt).x - x, mapper(pt).y - y) > 0.3) moved += 1;
    }
  }
  assert.ok(moved > 10, `the pebbles and the wake displace (${moved} probes)`);
  assert.equal(submitted[G.RES], W * 2);
  assert.equal(submitted[G.CSS], W);
  assert.equal(submitted[G.INTENSITY], 1);
});

test('mapper states survive the whole mapper-chain ring (3 presented frames) and a gesture snapshot survives forever', async () => {
  const w = await createWater({ intensity: 1 });
  const t0 = performance.now();
  w.pointer('pointerdown', 200, 150);
  const probe = { x: 214, y: 150, width: W, height: H };
  w.instance.render(w.frame(t0 + 60));
  const first = w.instance.captureInputMapper();
  const firstResult = { ...first(probe) };
  assert.ok(Math.abs(firstResult.x - probe.x) > 0.3, 'the probe is displaced');
  const snapshot = first.captureGestureSnapshot();
  for (let k = 1; k <= 2; k += 1) { w.instance.render(w.frame(t0 + 60 + k * 40)); w.instance.captureInputMapper(); }
  assert.deepEqual(first(probe), firstResult, 'still describes its own frame after two more presentations (the ring holds three)');
  for (let k = 3; k <= 6; k += 1) { w.instance.render(w.frame(t0 + 60 + k * 40)); w.instance.captureInputMapper(); }
  assert.deepEqual(snapshot(probe), firstResult, 'a gesture snapshot is a copy: later frames cannot move it');
  assert.notDeepEqual(w.instance.captureInputMapper()(probe), firstResult, 'control: the newest mapper describes another surface');
});

test('a moving pointer leaves a wake along its path; a faster stroke and a drag stir harder; a jump does not', async () => {
  const depthAfter = async (moves, extra = {}) => {
    const w = await createWater({ intensity: 1 });
    for (const [x, y, t] of moves) w.pointer('pointermove', x, y, { timeStamp: t, ...extra });
    w.instance.render(w.frame(performance.now()));
    const data = w.gpu.textures.at(-1)?.data;
    return data ? -Math.min(...data) : 0;
  };
  const slow = await depthAfter([[100, 150, 1000], [130, 150, 1100], [160, 150, 1200]]);
  const fast = await depthAfter([[100, 150, 1000], [130, 150, 1010], [160, 150, 1020]]);
  const drag = await depthAfter([[100, 150, 1000], [130, 150, 1010], [160, 150, 1020]], { buttons: 1 });
  const jump = await depthAfter([[20, 20, 1000], [380, 280, 1010]]);
  assert.ok(fast > 0.5, `a fast stroke dents the surface (${fast} px)`);
  assert.ok(fast > slow * 1.5 && slow > 0, `faster is stronger: ${fast} vs ${slow}`);
  assert.ok(drag > fast * 1.2, `a drag stirs harder than a hover: ${drag} vs ${fast}`);
  assert.equal(jump, 0, 'a jump of the pointer starts a new path');
});

test('a finger that scrolls the page keeps stirring the water: touch moves (which go on during the scroll) are followed with the canvas where it is now; control: pointer events alone stop at pointercancel', async () => {
  // the finger moves up 200 px over 400 ms and the page scrolls with it: the canvas moves up by the same amount, so the finger stays over one spot of the canvas
  const scroll = async (withTouch) => {
    const w = await createWater({ intensity: 1 });
    const t0 = performance.now();
    if (withTouch) w.touch('touchstart', 200, 250, t0);
    w.pointer('pointermove', 200, 250, { pointerType: 'touch', buttons: 1, timeStamp: t0 });
    w.listeners.pointercancel({});   // the browser takes the gesture for scrolling
    let now = t0;
    for (let i = 1; i <= 25; i += 1) {
      now = t0 + i * 16;
      w.rect.top = -8 * i;
      if (withTouch) w.touch('touchmove', 200, 250 - 8 * i, now);
      // pointer events of that finger have stopped: these are ignored either way (they would double the touch moves)
      w.pointer('pointermove', 200, 250 - 8 * i, { pointerType: 'touch', buttons: 1, timeStamp: now });
    }
    if (withTouch) w.touch('touchend', 200, 50, now);
    w.instance.render(w.frame(now));
    const data = w.gpu.textures.at(-1)?.data;
    return { continuous: w.instance.continuous, depth: data ? -Math.min(...data) : 0 };
  };
  const finger = await scroll(true);
  const control = await scroll(false);
  assert.ok(finger.continuous && finger.depth > 1, `the scrolling finger stirred the water under it (${finger.depth.toFixed(2)} px deep)`);
  assert.equal(control.continuous, false, 'control: without touch moves, nothing stirs once the scroll has started');
});

test('touch moves and the pointer moves of the same finger are not both counted', async () => {
  const depth = async (pointerToo) => {
    const w = await createWater({ intensity: 1 });
    const t0 = performance.now();
    w.touch('touchstart', 100, 150, t0);
    for (let i = 1; i <= 6; i += 1) {
      w.touch('touchmove', 100 + 20 * i, 150, t0 + 16 * i);
      if (pointerToo) w.pointer('pointermove', 100 + 20 * i, 150, { pointerType: 'touch', buttons: 1, timeStamp: t0 + 16 * i });
    }
    w.instance.render(w.frame(t0 + 100));
    return -Math.min(...w.gpu.textures.at(-1).data);
  };
  const touchOnly = await depth(false);
  const both = await depth(true);
  assert.ok(touchOnly > 0.5 && Math.abs(both - touchOnly) < 1e-6, `the same wake (${touchOnly} vs ${both})`);
});

/** where the water of the last uploaded field is, css px: the centre of |height| over the field, or null while nothing was uploaded @param {any} w */
function stirredAt(w) {
  if (!w.gpu.textures.length) return null;
  const f = lastField(w);
  let m = 0, sx = 0, sy = 0;
  for (let j = 0; j < f.gh; j += 1) for (let i = 0; i < f.gw; i += 1) { const a = Math.abs(f.at(i, j)); m += a; sx += a * (i + 0.5) * f.cx; sy += a * (j + 0.5) * f.cy; }
  return [sx / m, sy / m];
}
/**
 * What stirs the water in the pointer tests below, each from client (x, y): a tap, a short mouse stroke to the right, the same stroke of a finger (touch events).
 * @type {Record<string, (w: any, x: number, y: number, t: number) => void>}
 */
const STIRS = {
  tap: (w, x, y) => w.pointer('pointerdown', x, y),
  stroke: (w, x, y, t) => { for (let i = 0; i <= 2; i += 1) w.pointer('pointermove', x + 10 * i, y, { timeStamp: t + 10 * i }); },
  finger: (w, x, y, t) => { w.touch('touchstart', x, y, t); for (let i = 1; i <= 2; i += 1) w.touch('touchmove', x + 10 * i, y, t + 10 * i); },
};
/** one of STIRS at client (x, y), then a frame 60 ms later: whether the water moves, and where @param {string} how @param {number} x @param {number} y @param {((p: {x: number, y: number}) => {x: number, y: number}|null)} [localPoint] */
async function stirred(how, x, y, localPoint) {
  const w = await createWater({ intensity: 0.5 }, { localPoint });
  const t0 = performance.now();
  STIRS[how](w, x, y, t0);
  const woke = w.instance.continuous;
  w.instance.render(w.frame(t0 + 60));
  return { woke, asked: w.renders(), at: stirredAt(w) };
}

test('with plugins added after the water, the pointer is read through context.localPoint: a tap, a mouse stroke and a finger stir the water where they are seen on it (within 0.5 css px of the same input there); control: without them, under the pointer', async () => {
  const DX = 120, DY = 60;
  const shift = (/** @type {{x: number, y: number}} */ p) => ({ x: p.x + DX, y: p.y + DY });
  for (const how of Object.keys(STIRS)) {
    const shifted = await stirred(how, 100, 80, shift);
    const there = await stirred(how, 100 + DX, 80 + DY);
    const here = await stirred(how, 100, 80);
    assert.ok(shifted.woke && there.woke && here.woke && shifted.at && there.at && here.at, `${how}: the water moves`);
    assert.ok(Math.hypot(shifted.at[0] - there.at[0], shifted.at[1] - there.at[1]) < 0.5, `${how}: the same water as the same input at that point with no plugin after it: (${shifted.at}) vs (${there.at})`);
    assert.ok(Math.abs(shifted.at[0] - here.at[0] - DX) < 0.5 && Math.abs(shifted.at[1] - here.at[1] - DY) < 0.5, `${how}: control: with no plugin after it the water moves under the pointer, ${DX} x ${DY} px away: (${here.at})`);
  }
});

test('where a later plugin shows nothing of the water (context.localPoint gives null) a tap drops no pebble and a stroke or a finger leaves no wake: not continuous, no frame asked for, nothing uploaded; control: the same input stirs without that', async () => {
  for (const how of Object.keys(STIRS)) {
    const unseen = await stirred(how, 200, 150, () => null);
    assert.equal(unseen.woke, false, `${how}: not continuous`);
    assert.equal(unseen.asked, 0, `${how}: no frame asked for`);
    assert.equal(unseen.at, null, `${how}: the field is not uploaded`);
    const control = await stirred(how, 200, 150);
    assert.ok(control.woke && control.asked > 0 && control.at, `${how}: control: seen, the same input stirs the water`);
  }
});

test('a path that crosses a place where a later plugin shows nothing of the water ends there: no wake is drawn across the gap, by the mouse or by a finger; control: the same path, seen all along, leaves a wake', async () => {
  // the water is not shown under x 150..170: the stroke 100 -> 160 -> 220 has one point in the gap, so its two halves are two paths of one point each
  const gap = (/** @type {{x: number, y: number}} */ p) => (p.x >= 150 && p.x <= 170 ? null : p);
  const across = async (/** @type {boolean} */ byTouch, /** @type {any} */ localPoint) => {
    const w = await createWater({ intensity: 1 }, { localPoint });
    const t0 = performance.now();
    if (byTouch) { w.touch('touchstart', 100, 150, t0); for (let i = 1; i <= 2; i += 1) w.touch('touchmove', 100 + 60 * i, 150, t0 + 10 * i); }
    else for (let i = 0; i <= 2; i += 1) w.pointer('pointermove', 100 + 60 * i, 150, { timeStamp: t0 + 10 * i });
    return w.instance.continuous;
  };
  for (const byTouch of [false, true]) {
    assert.equal(await across(byTouch, gap), false, `${byTouch ? 'finger' : 'mouse'}: nothing joins the two sides of the gap`);
    assert.equal(await across(byTouch, undefined), true, `${byTouch ? 'finger' : 'mouse'}: control: seen all along, the path leaves a wake`);
  }
});

test('intensity, light and ambient from options and setOptions reach the uniform block, clamped to 0..1; ambient makes it continuous on purpose', async () => {
  const w = await createWater({ intensity: 5, light: -1 });
  w.instance.render(w.frame(performance.now()));
  assert.equal(w.gpu.writes.at(-1)[G.INTENSITY], 1);
  assert.equal(w.gpu.writes.at(-1)[G.LIGHT], 0);
  assert.equal(w.gpu.writes.at(-1)[G.REFRACT], REFRACT_PX);
  assert.equal(w.gpu.writes.at(-1)[G.CAUSTIC], CAUSTIC_DEPTH_PX, 'the depth of the page for the light');
  w.instance.setOptions({ intensity: 0.25, light: 0.5 });
  w.instance.render(w.frame(performance.now()));
  assert.equal(w.gpu.writes.at(-1)[G.INTENSITY], 0.25);
  assert.equal(w.gpu.writes.at(-1)[G.LIGHT], 0.5);
  assert.equal(w.instance.continuous, false);
  w.instance.setOptions({ ambient: 0.5 });
  assert.equal(w.instance.continuous, true, 'the ambient swell is continuous by declaration');
  w.instance.render(w.frame(performance.now()));
  assert.ok(Math.abs(w.gpu.writes.at(-1)[G.AMBIENT] - 0.5 * AMBIENT_PX) < 1e-6);
  w.instance.setOptions({ intensity: 0 });
  assert.equal(w.instance.continuous, false, 'the swell at intensity 0 shows nothing (the output is the source): not continuous');
  w.instance.render(w.frame(performance.now()));
  assert.equal(w.gpu.writes.at(-1)[G.INTENSITY], 0, 'the option change itself is still drawn');
  w.instance.setOptions({ intensity: 0.25 });
  assert.equal(w.instance.continuous, true, 'a positive intensity brings the swell back');
  w.instance.setOptions({ ambient: 0 });
  assert.equal(w.instance.continuous, false);
  const rm = await createWater({ ambient: 1 }, { reduced: true });
  assert.equal(rm.instance.continuous, false, 'reduced motion: no swell');
});

test('the caustic textures are held only while caustics can show: none with light 0, intensity 0 or reduced motion (binding 4 is then 1 x 1); an option change that turns them on makes them at once, so the next tap allocates nothing; turning them off releases them after LIGHT_GRACE_MS; control: the defaults make them at the first frame', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const caustic = (w) => w.gpu.created.filter((t) => /^hic-water-effect-caustics(-ms)?$/.test(t.d.label));
  const live = (w) => caustic(w).filter((t) => !t.destroyed);
  const bytes = (w) => live(w).reduce((n, t) => n + t.d.size.width * t.d.size.height * 2 * (t.d.sampleCount ?? 1), 0);
  const control = await createWater();
  control.instance.render(control.frame(performance.now()));
  assert.equal(live(control).length, 2, 'control: the defaults hold the caustic texture and its multisampled target from the first frame');
  assert.equal(bytes(control), W * H * 2 * 5);
  for (const [name, options, reduced] of [['light 0', { light: 0 }, false], ['intensity 0', { intensity: 0 }, false], ['reduced motion', {}, true], ['reduced motion and the swell', { ambient: 1 }, true]]) {
    const w = await createWater(options, { reduced });
    w.instance.render(w.frame(performance.now()));
    w.instance.render(w.frame(performance.now() + 20));
    assert.equal(caustic(w).length, 0, `${name}: no caustic texture is made`);
    const none = w.gpu.created.filter((t) => t.d.label === 'hic-water-effect-caustics-none');
    assert.equal(none.length, 1, `${name}: one 1 x 1 texture stands in for it`);
    assert.deepEqual([none[0].d.size.width, none[0].d.size.height], [1, 1]);
  }
  const w = await createWater({ light: 0 });
  w.instance.render(w.frame(performance.now()));
  w.instance.setOptions({ light: 0.8 });
  assert.equal(live(w).length, 2, 'the light comes on: the textures are made at once, before the next frame');
  assert.equal(bytes(w), W * H * 2 * 5);
  const made = w.gpu.created.length;
  const t0 = performance.now();
  w.pointer('pointerdown', 200, 150);
  w.run(t0, 200);
  assert.equal(w.gpu.created.length, made, 'the first tap after that allocates nothing');
  w.instance.setOptions({ intensity: 0 });
  assert.equal(live(w).length, 2, 'intensity 0: kept for the grace period');
  t.mock.timers.tick(LIGHT_GRACE_MS);
  assert.equal(live(w).length, 0, 'intensity 0: released LIGHT_GRACE_MS later');
  w.instance.render(w.frame(t0 + 220));
  assert.equal(live(w).length, 0);
  w.instance.setOptions({ intensity: 0.5 });
  assert.equal(live(w).length, 2, 'and made again when it comes back');
  w.instance.destroy();
  assert.ok(w.gpu.created.every((t) => t.destroyed), 'destroy releases every texture, the 1 x 1 one included');
});

test('a slider dragged through 0 keeps the caustic textures: light and intensity crossing 0 again and again within LIGHT_GRACE_MS make and free nothing, and the frames in between bind them unsampled; LIGHT_GRACE_MS after the last crossing to 0 they are released and the picture binds the 1 x 1 texture (control: the release happens, and a light turned on again makes them anew); destroy during the grace releases them and cancels the release', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const caustic = (w) => w.gpu.created.filter((x) => /^hic-water-effect-caustics(-ms)?$/.test(x.d.label));
  const live = (w) => caustic(w).filter((x) => !x.destroyed);
  const w = await createWater();
  let now = performance.now();
  w.instance.render(w.frame(now));
  assert.equal(caustic(w).length, 2, 'the defaults make them at the first frame');
  // a drag of the intensity slider down to 0 and back, twice, then of a light slider: one option change and one frame per input event
  const drag = [0.12, 0.06, 0, 0.04, 0.1, 0.03, 0, 0, 0.08].map((intensity) => ({ intensity }))
    .concat([0.5, 0.2, 0, 0.1, 0, 0.6].map((light) => ({ intensity: 0.5, light })));
  for (const patch of drag) {
    w.instance.setOptions(patch);
    now += 1000 / 120;
    t.mock.timers.tick(1000 / 120);
    w.instance.render(w.frame(now));
  }
  assert.equal(caustic(w).length, 2, `${drag.length} option changes crossing 0 five times made no caustic texture`);
  assert.equal(live(w).length, 2, 'and freed none');
  const bound = () => w.gpu.created.filter((x) => x.d.label === 'hic-water-effect-caustics-none').length;
  assert.equal(bound(), 0, 'the frames during the drag bound the caustic texture (no 1 x 1 stand-in)');
  // the light ends at 0: kept for the grace period, then released
  w.instance.setOptions({ light: 0 });
  t.mock.timers.tick(LIGHT_GRACE_MS - 1);
  assert.equal(live(w).length, 2, 'kept until LIGHT_GRACE_MS after the last crossing to 0');
  w.instance.render(w.frame(now + 10));
  assert.equal(live(w).length, 2, 'a frame during the grace keeps them too');
  t.mock.timers.tick(1);
  assert.equal(live(w).length, 0, 'control: LIGHT_GRACE_MS after it they are released');
  w.instance.render(w.frame(now + 20));
  assert.equal(bound(), 1, 'the next frame binds the 1 x 1 stand-in');
  w.instance.setOptions({ light: 1 });
  assert.equal(caustic(w).length, 4, 'control: the light on again makes them anew');
  // a crossing to 0, then the grace interrupted by a crossing back: the pending release is cancelled
  w.instance.setOptions({ intensity: 0 });
  t.mock.timers.tick(LIGHT_GRACE_MS / 2);
  w.instance.setOptions({ intensity: 0.3 });
  t.mock.timers.tick(LIGHT_GRACE_MS);
  assert.equal(live(w).length, 2, 'a crossing back during the grace cancels the release');
  // destroy during the grace: everything is released at once and the release does not run later
  w.instance.setOptions({ intensity: 0 });
  w.instance.destroy();
  assert.ok(w.gpu.created.every((x) => x.destroyed), 'destroy during the grace releases every texture');
  const destroyed = w.gpu.created.length;
  t.mock.timers.tick(LIGHT_GRACE_MS);
  assert.equal(w.gpu.created.length, destroyed);
});

test('light 0, intensity 0 or reduced motion from the start: nothing is allocated and no release is pending, also after option changes that keep caustics off', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const [name, options, reduced] of [['light 0', { light: 0 }, false], ['intensity 0', { intensity: 0 }, false], ['reduced motion', {}, true]]) {
    const w = await createWater(options, { reduced });
    w.instance.render(w.frame(performance.now()));
    w.instance.setOptions(reduced ? { light: 0.5, intensity: 0.7 } : { ...options, ambient: 0.2 });
    w.instance.render(w.frame(performance.now() + 10));
    t.mock.timers.tick(LIGHT_GRACE_MS);
    assert.equal(w.gpu.created.filter((x) => /^hic-water-effect-caustics(-ms)?$/.test(x.d.label)).length, 0, `${name}: no caustic texture`);
    w.instance.destroy();
  }
});

test('a resize by a fraction of a cell keeps the ripples; another grid starts flat with a new texture', async () => {
  const w = await createWater({ intensity: 1 });
  const t0 = performance.now();
  for (let i = 0; i <= 6; i += 1) w.pointer('pointermove', 120 + 30 * i, 150, { timeStamp: t0 + 10 * i });
  w.instance.render(w.frame(t0 + 20));
  const fields = () => w.gpu.created.filter((t) => t.d.format === 'r32float');
  const texturesBefore = fields().length;
  const fieldTexture = fields()[0];
  w.instance.render({ ...w.frame(t0 + 40), cssWidth: W + 0.3 });
  assert.equal(fields().length, texturesBefore, 'the same grid');
  assert.ok(w.gpu.textures.at(-1).data.some((v) => v < -0.3), 'the ripple is still there');
  w.instance.render({ ...w.frame(t0 + 60), cssWidth: W * 2, width: W * 4 });
  assert.equal(fields().length, texturesBefore + 1, 'a new grid, a new texture');
  assert.ok(fieldTexture.destroyed, 'the old texture is destroyed');
  assert.ok(!fields().at(-1).destroyed, 'the new one is the field');
});

test('prefers-reduced-motion: still water; no ripple from the pointer, not continuous, the mapper is the identity; control: without it the pointer stirs', async () => {
  const calm = await createWater({ intensity: 1 }, { reduced: true });
  assert.equal(calm.listeners.pointerdown, undefined, 'no pointer listener at all');
  calm.instance.render(calm.frame(performance.now()));
  assert.equal(calm.instance.continuous, false);
  assert.equal(calm.gpu.writes.at(-1)[G.ACTIVE], 0);
  assert.deepEqual(calm.instance.captureInputMapper()({ x: 60, y: 40, width: W, height: H }), { x: 60, y: 40 });
  const moving = await createWater({ intensity: 1 });
  moving.pointer('pointerdown', 50, 50);
  assert.equal(moving.instance.continuous, true, 'control: the pointer starts ripples');
});

test('create rejects when the shader cannot be had, as a plugin error (no unhandled rejection)', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  try {
    globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
    await assert.rejects(WaterEffectPlugin.create({ device: {}, canvas: {}, listen() {} }, {}), /water\.wgsl fetch 404/);
  } finally { globalThis.fetch = realFetch; }
});

test('a failed shader fetch is not cached: the next create (e.g. after a device loss) tries again', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return calls === 1 ? { ok: false, status: 503 } : { ok: true, text: async () => '// wgsl' }; };
  try {
    globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
    const gpu = fakeGpu();
    const win = { matchMedia: () => ({ matches: false }), PointerEvent: class {} };
    const ctx = { device: gpu.device, format: 'bgra8unorm', requestRender() {}, listen() { return () => {}; }, canvas: { ownerDocument: { defaultView: win } } };
    await assert.rejects(WaterEffectPlugin.create(ctx, {}), /503/);
    const inst = await WaterEffectPlugin.create(ctx, {});
    assert.equal(typeof inst.render, 'function');
    assert.equal(calls, 2);
  } finally { globalThis.fetch = realFetch; }
});

/** the plugin behind the real handle of the host, over a fake GPU; the test renders the frames */
async function handleOf({ reducedMotion = false, options = {} } = {}) {
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
  const gpu = fakeGpu();
  const win = { matchMedia: () => ({ matches: reducedMotion }), PointerEvent: class {} };
  const canvas = Object.assign(new EventTarget(), { ownerDocument: { defaultView: win }, getBoundingClientRect: () => ({ left: 0, top: 0 }), clientWidth: W, clientHeight: H, clientLeft: 0, clientTop: 0 });
  const h = await nodeHandle(WaterEffectPlugin, { shader: '// wgsl', ...meta.defaults, ...options }, { device: gpu.device, canvas, source: {}, reducedMotion });
  const frame = (now) => ({ now, width: W, height: H, cssWidth: W, cssHeight: H, sourceReady: true, sourceView: {}, destinationView: {}, encoder: gpu.encoder });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return { ...h, gpu, frame, flush };
}

test('the action drop, through the effect handle: a pebble at the point at once, as deep as its strength asks; it resolves \'calm\' at rest; bad options reject; reduced motion starts none', async () => {
  const w = await handleOf();
  assert.deepEqual([...w.handle.actions], ['drop', 'demo']);
  assert.equal(await w.handle.settled(), 'calm', 'calm at once: nothing moves after creation');
  await assert.rejects(w.handle.trigger('drop', { point: { x: 'left' } }), /water: `point`/);
  await assert.rejects(w.handle.trigger('drop', { strength: NaN }), /strength/);
  const t0 = performance.now();
  let state = 'pending';
  w.handle.trigger('drop', { point: { x: 300, y: 75 }, strength: 1.5 }).then((v) => { state = v; });
  w.inst.render(w.frame(t0 + 10));
  const f = w.gpu.textures.at(-1);
  const pw = f.size.width, ph = f.size.height, cx = W / (pw - 2 * PAD), cy = H / (ph - 2 * PAD);
  let sum = 0, sx = 0, sy = 0, deepest = 0;
  for (let j = PAD; j < ph - PAD; j += 1) for (let i = PAD; i < pw - PAD; i += 1) { const v = f.data[j * pw + i], a = Math.abs(v); sum += a; sx += a * (i - PAD + 0.5) * cx; sy += a * (j - PAD + 0.5) * cy; deepest = Math.min(deepest, v); }
  assert.ok(Math.abs(sx / sum - 300) < 0.5 && Math.abs(sy / sum - 75) < 0.5, `the pebble is centred on the point (${(sx / sum).toFixed(2)}, ${(sy / sum).toFixed(2)})`);
  const half = await handleOf();
  half.handle.trigger('drop', { point: { x: 300, y: 75 }, strength: 0.75 });
  half.inst.render(half.frame(performance.now() + 10));
  const halfDeepest = Math.min(...half.gpu.textures.at(-1).data);
  half.handle.remove();
  assert.ok(Math.abs(deepest / halfDeepest - 2) < 0.01 && -deepest > 0.5 * POND_DEPTH, `as deep as the strength asks: ${(-deepest).toFixed(2)} css px at 1.5, ${(-halfDeepest).toFixed(2)} at 0.75`);
  assert.equal(dropDepth(1.2), DROP_DEPTH, 'the default strength is a tap\'s');
  assert.ok(Math.abs(dropDepth(2) / DROP_DEPTH - 2 / 1.2) < 1e-12 && dropDepth(5) === dropDepth(2) && dropDepth(0) === dropDepth(0.08), 'in proportion to the strength, clamped to 0.08 .. 2');
  let now = t0 + 10;
  for (; now < t0 + 600; now += 1000 / 120) w.inst.render(w.frame(now));
  await w.flush();
  assert.equal(state, 'pending', 'still moving after 0.6 s');
  for (; now < t0 + 8000 && state === 'pending'; now += 1000 / 120) { w.inst.render(w.frame(now)); await w.flush(); }
  assert.equal(state, 'calm');
  const pending = w.handle.trigger('drop');
  w.handle.remove();
  assert.equal(await pending, null, 'removed: null');
  const still = await handleOf({ reducedMotion: true });
  assert.equal(await still.handle.trigger('drop', { point: { x: 10, y: 10 } }), 'calm', 'reduced motion (as the host read it): no ripple, calm at once');
  still.inst.render(still.frame(t0 + 100));
  assert.equal(still.gpu.textures.length, 0, 'nothing to upload: the surface stayed flat');
  still.handle.remove();
});

test('the action drop with swell: true raises one broad ring with a crown on the wake field; control: a pebble starts as a dip', async () => {
  const w = await handleOf();
  const t0 = performance.now();
  w.handle.trigger('drop', { point: { x: 200, y: 150 }, strength: 2, swell: true });
  w.inst.render(w.frame(t0 + 10));
  assert.equal(w.gpu.writes.at(-1)[G.ACTIVE], 1, 'the field holds it');
  const crown = Math.max(...w.gpu.textures.at(-1).data);
  assert.ok(crown > 5, `a crown of more than 5 css px (${crown.toFixed(2)})`);
  w.handle.remove();
  const c = await handleOf();
  // its own time: created later than t0 (more than 10 ms later on a slow runner), a frame at t0 + 10 would come before its drop (1 failure on Windows)
  const t1 = performance.now();
  c.handle.trigger('drop', { point: { x: 200, y: 150 }, strength: 2 });
  c.inst.render(c.frame(t1 + 10));
  const pebble = Math.max(...c.gpu.textures.at(-1).data);
  assert.ok(pebble < 0.5, `control: a pebble starts as a crater, with no crown (${pebble.toFixed(2)})`);
  c.handle.remove();
});

test('the action demo: a short rain (the last drop by 1.7 s), then calm; it resolves \'calm\' within about 4 s (the default intensity) and the instance is at rest; reduced motion resolves at once', async () => {
  const rain = demoRain();
  assert.ok(rain.length >= 20 && rain.at(-1).t <= 1700 && rain.every((d, i) => i === 0 || d.t >= rain[i - 1].t), 'sorted, the last drop by 1.7 s');
  assert.deepEqual(demoRain(), rain, 'deterministic');
  const w = await handleOf();
  const t0 = performance.now();
  let state = 'pending';
  w.handle.trigger('demo').then((v) => { state = v; });
  assert.equal(w.inst.continuous, true);
  let now = t0;
  let dropsBy800 = 0;
  for (; now < t0 + 7000 && state === 'pending'; now += 1000 / 120) {
    w.inst.render(w.frame(now));
    if (now - t0 < 800) dropsBy800 = rain.filter((d) => d.t <= now - t0).length;
    await w.flush();
  }
  assert.equal(state, 'calm');
  assert.ok(now - t0 < 4200, `the demo ends at rest ${Math.round(now - t0)} ms after it started`);
  assert.ok(dropsBy800 > 8, `it rains (${dropsBy800} drops in the first 0.8 s)`);
  assert.equal(w.inst.continuous, false, 'at rest afterwards: no more frames');
  w.handle.remove();
  const rm = await handleOf({ reducedMotion: true });
  assert.equal(await rm.handle.trigger('demo'), 'calm', 'reduced motion: at once');
  assert.equal(rm.inst.continuous, false);
  rm.handle.remove();
});

test('user input during the demo (a tap, setOptions) takes over at once: the rain stops and the demo resolves null', async () => {
  const atRest = async (interrupt) => {
    const w = await createWater({ ...meta.defaults });
    const t0 = performance.now();
    let state = 'pending';
    w.instance.runAction('demo', {}, { reducedMotion: false }).then((v) => { state = v; });
    let now = t0;
    for (; now < t0 + 300; now += 1000 / 120) w.instance.render(w.frame(now));
    if (interrupt) w.pointer('pointerdown', 40, 40, { pointerType: 'touch', buttons: 1 });
    await new Promise((r) => setImmediate(r));
    const early = state;
    for (; now < t0 + 8000 && w.instance.continuous; now += 1000 / 120) w.instance.render(w.frame(now));
    await new Promise((r) => setImmediate(r));
    return { early, state, ms: now - t0 };
  };
  const tapped = await atRest(true);
  const w = await createWater({ ...meta.defaults });
  const demo = w.instance.runAction('demo', {}, { reducedMotion: false });
  w.instance.render(w.frame(performance.now() + 20));
  w.instance.setOptions({ intensity: 0.7 });
  assert.equal(await demo, null, 'setOptions during the demo takes over too');
  assert.equal(typeof meta.touch, 'string', 'meta.touch: the hint the gallery shows on a touch screen');
  assert.equal(meta.continuous, undefined, 'not continuous by design: it settles to zero frames');
  const control = await atRest(false);
  assert.equal(tapped.early, null, 'the demo resolved null at the tap');
  assert.equal(control.state, 'calm', 'control: undisturbed, it resolves calm');
  assert.ok(tapped.ms < control.ms - 300, `the rain stopped: at rest after ${Math.round(tapped.ms)} ms, the whole demo after ${Math.round(control.ms)} ms`);
});

test('destroy: a pending demo and every waiter resolve null, the field texture is destroyed', async () => {
  const w = await createWater({ intensity: 1 });
  const demo = w.instance.runAction('demo', {}, { reducedMotion: false });
  const waiting = w.instance.settled();
  w.instance.render(w.frame(performance.now() + 20));
  w.instance.destroy();
  assert.equal(await demo, null);
  assert.equal(await waiting, null);
  assert.ok(w.gpu.created.every((t) => t.destroyed));
});

test('extended range: the picture pipeline gets HDR_PEAK from context.hdr, 1 without it; a `shader` option without the constant gets none; the shader holds the shared shoulder', async () => {
  const code = readFileSync(new URL('../water.wgsl', import.meta.url), 'utf8');
  /** @param {boolean|undefined} hdr @param {string} shader */
  const peaks = async (hdr, shader) => { const { gpu, instance } = await createWater({ shader }, { hdr }); instance.destroy?.(); return Object.fromEntries(gpu.pipelines.map((d) => [d.fragment.entryPoint, d.fragment.constants?.HDR_PEAK])); };
  assert.deepEqual(await peaks(true, code), { fs: HDR_PEAK, fs_caustics: undefined }, 'extended range: the picture; the caustic pass writes light ratios, not colours');
  assert.deepEqual(await peaks(false, code), { fs: 1, fs_caustics: undefined });
  assert.deepEqual(await peaks(undefined, code), { fs: 1, fs_caustics: undefined }, 'a host that says nothing');
  assert.deepEqual(await peaks(true, '// a shader of the page, without the constant'), { fs: undefined, fs_caustics: undefined }, 'a constant the shader does not declare would fail the pipeline');
  assert.ok(code.includes(SHOULDER_WGSL), 'water.wgsl holds SHOULDER_WGSL of plugins/_lib/hdr.js, character for character');
  assert.ok(!code.replace(SHOULDER_WGSL, '').includes('override HDR_PEAK'), 'and declares the constant once');
});
