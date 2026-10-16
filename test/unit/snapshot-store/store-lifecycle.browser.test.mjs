import { test, assert, sleep } from '/test/unit/lib/t.js';
import { pixel, RGBA, until, makeRig } from './helpers.mjs';

const A = { x: 10, y: 10, width: 20, height: 20 };
const lose = (surface) => surface.dispatchEvent(new Event('contextlost', { cancelable: true }));
const restore = (surface) => surface.dispatchEvent(new Event('contextrestored'));

test('context loss: builds pause while lost, restore queues a whole re-raster and announces it; the blank surface is repainted', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 100, 60);
  await rig.build(a);
  const surface = rig.store.version(a).surface;
  const restored = [];
  rig.bus.on(rig.BUS.SURFACE_RESTORED, (e) => restored.push(e));
  lose(surface);
  assert.equal(rig.reports.unsupported.at(-1).feature, 'context-loss');
  const calls = rig.calls.length;
  rig.store.markDamage(a, A, 'input');
  assert.equal(rig.pump().started, 0);
  assert.equal(rig.calls.length, calls, 'no build while the context is lost');
  surface.getContext('2d').clearRect(0, 0, surface.width, surface.height);
  restore(surface);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].element, a);
  assert.equal(restored[0].record, rig.record);
  assert.equal(rig.store.stats().surfaceRestores, 1);
  assert.equal(rig.store.isSettled(a), false);
  assert.equal(rig.pump().started, 1);
  await until(() => rig.store.hasLanded());
  assert.deepEqual(rig.store.commitLanded().changed, [a]);
  assert.deepEqual(rig.css(a, 50, 30), RGBA.red, 'non-blank again');
  assert.equal(rig.calls.at(-1).rect, null, 'the re-raster is a whole-drawable tile');
});

test('context loss while a full tile is in flight: it lands on a fresh surface and recovers at once', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 100, 60);
  await rig.build(a);
  const old = rig.store.version(a).surface;
  rig.deferDecode = true;
  rig.color = 'lime';
  rig.store.markDamage(a, null, 'forced');
  rig.pump();
  lose(old);
  await rig.release();
  assert.deepEqual(rig.store.commitLanded().changed, [a]);
  const v = rig.store.version(a);
  assert.notEqual(v.surface, old);
  assert.deepEqual(rig.css(a, 50, 30), RGBA.lime);
  const restored = [];
  rig.bus.on(rig.BUS.SURFACE_RESTORED, (e) => restored.push(e));
  restore(old);
  assert.equal(restored.length, 0, 'the replaced surface is no longer watched');
  rig.deferDecode = false;
  await rig.build(a, A);
  assert.equal(rig.store.version(a).surface, v.surface, 'builds run again on the new surface');
});

test('resize publishes a metadata-only version at once (same pixels, no blank), then re-rasters at the new size', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 100, 60);
  await rig.build(a);
  const v1 = rig.store.version(a);
  rig.bus.emit(rig.BUS.RESIZE, { record: rig.record, contentBox: { width: 800, height: 600, gridScaleX: 1, gridScaleY: 1 }, previous: rig.record.contentBox });
  assert.equal(rig.store.hasLanded(), true);
  const cs = rig.store.commitLanded();
  assert.deepEqual(cs.changed, [a]);
  const v2 = rig.store.version(a);
  assert.notEqual(v2.id, v1.id);
  assert.equal(v2.surface, v1.surface, 'metadata only');
  assert.equal(v2.canvasWidth, 800);
  assert.equal(v2.canvasHeight, 600);
  assert.deepEqual(rig.css(a, 50, 30), RGBA.red);
  assert.equal(rig.store.isSettled(a), false, 'structural damage waits for the re-raster');
  assert.equal(rig.commits.at(-1).changed[0], a);
  rig.setSize(a, 120, 80);
  rig.color = 'lime';
  await rig.build(a);
  const v3 = rig.store.version(a);
  assert.equal(v3.width, 120);
  assert.equal(v3.surface.width, 128);
  assert.equal(rig.calls.at(-1).rect, null);
  assert.deepEqual(rig.css(a, 100, 70), RGBA.lime);
});

