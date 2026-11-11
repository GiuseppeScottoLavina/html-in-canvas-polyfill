// The fluid of the ink plugin (sim.js) against independent oracles: the Poisson solver against a dense direct solve and against an
// eigenfunction of the Laplacian, the velocity against the closed-loop flux of an incompressible flow, the transport of the page against
// particles traced through the analytic flow, vorticity confinement against the invariants of a plane flow, and the way to rest.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CHANNELS, DT, PAD, STEP_HZ, STICK_PX_S, W_FRICTION, clear, createFluid, fieldAt, gridOf, pack, quiet, setSize, solve, step, stir, velocityAt } from '../sim.js';

const at = (f, x, y) => (y + PAD) * f.pw + x + PAD;
/** the packed field of a fluid */
const packed = (f) => { const out = new Float32Array(f.pw * f.ph * CHANNELS); pack(f, out, 0); return out; };
/** B-spline read of a packed field at a CSS point */
const read = (f, field, x, y) => fieldAt(field, 0, f.pw, f.ph, x / f.cellX - 0.5 + PAD, y / f.cellY - 0.5 + PAD);
/** the velocity (CSS px/s) of the B-spline of psi at a CSS point: (d psi/dy, -d psi/dx) */
const flowAt = (f, field, x, y) => { const s = read(f, field, x, y); return { x: s.py / f.cellY, y: -s.px / f.cellX }; };
const NO_LOSS = { drag: 0, heal: 0, confine: 0, friction: 0, stick: 0 };
const DEFAULTS = { drag: 1 / (0.3 * 10 ** 0.5), heal: 8 ** 0.5, confine: 3 };

test('the grid: multiples of 8 cells each way, cells of about 10 CSS px, at most about 8192 of them; the same grid follows a small resize', () => {
  for (const [w, h] of [[1100, 620], [480, 320], [390, 480], [3000, 2000], [50, 50]]) {
    const { gw, gh } = gridOf(w, h);
    assert.equal(gw % 8, 0); assert.equal(gh % 8, 0);
    assert.ok(gw >= 16 && gh >= 16);
    assert.ok(gw * gh <= 8192 * 1.1, `${w}x${h}: ${gw}x${gh}`);
    if (w >= 160 && h >= 160) assert.ok(w / gw >= 9 && h / gh >= 9, `${w}x${h}: cells of ${w / gw} x ${h / gh} px`);
  }
  assert.deepEqual(gridOf(1100, 620), { gw: 112, gh: 64 });
  const f = createFluid(480, 320);
  setSize(f, 483, 318);
  assert.ok(Math.abs(f.cellX - 483 / 48) < 1e-9 && Math.abs(f.cellY - 318 / 32) < 1e-9);
});

