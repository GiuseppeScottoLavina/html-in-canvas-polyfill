import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRate, CostBudget, PhaseGate, planGeometry, sameGeometry, tileRect } from '../../../src/snapshot/store/pump.js';
import { chooseScale } from '../../../src/snapshot/store/surfaces.js';

const options = { maxDpr: 2.5, maxSurfacePixels: 33554432, maxTotalSurfaceBytes: 536870912, inkMargin: 24, interactionFloorFps: 0, maxSnapshotFps: 60 };
const ink = { left: 24, top: 24, right: 24, bottom: 24 };
const geo = { bw: 100, bh: 100, scale: 2, reduced: false, ink, widthPx: 296, heightPx: 296 };

test('tileRect: null stays whole, small damage is grown by the margin and rounded out to whole surface pixels', () => {
  assert.equal(tileRect(null, geo, 2), null);
  assert.deepEqual(tileRect({ x: 10, y: 10, width: 10, height: 10 }, geo, 2), { x: 8, y: 8, width: 14, height: 14 });
  const t = tileRect({ x: 10.3, y: 10.3, width: 10, height: 10 }, geo, 2);
  assert.ok(Number.isInteger(Math.round((t.x + 24) * 2 * 1e6) / 1e6) && Number.isInteger(Math.round((t.width) * 2 * 1e6) / 1e6), 'edges sit on surface pixels');
  assert.ok(t.x <= 10.3 - 2 && t.x + t.width >= 20.3 + 2, 'covers the damage plus margin');
});

test('tileRect: damage above 55 percent of the surface becomes a full tile; a rect outside the surface is whole too', () => {
  assert.equal(tileRect({ x: -24, y: -24, width: 148, height: 148 }, geo, 2), null);
  assert.equal(tileRect({ x: 0, y: 0, width: 100, height: 60 }, geo, 2) === null, false, 'below the threshold stays a tile');
  assert.equal(tileRect({ x: 500, y: 500, width: 5, height: 5 }, geo, 2), null);
});

test('tileRect: the tile is clipped to the surface', () => {
  const t = tileRect({ x: -24, y: -24, width: 30, height: 30 }, geo, 2);
  assert.equal(t.x, -24);
  assert.equal(t.y, -24);
});

test('buildRate: min(frameCap raised by the interaction floor, maxSnapshotFps)', () => {
  const rec = (frameCap) => ({ frameCap });
  assert.equal(buildRate(options, rec(0), { interaction: false }), 60);
  assert.equal(buildRate(options, rec(30), { interaction: false }), 30);
  assert.equal(buildRate(options, rec(120), { interaction: false }), 60);
  assert.equal(buildRate({ ...options, interactionFloorFps: 60 }, rec(10), { interaction: true }), 60);
  assert.equal(buildRate({ ...options, interactionFloorFps: 60 }, rec(10), { interaction: false }), 10, 'the floor needs input-driven damage');
  assert.equal(buildRate({ ...options, interactionFloorFps: 60 }, rec(10), { interaction: true }) > 10, true);
  assert.equal(buildRate({ ...options, maxSnapshotFps: 0 }, rec(0), { interaction: false }), Infinity);
});

test('CostBudget: refills at the share, goes negative on overspend and says how long to wait', () => {
  const b = new CostBudget();
  b.refill(0, 0.35);
  assert.equal(b.canStart(), true);
  b.spend(40);
  assert.equal(b.canStart(), false);
  const wait = b.waitMs(0.35);
  assert.ok(wait > 0);
  b.refill(wait + 1, 0.35);
  assert.equal(b.canStart(), true);
  b.refill(1e9, 0.35);
  assert.ok(b.level <= 0.35 * 60 + 1e-9, 'capped, no unbounded credit');
});

test('PhaseGate: phase-accumulator pacing without drift and resync after a long stall', () => {
  const g = new PhaseGate();
  const interval = 1000 / 60;
  assert.equal(g.isDue(0, interval), true);
  g.started(0, interval);
  assert.equal(g.isDue(5, interval), false);
  assert.equal(g.isDue(interval - 1, interval), true, 'tolerance of a few ms');
  g.started(17, interval);
  g.started(33, interval);
  assert.ok(Math.abs(g.next - 3 * interval) < 1e-9, 'the phase advances by whole intervals');
  g.started(1000, interval);
  assert.equal(g.next, 1000 + interval, 'a stall of more than two intervals resynchronises');
  assert.equal(g.isDue(1, 0), true, 'interval 0 = uncapped');
});

test('sameGeometry compares size, scale, pixel size and ink origin', () => {
  assert.equal(sameGeometry(geo, { ...geo }), true);
  assert.equal(sameGeometry(geo, { ...geo, bw: 100.5 }), false);
  assert.equal(sameGeometry(geo, { ...geo, scale: 2.5 }), false);
  assert.equal(sameGeometry(geo, { ...geo, widthPx: 297 }), false);
  assert.equal(sameGeometry(geo, null), false);
});