test('regression: a surface planned from a layout read that was a fraction of a pixel off is re-rastered one pump after the commit (no damage follows an idle page)', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 100.4, 60); // the read taken while a stale hit-test transform was still applied
  await rig.build(a);
  const first = rig.store.version(a);
  assert.equal(first.surface.width, Math.ceil((100.4 + 2 * rig.INK) * rig.scale - 1e-6));
  rig.setSize(a, 100, 60); // the layout read after the paint handler refreshed the geometry
  rig.store.pump(performance.now(), { mainThreadMs: 100, mainThreadShare: 1, maxInFlight: 2, interaction: false });
  assert.equal(rig.store.isSettled(a), false, 'the geometry check marked the drawable for a re-raster');
  await rig.build(a);
  assert.equal(rig.store.version(a).surface.width, Math.ceil((100 + 2 * rig.INK) * rig.scale - 1e-6), 'the surface now has the size of the final layout');
});

test('a metadata-only version shares the surface and its pin: the next commit forks it', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 100, 60);
  await rig.build(a);
  const pinned = rig.store.pin(a);
  rig.bus.emit(rig.BUS.RESIZE, { record: rig.record, contentBox: { width: 500, height: 300, gridScaleX: 1, gridScaleY: 1 }, previous: rig.record.contentBox });
  rig.store.commitLanded();
  rig.store.markDamage(a, null, 'forced');
  rig.color = 'lime';
  await rig.build(a, A);
  const v = rig.store.version(a);
  assert.notEqual(v.surface, pinned.surface);
  assert.deepEqual(pixel(pinned.surface, 24, 24), RGBA.red);
  rig.store.unpin(pinned);
});

test('DPR change re-rasters every drawable at the new scale', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 100, 60);
  await rig.build(a);
  assert.equal(rig.store.version(a).scale, 1);
  rig.record.contentBox.gridScaleX = 2;
  rig.bus.emit(rig.BUS.DPR, { dpr: 2 });
  assert.equal(rig.store.isSettled(a), false);
  await rig.build(a);
  const v = rig.store.version(a);
  assert.equal(v.scale, 2);
  assert.equal(v.surface.width, 216);
  assert.equal(rig.calls.at(-1).scale, 2);
});

test('an element removed from the drawables loses its snapshot: version null, listed in removed once, pin throws', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 100, 60);
  await rig.build(a);
  rig.remove(a);
  assert.equal(rig.store.version(a), null);
  assert.equal(rig.store.has(a), false);
  assert.equal(rig.store.hasLanded(), true);
  const cs = rig.store.commitLanded();
  assert.deepEqual(cs, { changed: [], removed: [a] });
  assert.deepEqual(rig.commits.at(-1).removed, [a]);
  assert.deepEqual(rig.store.commitLanded(), { changed: [], removed: [] });
  let err = null;
  try { rig.store.pin(a); } catch (e) { err = e; }
  assert.equal(err?.name, 'InvalidStateError');
});

test('a result that lands for a removed drawable is discarded', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 100, 60);
  rig.deferDecode = true;
  rig.store.markDamage(a, null, 'forced');
  rig.pump();
  rig.remove(a);
  await rig.release();
  assert.equal(rig.store.hasLanded(), false);
  assert.deepEqual(rig.store.commitLanded(), { changed: [], removed: [] });
  assert.equal(rig.store.version(a), null);
});

test('display:none (not laid out) drops the snapshot; showing it again builds a first version', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 100, 60);
  await rig.build(a);
  rig.hide(a);
  rig.store.markDamage(a, null, 'mutation');
  rig.pump();
  assert.equal(rig.store.version(a), null);
  assert.deepEqual(rig.store.commitLanded(), { changed: [], removed: [a] });
  assert.equal(rig.store.isPaintReady(rig.record).reason, 'no-drawables', 'a drawable without a CSS box does not block the paint');
  rig.show(a);
  assert.equal(rig.store.isPaintReady(rig.record).reason, 'first-commit');
  rig.color = 'lime';
  await rig.build(a, null, 'mutation');
  assert.deepEqual(rig.css(a, 50, 30), RGBA.lime);
});

test('forget(record) releases everything silently', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 100, 60);
  const b = rig.add('b', 100, 60);
  await rig.build(a);
  await rig.build(b);
  rig.store.commitLanded();
  assert.notEqual(rig.store.version(a), null);
  rig.store.forget(rig.record);
  assert.equal(rig.store.has(a), false);
  assert.equal(rig.store.version(b), null);
  assert.deepEqual(rig.store.commitLanded(), { changed: [], removed: [] });
  assert.equal(rig.store.stats().surfaces, 0);
});