test('the stream function equals a dense direct solve of the same five-point equations (Gaussian elimination), psi = 0 on the walls; one V cycle already takes the residual down by more than 10', () => {
  const f = createFluid(170, 150);   // 16 x 16 cells, not square
  assert.equal(f.gw * f.gh, 256);
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  for (let y = 0; y < f.gh; y += 1) for (let x = 0; x < f.gw; x += 1) f.w[at(f, x, y)] = rnd();
  // the dense system: (2 ax + 2 ay) p - ax (west + east) - ay (north + south) = w, with the ghost beyond a wall equal to minus the cell
  const n = f.gw * f.gh, ax = 1 / f.cellX ** 2, ay = 1 / f.cellY ** 2;
  const A = Array.from({ length: n }, () => new Float64Array(n + 1));
  for (let y = 0; y < f.gh; y += 1) for (let x = 0; x < f.gw; x += 1) {
    const i = y * f.gw + x;
    A[i][i] = 2 * ax + 2 * ay; A[i][n] = f.w[at(f, x, y)];
    for (const [dx, dy, c] of [[-1, 0, ax], [1, 0, ax], [0, -1, ay], [0, 1, ay]]) {
      const X = x + dx, Y = y + dy;
      if (X < 0 || X >= f.gw || Y < 0 || Y >= f.gh) A[i][i] += c; else A[i][Y * f.gw + X] -= c;
    }
  }
  for (let c = 0; c < n; c += 1) {
    let p = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = c + 1; r < n; r += 1) { const k = A[r][c] / A[c][c]; if (k) for (let j = c; j <= n; j += 1) A[r][j] -= k * A[c][j]; }
  }
  const exact = new Float64Array(n);
  for (let r = n - 1; r >= 0; r -= 1) { let s = A[r][n]; for (let j = r + 1; j < n; j += 1) s -= A[r][j] * exact[j]; exact[r] = s / A[r][r]; }
  const scale = Math.max(...exact.map(Math.abs));
  const error = () => { let e = 0; for (let y = 0; y < f.gh; y += 1) for (let x = 0; x < f.gw; x += 1) e = Math.max(e, Math.abs(f.psi[at(f, x, y)] - exact[y * f.gw + x])); return e / scale; };
  solve(f, 1);
  const one = error();
  solve(f, 7);
  const eight = error();
  assert.ok(one < 0.1, `one V cycle from zero: ${one}`);
  assert.ok(eight < 2e-5, `eight V cycles: relative error ${eight}`);
  // control: the oracle is another solution than that of a changed equation (a wall that lets psi through: ghost = +cell)
  assert.ok(Math.abs(f.psi[at(f, 0, 0)]) < 0.9 * scale && scale > 0);
  // the ghost cells mirror the border cells with the opposite sign: psi is zero on the walls
  assert.equal(f.psi[at(f, -1, 5)], -f.psi[at(f, 0, 5)]);
  assert.equal(f.psi[at(f, 3, f.gh)], -f.psi[at(f, 3, f.gh - 1)]);
  assert.equal(f.psi[at(f, -2, -1)], f.psi[at(f, 1, 0)]);
});

/** the first eigenfunction of the box: w = a sin(pi x / W) sin(pi y / H), psi = w / (pi^2 (1/W^2 + 1/H^2)): a steady flow (one big swirl) */
function eigen(f, a) {
  const W = f.cssWidth, H = f.cssHeight, k = Math.PI ** 2 * (1 / W ** 2 + 1 / H ** 2);
  for (let y = 0; y < f.gh; y += 1) for (let x = 0; x < f.gw; x += 1) f.w[at(f, x, y)] = a * Math.sin((Math.PI * (x + 0.5) * f.cellX) / W) * Math.sin((Math.PI * (y + 0.5) * f.cellY) / H);
  f.flowing = true; f.maxW = Math.abs(a);
  return {
    psi: (x, y) => (a / k) * Math.sin((Math.PI * x) / W) * Math.sin((Math.PI * y) / H),
    u: (x, y) => (a / k) * (Math.PI / H) * Math.sin((Math.PI * x) / W) * Math.cos((Math.PI * y) / H),
    v: (x, y) => -(a / k) * (Math.PI / W) * Math.cos((Math.PI * x) / W) * Math.sin((Math.PI * y) / H),
  };
}

test('an eigenfunction of the Laplacian: the solved psi and the B-spline velocity equal the analytic ones (within 1 %), and psi is 0 on the wall', () => {
  const f = createFluid(480, 320);
  const flow = eigen(f, 3);
  solve(f, 6);
  const field = packed(f);
  let worstPsi = 0, worstU = 0, top = 0;
  for (let j = 1; j < 16; j += 1) for (let i = 1; i < 24; i += 1) {
    const x = i * 20 + 3.3, y = j * 20 - 4.1;
    const s = read(f, field, x, y);
    let psi = 0;   // the B-spline of psi itself, by the packed channel
    { const g = fieldAt(field.map((v, k) => (k % 4 === 0 ? field[k + 2] : v)), 0, f.pw, f.ph, x / f.cellX - 0.5 + PAD, y / f.cellY - 0.5 + PAD); psi = g.dx; }
    worstPsi = Math.max(worstPsi, Math.abs(psi - flow.psi(x, y)));
    const u = s.py / f.cellY, v = -s.px / f.cellX;
    worstU = Math.max(worstU, Math.hypot(u - flow.u(x, y), v - flow.v(x, y)));
    top = Math.max(top, Math.hypot(flow.u(x, y), flow.v(x, y)));
  }
  assert.ok(worstPsi < 0.01 * flow.psi(240, 160), `psi off by ${worstPsi} of ${flow.psi(240, 160)}`);
  assert.ok(worstU < 0.01 * top, `velocity off by ${worstU} of ${top} px/s`);
  const wall = fieldAt(field.map((v, k) => (k % 4 === 0 ? field[k + 2] : v)), 0, f.pw, f.ph, -0.5 + PAD, 10.3 + PAD).dx;
  assert.ok(Math.abs(wall) < 1e-3 * flow.psi(240, 160), `psi on the left wall: ${wall}`);
});