test('planGeometry: whole-pixel surface of border box + ink at the grid scale', () => {
  const g = planGeometry({ options }, { contentBox: { gridScaleX: 2 } }, { width: 100.2, height: 50 }, 0);
  assert.equal(g.scale, 2);
  assert.equal(g.widthPx, Math.ceil((100.2 + 48) * 2 - 1e-6));
  assert.equal(g.heightPx, (50 + 48) * 2);
  assert.equal(g.reduced, false);
});

test('planGeometry: measured ink overflow widens the surface on the sides that reach past the margin (ink-overflow), capped; smaller ink keeps the margin', () => {
  const layer = { inkOverflow: () => ({ left: 3, top: 40.2, right: 100, bottom: 1e9 }) };
  const g = planGeometry({ options }, { contentBox: { gridScaleX: 1 }, layer }, { width: 100, height: 50 }, 0, /** @type {any} */ ({}));
  assert.deepEqual(g.ink, { left: 24, top: 41, right: 100, bottom: 2048 });
  assert.equal(g.widthPx, 100 + 24 + 100);
  assert.equal(g.heightPx, 50 + 41 + 2048);
  const plain = planGeometry({ options }, { contentBox: { gridScaleX: 1 }, layer }, { width: 100, height: 50 }, 0);
  assert.deepEqual(plain.ink, ink, 'without the element the fixed margin is used');
});

test('chooseScale: clamps the grid scale into [1, maxDpr]', () => {
  const box = { width: 100, height: 100 };
  assert.equal(chooseScale(box, ink, 5, options).scale, 2.5);
  assert.equal(chooseScale(box, ink, 0.5, options).scale, 1);
  assert.equal(chooseScale(box, ink, NaN, options).scale, 1);
  assert.equal(chooseScale(box, ink, 2, options).reduced, false);
});

test('chooseScale: reduced to fit the per-drawable pixel budget, flagged', () => {
  const r = chooseScale({ width: 1440, height: 900 }, ink, 3, { ...options, maxDpr: 3, maxSurfacePixels: 4_000_000 });
  assert.equal(r.reduced, true);
  assert.ok(Math.ceil(1488 * r.scale) * Math.ceil(948 * r.scale) <= 4_000_000);
  assert.ok(r.scale >= 1 && r.scale < 3);
});

test('chooseScale: total-byte aware, other surfaces use the budget first', () => {
  const o = { ...options, maxDpr: 3, maxTotalSurfaceBytes: 100 * 1024 * 1024 };
  const alone = chooseScale({ width: 1440, height: 900 }, ink, 3, o, 0);
  const crowded = chooseScale({ width: 1440, height: 900 }, ink, 3, o, 60 * 1024 * 1024);
  assert.equal(alone.reduced, false, '50.8 MB fits a 100 MB budget alone');
  assert.equal(crowded.reduced, true);
  assert.ok(crowded.scale < 3 && crowded.scale >= 1);
  assert.throws(() => chooseScale({ width: 1440, height: 900 }, ink, 3, o, 100 * 1024 * 1024), (e) => e.name === 'NotSupportedError' && e.feature === 'surface-size');
});

test('G-soak (pure): 30 full-canvas drawables at DPR 3 never exceed maxTotalSurfaceBytes; what does not fit is refused loudly', () => {
  const o = { ...options, maxDpr: 3, maxTotalSurfaceBytes: 512 * 1024 * 1024 };
  let used = 0;
  let reduced = 0;
  let refused = 0;
  for (let i = 0; i < 30; i++) {
    try {
      const { scale, reduced: r } = chooseScale({ width: 1440, height: 900 }, ink, 3, o, used);
      used += Math.ceil(1488 * scale) * Math.ceil(948 * scale) * 4;
      if (r) reduced++;
    } catch (e) {
      assert.equal(e.feature, 'surface-size');
      refused++;
    }
  }
  assert.ok(used <= o.maxTotalSurfaceBytes, `${used} > budget`);
  assert.ok(reduced > 0 || refused > 0, 'later drawables were reduced or refused instead of blowing the budget');
});

test('G-soak (pure): 30 card-sized drawables at DPR 3 all fit unreduced', () => {
  const o = { ...options, maxDpr: 3, maxTotalSurfaceBytes: 512 * 1024 * 1024 };
  let used = 0;
  for (let i = 0; i < 30; i++) {
    const r = chooseScale({ width: 400, height: 300 }, ink, 3, o, used);
    assert.equal(r.reduced, false);
    used += Math.ceil(448 * r.scale) * Math.ceil(348 * r.scale) * 4;
  }
  assert.ok(used < o.maxTotalSurfaceBytes);
});