test('CANVAS_UNMOUNTING forgets the record; dispose detaches the bus', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 100, 60);
  await rig.build(a);
  rig.bus.emit(rig.BUS.CANVAS_UNMOUNTING, { record: rig.record });
  assert.equal(rig.store.has(a), false);
  rig.store.dispose();
  rig.bus.emit(rig.BUS.DRAWABLES_CHANGED, { record: rig.record, added: [a], removed: [] });
  assert.equal(rig.store.has(a), false);
});

test('isPaintReady: coherence while a build of the same pump round is still decoding', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 60, 40);
  const b = rig.add('b', 60, 40);
  await rig.build(a);
  await rig.build(b);
  rig.deferDecode = true;
  rig.store.markDamage(a, null, 'input');
  rig.store.markDamage(b, null, 'input');
  assert.equal(rig.pump().started, 2);
  assert.equal(rig.store.isPaintReady(rig.record).ready, true, 'nothing landed yet');
  await rig.release(0);
  assert.deepEqual(rig.store.isPaintReady(rig.record), { ready: false, reason: 'coherence' });
  rig.options.coherentPaint = false;
  assert.equal(rig.store.isPaintReady(rig.record).ready, true);
  rig.options.coherentPaint = true;
  await rig.release(0);
  assert.deepEqual(rig.store.isPaintReady(rig.record), { ready: true, reason: 'ready' });
  assert.deepEqual(rig.store.commitLanded().changed, [a, b]);
});

test('the first tile waits for fonts/images (complete:false) up to paintGateMaxWaitMs, then commits anyway', async (t) => {
  const rig = await makeRig(t, { options: { paintGateMaxWaitMs: 150 } });
  const a = rig.add('a', 100, 60);
  rig.color = 'lime';
  rig.script.push({ complete: false });
  rig.store.markDamage(a, null, 'forced');
  rig.pump();
  await sleep(60);
  assert.equal(rig.store.hasLanded(), false, 'held');
  assert.deepEqual(rig.store.commitLanded(), { changed: [], removed: [] });
  assert.equal(rig.store.version(a), null);
  assert.equal(rig.store.isSettled(a), false);
  await until(() => rig.store.hasLanded(), 1000, 'the hold to expire');
  assert.deepEqual(rig.store.commitLanded().changed, [a]);
  assert.deepEqual(rig.css(a, 50, 30), RGBA.lime);
});

test('a complete tile supersedes a held incomplete one; a later incomplete tile is not held', async (t) => {
  const rig = await makeRig(t, { options: { paintGateMaxWaitMs: 5000 } });
  const a = rig.add('a', 100, 60);
  rig.script.push({ complete: false, color: 'lime' }, { complete: true, color: 'blue' });
  rig.store.markDamage(a, null, 'forced');
  rig.pump();
  await sleep(80);
  assert.equal(rig.store.hasLanded(), false);
  rig.store.markDamage(a, null, 'resource');
  rig.pump();
  await until(() => rig.store.hasLanded());
  assert.deepEqual(rig.store.commitLanded().changed, [a]);
  assert.deepEqual(rig.css(a, 50, 30), RGBA.blue);
  assert.equal(rig.store.stats().commits, 1, 'one version for the round');
  rig.script.push({ complete: false, color: 'lime' });
  await rig.build(a, A);
  assert.deepEqual(rig.css(a, 20, 20), RGBA.lime, 'not the first tile: committed right away');
});

test('onUnsupportedContent placeholder: unsupported entries are forwarded to the reporter and the tile commits', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 100, 60);
  rig.script.push({ unsupported: [{ feature: 'iframe', message: 'no iframes', path: 'div > iframe', t: 0, count: 1 }] });
  const cs = await rig.build(a);
  assert.deepEqual(cs.changed, [a]);
  assert.equal(rig.reports.unsupported.at(-1).feature, 'iframe');
});

test('onUnsupportedContent abort: the tile is reported but not committed', async (t) => {
  const rig = await makeRig(t, { options: { onUnsupportedContent: 'abort' } });
  const a = rig.add('a', 100, 60);
  rig.script.push({ unsupported: [{ feature: 'iframe', message: 'no iframes', t: 0, count: 1 }] });
  const cs = await rig.build(a);
  assert.deepEqual(cs, { changed: [], removed: [] });
  assert.equal(rig.store.version(a), null);
  assert.equal(rig.reports.unsupported.at(-1).feature, 'iframe');
});