test('the velocity is divergence free wherever it is read: no net flux through closed loops of a stirred flow; a gradient field (control) has one', () => {
  const f = createFluid(480, 320);
  stir(f, 150, 120, 300, 100, 40); stir(f, 330, 200, -200, 260, 32); stir(f, 240, 60, 0, -300, 48);
  solve(f, 6);
  const field = packed(f);
  const flux = (vel, x0, y0, x1, y1, n = 400) => {
    let sum = 0, size = 0;
    for (let i = 0; i < n; i += 1) {
      const tx = x0 + ((i + 0.5) / n) * (x1 - x0), ty = y0 + ((i + 0.5) / n) * (y1 - y0);
      const top = vel(tx, y0), bottom = vel(tx, y1), left = vel(x0, ty), right = vel(x1, ty);
      sum += ((bottom.y - top.y) * (x1 - x0) + (right.x - left.x) * (y1 - y0)) / n;
      size += ((Math.abs(bottom.y) + Math.abs(top.y)) * (x1 - x0) + (Math.abs(right.x) + Math.abs(left.x)) * (y1 - y0)) / n;
    }
    return { sum, size };
  };
  const curl = (x, y) => flowAt(f, field, x, y);
  const gradient = (x, y) => { const s = read(f, field, x, y); return { x: s.px / f.cellX, y: s.py / f.cellY }; };
  for (const [x0, y0, x1, y1] of [[100.3, 80.7, 200.1, 160.9], [133.7, 97.2, 171.4, 143.3], [20.5, 20.5, 460.2, 300.8], [300.2, 170.1, 360.6, 233.3]]) {
    const a = flux(curl, x0, y0, x1, y1);
    assert.ok(a.size > 100 && Math.abs(a.sum) < 2e-4 * a.size, `net flux ${a.sum} of ${a.size} through (${x0}, ${y0})-(${x1}, ${y1})`);
  }
  const b = flux(gradient, 133.7, 97.2, 171.4, 143.3);
  assert.ok(Math.abs(b.sum) > 0.05 * b.size, `control: the gradient of psi has a net flux (${b.sum} of ${b.size})`);
});

test('a push: the water at its centre takes the pushed velocity (within 15 %), a pair of opposite swirls either side, no net circulation', () => {
  const f = createFluid(1100, 620);
  stir(f, 550, 310, 120, 0, 32);
  let sum = 0, above = 0, below = 0;
  for (let y = 0; y < f.gh; y += 1) for (let x = 0; x < f.gw; x += 1) { const w = f.w[at(f, x, y)]; sum += w; if ((y + 0.5) * f.cellY < 310) above += w; else below += w; }
  // (y runs down the screen: a push to the right turns the water above it anticlockwise, w < 0, and the water below it clockwise)
  assert.ok(above < -1 && below > 1 && Math.abs(sum) < 0.02 * below, `swirls ${above} above and ${below} below the push, sum ${sum}`);
  solve(f, 6);
  const v = flowAt(f, packed(f), 550, 310);
  assert.ok(Math.abs(v.x - 120) < 18 && Math.abs(v.y) < 2, `centre velocity (${v.x}, ${v.y}) for a push of (120, 0)`);
  // far away the water hardly moves, and the other way (the return flow of a dipole)
  const far = flowAt(f, packed(f), 550, 150);
  assert.ok(far.x < 0 && far.x > -12, `return flow beside the push: ${far.x}`);
  step(f, NO_LOSS);
  const out = { x: 0, y: 0 };
  velocityAt(f, 550, 310, out);
  // (the velocity of the cell under the point, after the one V cycle of a step)
  assert.ok(Math.abs(out.x - 120) < 36 && Math.abs(out.y) < 15, `velocityAt after a step: ${out.x}, ${out.y}`);
});