test('onUnsupportedContent abort: a limited feature (video-controls) is reported but the tile still commits', async (t) => {
  const rig = await makeRig(t, { options: { onUnsupportedContent: 'abort' } });
  const a = rig.add('a', 100, 60);
  rig.script.push({ unsupported: [{ feature: 'video-controls', message: 'no control bar', t: 0, count: 1 }] });
  const cs = await rig.build(a);
  assert.deepEqual(cs.changed, [a]);
  assert.equal(rig.reports.unsupported.at(-1).feature, 'video-controls');
});

test('a drawable that cannot fit the surface budget is refused loudly, does not block the paint, and is retried after a resize', async (t) => {
  const rig = await makeRig(t, { options: { maxSurfacePixels: 500 } });
  const a = rig.add('a', 100, 60);
  rig.store.markDamage(a, null, 'forced');
  assert.equal(rig.pump().started, 0);
  assert.equal(rig.reports.unsupported.at(-1).feature, 'surface-size');
  assert.equal(rig.calls.length, 0);
  assert.equal(rig.store.isPaintReady(rig.record).ready, true);
  rig.options.maxSurfacePixels = 33554432;
  rig.store.markDamage(a, null, 'resize');
  await rig.damageAndPump(a, null, 'resize');
  assert.deepEqual(rig.store.commitLanded().changed, [a]);
});

test('a surface reduced to the pixel budget is rasterised at a lower scale and reported once', async (t) => {
  const rig = await makeRig(t, { scale: 2, options: { maxSurfacePixels: 12000 } });
  const a = rig.add('a', 100, 60);
  await rig.build(a);
  await rig.build(a, null, 'mutation');
  const v = rig.store.version(a);
  assert.ok(v.scale < 2 && v.scale >= 1);
  assert.ok(v.surface.width * v.surface.height <= 12000);
  assert.equal(rig.reports.unsupported.filter((e) => e.feature === 'surface-size').length, 1);
  assert.equal(rig.calls.at(-1).scale, v.scale);
});

test('pump: one build in flight per drawable; damage during a decode waits for the next pump', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 100, 60);
  await rig.build(a);
  rig.deferDecode = true;
  rig.store.markDamage(a, A, 'input');
  assert.equal(rig.pump().started, 1);
  rig.store.markDamage(a, A, 'input');
  assert.equal(rig.pump().started, 0);
  assert.equal(rig.calls.length, 2);
  await rig.release();
  rig.store.commitLanded();
  rig.deferDecode = false;
  assert.equal(rig.pump().started, 1);
});

test('pump: the main-thread budget counts the tile cost and delays the next build instead of dropping it', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 100, 60);
  const budget = { ...rig.budget, mainThreadShare: 0.001 };
  rig.store.markDamage(a, null, 'forced');
  assert.equal(rig.pump(budget).started, 1, 'the first build always starts');
  await until(() => rig.store.hasLanded());
  rig.store.commitLanded();
  rig.store.markDamage(a, A, 'input');
  const r = rig.pump(budget);
  assert.equal(r.started, 0);
  assert.equal(r.moreWork, true);
  assert.ok(r.nextDueAt > performance.now(), 'tells the scheduler when to come back');
  const later = rig.store.pump(performance.now() + 1e7, budget);
  assert.equal(later.started, 1);
});

test('pump: drawables without a snapshot are all built in the first pump whatever maxInFlight and the measured time (each one holds back the first paint); with a snapshot both apply again', async (t) => {
  const rig = await makeRig(t);
  const els = ['a', 'b', 'c', 'd', 'e'].map((id) => rig.add(id, 40, 30));
  const budget = { ...rig.budget, mainThreadMs: 1, maxInFlight: 2 };
  rig.deferDecode = true;
  for (const el of els) {
    rig.script.push({ busyMs: 2 });
    rig.store.markDamage(el, null, 'forced');
  }
  assert.equal(rig.pump(budget).started, 5, 'five first builds in one pump (WPT onpaint-remove-drawable-element: 8 drawables took 4 rounds two frames apart)');
  while (rig.pending.length) await rig.release();
  await until(() => rig.store.hasLanded());
  assert.equal(rig.store.commitLanded().changed.length, 5);
  for (const el of els) rig.store.markDamage(el, null, 'input');
  assert.equal(rig.pump({ ...budget, mainThreadMs: 1000 }).started, 2, 'maxInFlight caps the builds of drawables that have a snapshot');
  while (rig.pending.length) await rig.release();
  rig.store.commitLanded();
  for (const el of els) {
    rig.script.push({ busyMs: 2 });
    rig.store.markDamage(el, null, 'input');
  }
  assert.equal(rig.pump(budget).started, 1, 'and so does the measured time of the pump');
});

test('pump: a first build is charged its fixed estimate, not its measured cost: a slow (cold) first snapshot does not hold back the next build', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 40, 30);
  const budget = { ...rig.budget, mainThreadShare: 0.35 };
  const t0 = performance.now();
  rig.script.push({ busyMs: 40 });
  rig.store.markDamage(a, null, 'forced');
  assert.equal(rig.store.pump(t0, budget).started, 1);
  await until(() => rig.store.hasLanded());
  rig.store.commitLanded();
  rig.script.push({ busyMs: 40 });
  rig.store.markDamage(a, A, 'input');
  assert.equal(rig.store.pump(t0, budget).started, 1, 'the bucket (21 ms) was charged 3 ms, not the 40 ms the first build took');
  await until(() => rig.store.hasLanded());
  rig.store.commitLanded();
  rig.store.markDamage(a, A, 'input');
  assert.equal(rig.store.pump(t0, budget).started, 0, 'a later build is charged what it measured');
});

test('pump: the per-canvas frame cap spaces build starts (phase accumulator)', async (t) => {
  const rig = await makeRig(t);
  rig.record.frameCap = 10;
  const a = rig.add('a', 100, 60);
  const t0 = performance.now();
  rig.store.markDamage(a, null, 'forced');
  assert.equal(rig.store.pump(t0, rig.budget).started, 1);
  await until(() => rig.store.hasLanded());
  rig.store.commitLanded();
  rig.store.markDamage(a, A, 'input');
  const early = rig.store.pump(t0 + 20, rig.budget);
  assert.equal(early.started, 0);
  assert.equal(early.moreWork, true);
  assert.ok(Math.abs(early.nextDueAt - (t0 + 100 - 3)) < 1, `next due at the cap boundary, got ${early.nextDueAt - t0}`);
  assert.equal(rig.store.pump(t0 + 101, rig.budget).started, 1);
});

test('stats: percentiles, counters and byte accounting are populated', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 100, 60);
  const b = rig.add('b', 50, 50);
  await rig.build(a);
  await rig.build(b);
  await rig.build(a, A);
  const s = rig.store.stats();
  assert.equal(s.surfaces, 2);
  assert.equal(s.surfaceBytes, (108 * 68 + 58 * 58) * 4);
  assert.ok(s.decodeMsP50 > 0);
  assert.ok(s.decodeMainMsP95 >= s.decodeMsP50);
  assert.equal(s.cloneMsP50, 0.1);
  assert.equal(s.nodesLast, 10);
  assert.equal(s.tiles, 4, 'a, b (built with a: both had first damage), b again, a partial');
});

test('G-soak (store): repeated tiles and pin/unpin cycles keep surfaces, pins and bytes constant', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 100, 60);
  await rig.build(a);
  const base = rig.store.stats();
  for (let i = 0; i < 12; i++) {
    rig.color = i % 2 ? 'lime' : 'blue';
    const p = rig.store.pin(a);
    await rig.build(a, A);
    rig.store.unpin(p);
  }
  const s = rig.store.stats();
  assert.equal(s.pinnedSurfaces, 0);
  assert.equal(s.surfaces, base.surfaces);
  assert.equal(s.surfaceBytes, base.surfaceBytes);
});

test('pump: the settled cost (sync build + decode + draw) is charged, not just the estimate', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 100, 60);
  const budget = { ...rig.budget, mainThreadShare: 0.1 };
  const t0 = performance.now();
  rig.store.markDamage(a, null, 'forced');
  assert.equal(rig.store.pump(t0, budget).started, 1, 'the first build (charged its fixed estimate, see the test above) measures a cheap tile');
  await until(() => rig.store.hasLanded());
  rig.store.commitLanded();
  rig.script.push({ busyMs: 25 });
  rig.store.markDamage(a, A, 'input');
  assert.equal(rig.store.pump(t0, budget).started, 1);
  await until(() => rig.store.hasLanded());
  rig.store.commitLanded();
  rig.store.markDamage(a, A, 'input');
  const r = rig.store.pump(t0, budget);
  assert.equal(r.started, 0, 'a 25 ms build exhausted a bucket that only expected the cheap tile');
  assert.equal(r.moreWork, true);
});