test('the page moves with the water: after 0.3 s of a steady swirl the displacement equals x - X(x), with X traced back through the analytic flow (RK4); the oracle of another time does not fit (control)', () => {
  const f = createFluid(480, 320);
  const flow = eigen(f, 4);
  const steps = Math.round(0.3 * STEP_HZ);
  for (let i = 0; i < steps; i += 1) step(f, NO_LOSS);
  const field = packed(f);
  /** where the water now at (x, y) was `t` seconds ago */
  const back = (x, y, t, n = 200) => {
    const h = -t / n, fx = (X, Y) => flow.u(X, Y), fy = (X, Y) => flow.v(X, Y);
    for (let i = 0; i < n; i += 1) {
      const k1x = fx(x, y), k1y = fy(x, y);
      const k2x = fx(x + 0.5 * h * k1x, y + 0.5 * h * k1y), k2y = fy(x + 0.5 * h * k1x, y + 0.5 * h * k1y);
      const k3x = fx(x + 0.5 * h * k2x, y + 0.5 * h * k2y), k3y = fy(x + 0.5 * h * k2x, y + 0.5 * h * k2y);
      const k4x = fx(x + h * k3x, y + h * k3y), k4y = fy(x + h * k3x, y + h * k3y);
      x += (h / 6) * (k1x + 2 * k2x + 2 * k3x + k4x); y += (h / 6) * (k1y + 2 * k2y + 2 * k3y + k4y);
    }
    return { x, y };
  };
  let worst = 0, worstOther = 0, largest = 0;
  for (let j = 1; j < 8; j += 1) for (let i = 1; i < 12; i += 1) {
    const x = i * 40, y = j * 40;
    const s = read(f, field, x, y);
    const a = back(x, y, steps * DT), b = back(x, y, 0.5 * steps * DT);
    worst = Math.max(worst, Math.hypot(s.dx - (x - a.x), s.dy - (y - a.y)));
    worstOther = Math.max(worstOther, Math.hypot(s.dx - (x - b.x), s.dy - (y - b.y)));
    largest = Math.max(largest, Math.hypot(x - a.x, y - a.y));
  }
  assert.ok(largest > 30, `the swirl carries the page by up to ${largest} px`);
  assert.ok(worst < 0.03 * largest, `displacement off by ${worst} px of ${largest}`);
  assert.ok(worstOther > 10 * worst, `control: the displacement of half the time is off by ${worstOther} px`);
  // and the swirl itself is steady: the transport kept the vorticity where it was
  let drift = 0;
  for (let y = 0; y < f.gh; y += 1) for (let x = 0; x < f.gw; x += 1) drift = Math.max(drift, Math.abs(f.w[at(f, x, y)] - 4 * Math.sin((Math.PI * (x + 0.5)) / f.gw) * Math.sin((Math.PI * (y + 0.5)) / f.gh)));
  assert.ok(drift < 0.03 * 4, `the steady swirl drifted by ${drift} of 4`);
  // nothing crosses a wall: the displacement across each wall is zero on it
  const wallX = read(f, field, 0, 133).dx, wallY = read(f, field, 251, 320).dy;
  assert.ok(Math.abs(wallX) < 1e-4 && Math.abs(wallY) < 1e-4, `displacement across the walls: ${wallX}, ${wallY}`);
});

const sums = (f) => { let sum = 0, abs = 0, max = 0, energy = 0; for (let y = 0; y < f.gh; y += 1) for (let x = 0; x < f.gw; x += 1) { const i = at(f, x, y), w = f.w[i]; sum += w; abs += Math.abs(w); max = Math.max(max, Math.abs(w)); energy += (f.uc[i] * f.cellX) ** 2 + (f.vc[i] * f.cellY) ** 2; } return { sum, abs, max, energy }; };
const strokes = (f, k = 1) => { for (let i = 0; i < 30; i += 1) stir(f, 100 + 10 * i, 150 + 40 * Math.sin(i / 4), 60 * k, 45 * k * Math.cos(i / 4), 32); };

test('vorticity confinement never feeds the flow: at any strength the largest |w| does not grow and the water gets no faster; it keeps a swirl tighter than no confinement (control)', () => {
  for (const eps of [3, 30, 300]) {
    const f = createFluid(480, 320);
    strokes(f);
    const before = sums(f);
    let top = before.max, speed = 0, first = 0;
    for (let i = 0; i < 240; i += 1) {
      step(f, { ...NO_LOSS, confine: eps });
      if (i === 0) first = f.maxSpeed;
      const s = sums(f);
      assert.ok(s.max <= top * (1 + 1e-6), `eps ${eps}, step ${i}: max |w| ${s.max} above ${top}`);
      top = s.max;
      speed = Math.max(speed, f.maxSpeed);
    }
    const after = sums(f);
    assert.ok(after.abs < 1.1 * before.abs, `eps ${eps}: sum |w| ${before.abs} -> ${after.abs}`);
    assert.ok(speed < 1.25 * first && Number.isFinite(after.energy), `eps ${eps}: the fastest water moved at ${speed} px/s (${first} in the first step)`);
  }
  const tight = (eps) => { const f = createFluid(480, 320); strokes(f); for (let i = 0; i < 180; i += 1) step(f, { ...NO_LOSS, confine: eps }); return sums(f).max; };
  const none = tight(0), some = tight(3);
  assert.ok(some > 1.1 * none, `after 1.5 s the strongest swirl has |w| ${some} with confinement, ${none} without`);
});

test('the flow dies out and comes to exact rest: the kinetic energy never grows once the stirring stops, and after a finite time every field is exactly zero', () => {
  const f = createFluid(1100, 620);
  strokes(f, 3);
  let energy = Infinity, steps = 0, rises = 0, flowEnd = 0, shift = 0;
  while (!quiet(f) && steps < 1200) {
    step(f, DEFAULTS);
    steps += 1;
    const e = sums(f).energy;
    if (steps > 2 && e > energy * 1.02) rises += 1;
    if (steps > 1) energy = e;
    if (f.flowing) flowEnd = steps;
    shift = Math.max(shift, f.maxShift);
  }
  assert.ok(shift > 20, `the strokes displaced the page by up to ${shift} px`);
  assert.equal(rises, 0, 'the kinetic energy never rose by more than 2 % in a step');
  assert.ok(quiet(f) && steps < 5 * STEP_HZ, `at rest after ${steps / STEP_HZ} s (the flow after ${flowEnd / STEP_HZ} s)`);
  for (const name of ['w', 'psi', 'dx', 'dy', 'uc', 'vc']) assert.ok(f[name].every((v) => v === 0), `${name} is exactly zero at rest`);
  assert.ok(f.box[0] > f.box[2], 'the box of the displacement is empty');
  assert.equal(f.maxSpeed, 0); assert.equal(f.maxShift, 0);
  // a step at rest changes nothing
  step(f, DEFAULTS);
  assert.ok(quiet(f));
  // control: without the constant losses the same flow is still moving at that time
  const g = createFluid(1100, 620);
  strokes(g, 3);
  for (let i = 0; i < steps; i += 1) step(g, { ...DEFAULTS, friction: 0, stick: 0 });
  assert.ok(!quiet(g) && g.flowing, 'control: with drag alone the flow has not stopped');
  assert.ok(W_FRICTION > 0 && STICK_PX_S > 0);
});