test('runaway: a pipeline that re-damages itself for 3 s of (fake) time at 50 commits/s emits BUS.RUNAWAY once; with outside damage it never does', async (t) => {
  const rig = await makeRig(t);
  let clock = 1000;
  rig.env.now = () => clock;
  const seen = [];
  rig.bus.on(rig.BUS.RUNAWAY, (e) => seen.push(e));
  const a = rig.add('a', 60, 40);
  for (let i = 0; i < 200; i++) { clock += 20; await rig.build(a, null, 'forced'); }
  assert.equal(seen.length, 1, 'the loop is reported once');
  assert.ok(seen[0].commits >= 90);
  const rig2 = await makeRig(t);
  let clock2 = 1000;
  rig2.env.now = () => clock2;
  const seen2 = [];
  rig2.bus.on(rig2.BUS.RUNAWAY, (e) => seen2.push(e));
  const b = rig2.add('b', 60, 40);
  for (let i = 0; i < 200; i++) { clock2 += 20; await rig2.build(b, null, 'mutation'); }
  assert.deepEqual(seen2, [], 'control: outside damage on every commit is an animation, not a loop');
});

test('a decode that fails (the stuck-decode timeout rejects it) drops the tile, re-damages its rect and backs off before the next build', async (t) => {
  const rig = await makeRig(t);
  rig.deferDecode = true;
  const a = rig.add('a', 60, 40);
  rig.store.markDamage(a, null, 'input');
  rig.pump();
  assert.equal(rig.pending.length, 1);
  rig.pending[0].fail(new Error('image decode timed out after 4000 ms'));
  await new Promise((ok) => setTimeout(ok, 20));
  assert.equal(rig.store.isSettled(a), false, 'the dropped tile re-damaged its rect');
  assert.equal(rig.reports.caught.length, 1, 'reported once');
  const before = rig.calls.length;
  rig.pump();
  assert.equal(rig.calls.length, before, 'no new build inside the backoff window');
  await new Promise((ok) => setTimeout(ok, 130));
  rig.pump();
  assert.equal(rig.calls.length, before + 1, 'the build is retried after the backoff');
});

test('a laid-out drawable with a zero-area box gets an EMPTY snapshot (WPT draw-element-image-empty): version of size 0, no capture, then a real tile once it has an area', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 0, 0);
  rig.store.markDamage(a, null, 'forced');
  assert.equal(rig.pump().started, 0, 'nothing is captured for an empty box');
  assert.equal(rig.calls.length, 0);
  const v = rig.store.version(a);
  assert.ok(v, 'the empty drawable HAS a snapshot, so drawElementImage/captureElementImage do not throw');
  assert.equal(v.width, 0);
  assert.equal(v.height, 0);
  assert.equal(rig.store.rasterSource(v, { sx: 0, sy: 0, sw: 0, sh: 0 }), null, 'drawing it paints nothing');
  assert.deepEqual(rig.store.commitLanded().changed, [a], 'it is reported once as changed');
  assert.equal(rig.store.isSettled(a), true, 'the damage was consumed, no build loop');
  assert.deepEqual(rig.store.isPaintReady(rig.record), { ready: true, reason: 'ready' });
  rig.setSize(a, 30, 20);
  const cs = await rig.build(a, null, 'forced');
  assert.deepEqual(cs.changed, [a]);
  assert.equal(rig.store.version(a).width, 30);
  assert.deepEqual(rig.css(a, 5, 5), RGBA.red, 'the first real tile replaces the empty surface');
});

test('isFresh: false while damage waits for a build or a build is decoding, true when settled; hidden drawables do not count', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 100, 60);
  assert.equal(rig.store.isFresh(rig.record), false, 'the forced damage of a new drawable');
  await rig.build(a);
  assert.equal(rig.store.isFresh(rig.record), true);
  rig.store.markDamage(a, A, 'mutation');
  assert.equal(rig.store.isFresh(rig.record), false, 'damage pending');
  rig.deferDecode = true;
  rig.pump();
  assert.equal(rig.store.isFresh(rig.record), false, 'build in flight');
  await rig.release();
  rig.store.commitLanded();
  assert.equal(rig.store.isFresh(rig.record), true);
  rig.store.markDamage(a, A, 'mutation');
  rig.hide(a);
  assert.equal(rig.store.isFresh(rig.record), true, 'a drawable without a box cannot be snapshotted and must not hold a requested paint');
});