test('the page holds still where the water is slow: a gentle push displaces a bounded region (the box), and outside it the displacement is exactly zero', () => {
  const f = createFluid(1100, 620);
  stir(f, 300, 300, 80, 0, 32);
  for (let i = 0; i < 20; i += 1) step(f, DEFAULTS);
  assert.ok(f.moved && f.maxShift > 2, `the push displaced the page by ${f.maxShift} px`);
  const [x0, y0, x1, y1] = f.box;
  assert.ok(x0 > PAD && y0 > PAD && x1 < f.pw - 1 - PAD - 20 && y1 < f.ph - 1 - PAD, `box ${[...f.box]} of ${f.pw} x ${f.ph}`);
  let outside = 0, inside = 0;
  for (let y = 0; y < f.ph; y += 1) for (let x = 0; x < f.pw; x += 1) {
    const moved = f.dx[y * f.pw + x] !== 0 || f.dy[y * f.pw + x] !== 0;
    if (x < x0 || x > x1 || y < y0 || y > y1) outside += moved ? 1 : 0; else inside += moved ? 1 : 0;
  }
  assert.equal(outside, 0);
  assert.ok(inside > 20);
  // the water itself moves well beyond the box (slower than the page lets go)
  const out = { x: 0, y: 0 };
  velocityAt(f, (x1 - PAD + 6) * f.cellX, 300, out);
  assert.ok(Math.hypot(out.x, out.y) > 0 && Math.hypot(out.x, out.y) < STICK_PX_S * 2, `water beyond the box: ${Math.hypot(out.x, out.y)} px/s`);
  clear(f);
  assert.ok(quiet(f) && f.dx.every((v) => v === 0) && f.w.every((v) => v === 0));
});

// ---- the B-spline read against an independent oracle: the centred cubic B-spline basis, its derivative by central differences ----
const B3 = (t) => { const a = Math.abs(t); return a < 1 ? 2 / 3 - a * a + (a * a * a) / 2 : a < 2 ? ((2 - a) ** 3) / 6 : 0; };
function oracleRead(field, offset, pw, ph, gx, gy, channel) {
  let v = 0;
  for (let j = Math.floor(gy) - 1; j <= Math.floor(gy) + 2; j += 1) for (let i = Math.floor(gx) - 1; i <= Math.floor(gx) + 2; i += 1) {
    v += field[offset + (Math.min(ph - 1, Math.max(0, j)) * pw + Math.min(pw - 1, Math.max(0, i))) * CHANNELS + channel] * B3(gx - i) * B3(gy - j);
  }
  return v;
}

test('fieldAt equals the independent B-spline oracle: the displacement, and the gradient of psi by central differences of the oracle', () => {
  const f = createFluid(480, 320);
  strokes(f, 2);
  for (let i = 0; i < 40; i += 1) step(f, DEFAULTS);
  const field = packed(f);
  let moved = 0;
  for (let j = 0; j <= 20; j += 1) for (let i = 0; i <= 30; i += 1) {
    const gx = (i / 30) * f.gw - 0.5 + PAD, gy = (j / 20) * f.gh - 0.5 + PAD, e = 1e-3;
    const s = fieldAt(field, 0, f.pw, f.ph, gx, gy);
    assert.ok(Math.abs(s.dx - oracleRead(field, 0, f.pw, f.ph, gx, gy, 0)) < 1e-4 && Math.abs(s.dy - oracleRead(field, 0, f.pw, f.ph, gx, gy, 1)) < 1e-4);
    const px = (oracleRead(field, 0, f.pw, f.ph, gx + e, gy, 2) - oracleRead(field, 0, f.pw, f.ph, gx - e, gy, 2)) / (2 * e);
    const py = (oracleRead(field, 0, f.pw, f.ph, gx, gy + e, 2) - oracleRead(field, 0, f.pw, f.ph, gx, gy - e, 2)) / (2 * e);
    const scale = 1 + Math.abs(px) + Math.abs(py);
    // (the floor of gx differs between gx - e and gx + e at a cell centre: the oracle's difference is then across a knot, still within e)
    assert.ok(Math.abs(s.px - px) < 2e-3 * scale && Math.abs(s.py - py) < 2e-3 * scale, `gradient of psi at (${gx}, ${gy}): ${s.px}, ${s.py} vs ${px}, ${py}`);
    if (Math.hypot(s.dx, s.dy) > 0.5) moved += 1;
  }
  assert.ok(moved > 100, `the field really displaces (${moved} points by more than 0.5 px)`);
});
