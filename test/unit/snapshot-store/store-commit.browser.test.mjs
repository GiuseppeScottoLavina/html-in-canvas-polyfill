import { test, assert, sleep } from '/test/unit/lib/t.js';
import { pixel, RGBA, until, makeRig } from './helpers.mjs';

const A = { x: 10, y: 10, width: 20, height: 20 };
const B = { x: 60, y: 10, width: 20, height: 20 };

test('first build: no version before, one atomic full tile after; paint readiness follows; events fire once', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 100, 60, { announce: false });
  assert.equal(rig.store.version(a), null);
  assert.deepEqual(rig.store.isPaintReady(rig.record), { ready: false, reason: 'first-commit' });
  rig.bus.emit(rig.BUS.DRAWABLES_CHANGED, { record: rig.record, added: [a], removed: [] });
  assert.equal(rig.store.has(a), true);
  assert.equal(rig.store.isSettled(a), false);
  const cs = await rig.build(a);
  assert.deepEqual(cs, { changed: [a], removed: [] });
  const v = rig.store.version(a);
  assert.equal(v.surface.width, 108);
  assert.equal(v.surface.height, 68);
  assert.equal(v.scale, 1);
  assert.equal(v.width, 100);
  assert.equal(v.height, 60);
  assert.equal(v.canvasWidth, 400);
  assert.deepEqual(v.layoutOffset, { x: 1, y: 2 });
  assert.deepEqual(v.ink, { left: 4, top: 4, right: 4, bottom: 4 });
  assert.deepEqual(rig.css(a, 50, 30), RGBA.red);
  assert.equal(rig.store.isPaintReady(rig.record).ready, true);
  assert.equal(rig.store.isSettled(a), true);
  assert.equal(rig.commits.length, 1);
  assert.deepEqual(rig.commits[0].changed, [a]);
  assert.equal(rig.versions.length, 1);
  assert.equal(rig.versions[0].version, v);
  assert.equal(rig.versions[0].version.dirty, null, 'a first version has no known dirty rect');
  const s = rig.store.stats();
  assert.equal(s.commits, 1);
  assert.equal(s.tiles, 1);
  assert.equal(s.fullTiles, 1);
  assert.equal(s.surfaces, 1);
  assert.equal(s.surfaceBytes, 108 * 68 * 4);
});

test('the translation matrix comes from the computed transform-origin', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 100, 60);
  a.style.transformOrigin = '10px 20px';
  await rig.build(a);
  const m = rig.store.version(a).translation;
  assert.equal(m.e, 10);
  assert.equal(m.f, 20);
});

test('a partial tile replaces only its crop in place; the version is new, the dirty rect is the crop', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 100, 60);
  await rig.build(a);
  const v1 = rig.store.version(a);
  rig.color = 'lime';
  const cs = await rig.build(a, A);
  assert.deepEqual(cs.changed, [a]);
  const v2 = rig.store.version(a);
  assert.notEqual(v2.id, v1.id);
  assert.equal(v2.surface, v1.surface, 'unpinned: written in place, no copy');
  assert.deepEqual(rig.css(a, 20, 20), RGBA.lime);
  assert.deepEqual(rig.css(a, 5, 5), RGBA.red, 'outside the crop nothing changed');
  assert.deepEqual(rig.css(a, 60, 40), RGBA.red);
  assert.deepEqual(rig.css(a, 36, 20), RGBA.red, 'just outside the grown crop');
  assert.deepEqual({ ...v2.dirty }, { x: 6, y: 6, width: 28, height: 28 });
  assert.equal(rig.store.stats().fullTiles, 1);
  assert.equal(rig.store.stats().tiles, 2);
  assert.equal(rig.calls.at(-1).rect !== null, true);
});

test('G-element-image: a pinned surface is never mutated; one fork per capture-then-commit; pins return to 0', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 100, 60);
  await rig.build(a);
  const pinnedV = rig.store.pin(a);
  assert.equal(pinnedV.pinned, true);
  assert.equal(pinnedV.refs, 1);
  assert.equal(rig.store.stats().pinnedSurfaces, 1);
  rig.color = 'lime';
  await rig.build(a, A);
  const v2 = rig.store.version(a);
  assert.notEqual(v2.surface, pinnedV.surface, 'forked');
  assert.deepEqual(pixel(pinnedV.surface, 24, 24), RGBA.red, 'the pinned pixels are exactly what they were');
  assert.deepEqual(rig.css(a, 20, 20), RGBA.lime);
  assert.deepEqual(rig.css(a, 5, 5), RGBA.red, 'the fork carries the rest of the old pixels');
  rig.color = 'blue';
  await rig.build(a, B);
  const v3 = rig.store.version(a);
  assert.equal(v3.surface, v2.surface, 'a second commit writes the fork in place (at most one fork)');
  assert.deepEqual(pixel(pinnedV.surface, 70, 24), RGBA.red);
  rig.store.unpin(pinnedV);
  assert.equal(pinnedV.pinned, false);
  assert.equal(rig.store.stats().pinnedSurfaces, 0);
  rig.store.unpin(pinnedV);
  assert.equal(pinnedV.refs, 0, 'a double unpin does nothing');
  rig.color = 'red';
  await rig.build(a, A);
  assert.equal(rig.store.version(a).surface, v2.surface);
});

test('a full tile while pinned allocates a new surface without copying the old pixels', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 100, 60);
  await rig.build(a);
  const p = rig.store.pin(a);
  rig.color = 'blue';
  await rig.build(a, null, 'mutation');
  const v = rig.store.version(a);
  assert.notEqual(v.surface, p.surface);
  assert.deepEqual(rig.css(a, 5, 5), RGBA.blue);
  assert.deepEqual(pixel(p.surface, 20, 20), RGBA.red);
  assert.equal(v.dirty, null);
  rig.store.unpin(p);
});

test('pin before the first commit throws InvalidStateError', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 100, 60);
  let err = null;
  try { rig.store.pin(a); } catch (e) { err = e; }
  assert.equal(err?.name, 'InvalidStateError');
});

test('G-atomic-commit (store): a draw that throws keeps the old pixels, the result is dropped and its rect re-damaged', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 100, 60);
  await rig.build(a);
  const v1 = rig.store.version(a);
  const proto = OffscreenCanvasRenderingContext2D.prototype;
  const real = proto.drawImage;
  rig.color = 'lime';
  let cs;
  try {
    await rig.damageAndPump(a, A);
    proto.drawImage = function () { throw new DOMException('simulated', 'InvalidStateError'); };
    cs = rig.store.commitLanded();
  } finally {
    proto.drawImage = real;
  }
  assert.deepEqual(cs, { changed: [], removed: [] });
  assert.equal(rig.store.version(a), v1, 'no new version');
  assert.deepEqual(rig.css(a, 20, 20), RGBA.red);
  const s = rig.store.stats();
  assert.equal(s.dropped, 1);
  assert.equal(s.redamaged, 1);
  assert.equal(rig.store.isSettled(a), false, 'the rect is damaged again');
  assert.equal(rig.reports.caught.length, 1);
  // after the back-off the retry lands
  await sleep(120);
  rig.pump();
  await until(() => rig.store.hasLanded());
  assert.deepEqual(rig.store.commitLanded().changed, [a]);
  assert.deepEqual(rig.css(a, 20, 20), RGBA.lime);
});

test('decode failure keeps the previous version, is reported once, backs off, and recovers', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 100, 60);
  await rig.build(a);
  const v1 = rig.store.version(a);
  const broken = { url: 'data:image/svg+xml,%3Csvg%20not-closed' };
  rig.script.push(broken);
  rig.store.markDamage(a, A, 'input');
  rig.pump();
  await until(() => rig.reports.caught.length === 1, 3000, 'the decode failure report');
  assert.equal(rig.store.version(a), v1);
  assert.equal(rig.store.hasLanded(), false);
  assert.equal(rig.store.isSettled(a), false, 'damage was reclaimed');
  assert.equal(rig.pump().started, 0, 'inside the back-off window nothing starts');
  assert.equal(rig.pump().moreWork, true);
  await sleep(120);
  rig.script.push(broken);
  rig.pump();
  await until(() => rig.calls.length === 3 && rig.store.stats().redamaged >= 2, 3000, 'second failure');
  await sleep(20);
  assert.equal(rig.reports.caught.length, 1, 'one report per failure streak');
  await sleep(250);
  rig.color = 'lime';
  rig.pump();
  await until(() => rig.store.hasLanded());
  assert.deepEqual(rig.store.commitLanded().changed, [a]);
  assert.deepEqual(rig.css(a, 20, 20), RGBA.lime);
});

test('G-out-of-order: two non-overlapping in-flight tiles landing out of order leave no stale region', async (t) => {
  const rig = await makeRig(t, { buildsPerDrawable: 2 });
  const a = rig.add('a', 100, 60);
  await rig.build(a);
  rig.deferDecode = true;
  rig.script.push({ color: 'lime' }, { color: 'blue' });
  rig.store.markDamage(a, A, 'input');
  rig.pump();
  rig.store.markDamage(a, B, 'input');
  rig.pump();
  assert.equal(rig.pending.length, 2, 'both tiles are in flight');
  await rig.release(1);
  assert.equal(rig.store.hasLanded(), true);
  assert.deepEqual(rig.store.commitLanded().changed, [a]);
  assert.deepEqual(rig.css(a, 70, 20), RGBA.blue);
  await rig.release(0);
  const cs = rig.store.commitLanded();
  assert.deepEqual(cs.changed, [], 'the older tile is not drawn over newer state');
  const s = rig.store.stats();
  assert.equal(s.dropped, 1);
  assert.equal(s.redamaged, 1, 'its rect was re-damaged');
  assert.deepEqual(rig.css(a, 20, 20), RGBA.red, 'still stale for the moment ...');
  assert.equal(rig.store.isSettled(a), false);
  rig.deferDecode = false;
  rig.color = 'lime';
  rig.pump();
  await until(() => rig.store.hasLanded());
  rig.store.commitLanded();
  assert.deepEqual(rig.css(a, 20, 20), RGBA.lime, '... and repaired by the re-damage');
  assert.deepEqual(rig.css(a, 70, 20), RGBA.blue, 'the newer tile survived');
  assert.equal(rig.store.isSettled(a), true);
});

test('a result of an older damage epoch is dropped when a structural change happened while it decoded', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 100, 60);
  await rig.build(a);
  rig.deferDecode = true;
  rig.script.push({ color: 'lime' });
  rig.store.markDamage(a, A, 'input');
  rig.pump();
  rig.store.markDamage(a, null, 'mutation');
  await rig.release();
  rig.store.commitLanded();
  assert.deepEqual(rig.css(a, 20, 20), RGBA.red, 'the pre-structural tile was not drawn');
  assert.equal(rig.store.stats().dropped, 1);
  assert.equal(rig.store.isSettled(a), false);
});

test('a WHOLE tile superseded by a DOM mutation while it decoded is committed, then the latest state is rebuilt; a resize still drops it', async (t) => {
  // regression: a counter in proportional digits changes its box at 60 Hz, so every change is whole-drawable 'mutation' damage; dropping every superseded build drew nothing
  const rig = await makeRig(t);
  const a = rig.add('a', 100, 60);
  await rig.build(a);
  rig.deferDecode = true;
  rig.script.push({ color: 'lime' });
  rig.store.markDamage(a, null, 'mutation');
  rig.pump();
  rig.store.markDamage(a, null, 'mutation');
  await rig.release();
  assert.deepEqual(rig.store.commitLanded().changed, [a], 'the superseded whole tile advances the visible state');
  assert.deepEqual(rig.css(a, 20, 20), RGBA.lime);
  assert.equal(rig.store.stats().dropped, 0);
  assert.equal(rig.store.isSettled(a), false, 'the newer mutation is still pending');
  rig.deferDecode = false;
  rig.color = 'blue';
  rig.pump();
  await until(() => rig.store.hasLanded());
  rig.store.commitLanded();
  assert.deepEqual(rig.css(a, 20, 20), RGBA.blue, 'the latest state follows');
  assert.equal(rig.store.isSettled(a), true);

  rig.deferDecode = true;
  rig.script.push({ color: 'lime' });
  rig.store.markDamage(a, null, 'mutation');
  rig.pump();
  rig.store.markDamage(a, null, 'resize');
  await rig.release();
  rig.store.commitLanded();
  assert.deepEqual(rig.css(a, 20, 20), RGBA.blue, 'a whole tile from before a resize is not drawn (its geometry is gone)');
  assert.equal(rig.store.stats().dropped, 1);
});

test('a commit for a paint that must show the DOM as it is now (requestPaint, first paint) reclaims a WHOLE tile superseded by a DOM mutation instead of committing it', async (t) => {
  // regression (WPT privacy/nested-tainted-canvas-ignored): a child canvas drawn right before requestPaint() was missing from the paint, the build that predates it stood in
  const rig = await makeRig(t);
  const a = rig.add('a', 100, 60);
  await rig.build(a);
  const before = rig.css(a, 20, 20);
  rig.deferDecode = true;
  rig.script.push({ color: 'lime' });
  rig.store.markDamage(a, null, 'mutation');
  rig.pump();
  rig.store.markDamage(a, null, 'mutation');
  await rig.release();
  assert.deepEqual(rig.store.commitLanded(undefined, { current: true }).changed, [], 'the superseded tile is not committed');
  assert.deepEqual(rig.css(a, 20, 20), before);
  assert.equal(rig.store.stats().dropped, 1);
  assert.equal(rig.store.isSettled(a), false, 'the newer mutation is still to be built');
  rig.deferDecode = false;
  rig.color = 'blue';
  rig.pump();
  await until(() => rig.store.hasLanded());
  assert.deepEqual(rig.store.commitLanded(undefined, { current: true }).changed, [a], 'the rebuild of the latest state is committed');
  assert.deepEqual(rig.css(a, 20, 20), RGBA.blue);
});

test('G-caret-patch: a blink costs no build and no decode; the caret is painted on the surface and lifted bit-exact', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 100, 60);
  const caret = { rect: { x: 10, y: 10, width: 1, height: 16 }, color: 'rgb(0,0,255)' };
  rig.script.push({ caret });
  await rig.build(a);
  assert.deepEqual(rig.css(a, 10, 14), RGBA.blue, 'caret visible after the tile');
  assert.deepEqual(rig.css(a, 12, 14), RGBA.red);
  const callsBefore = rig.calls.length;
  const decodesBefore = rig.decodes;
  const ids = new Set([rig.store.version(a).id]);
  for (let i = 0; i < 6; i++) {
    rig.store.markDamage(a, null, 'caret');
    assert.equal(rig.store.hasLanded(), true);
    assert.equal(rig.store.isSettled(a), false);
    const cs = rig.store.commitLanded();
    assert.deepEqual(cs.changed, [a], 'each blink advances the version so a paint fires');
    ids.add(rig.store.version(a).id);
    assert.deepEqual(rig.css(a, 10, 14), i % 2 === 0 ? RGBA.red : RGBA.blue);
    const d = rig.store.version(a).dirty;
    assert.ok(d.x <= 10 && d.y <= 10 && d.x + d.width >= 11 && d.y + d.height >= 26 && d.width < 10, 'dirty is the caret rect only');
  }
  assert.equal(ids.size, 7);
  assert.equal(rig.calls.length, callsBefore, 'no capture');
  assert.equal(rig.decodes, decodesBefore, 'no decode');
  assert.equal(rig.store.stats().tiles, 1);
});

test('caret damage with no caret known is ignored; two toggles in one round cancel', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 100, 60);
  await rig.build(a);
  rig.store.markDamage(a, null, 'caret');
  assert.equal(rig.store.hasLanded(), false);
  rig.script.push({ caret: { rect: { x: 10, y: 10, width: 1, height: 16 }, color: 'rgb(0,0,255)' } });
  await rig.build(a, A);
  const id = rig.store.version(a).id;
  rig.store.markDamage(a, null, 'caret');
  rig.store.markDamage(a, null, 'caret');
  assert.deepEqual(rig.store.commitLanded().changed, []);
  assert.equal(rig.store.version(a).id, id);
  assert.deepEqual(rig.css(a, 10, 14), RGBA.blue);
});

test('the caret phase follows the interaction tracker when one is wired', async (t) => {
  let visible = true;
  const rig = await makeRig(t, { interaction: { snapshot: () => ({ hover: new Set(), active: new Set(), focus: null, focusVisible: false, caretVisible: visible }) } });
  const a = rig.add('a', 100, 60);
  rig.script.push({ caret: { rect: { x: 10, y: 10, width: 1, height: 16 }, color: 'rgb(0,0,255)' } });
  await rig.build(a);
  assert.deepEqual(rig.css(a, 10, 14), RGBA.blue);
  visible = false;
  rig.store.markDamage(a, null, 'caret');
  rig.store.commitLanded();
  assert.deepEqual(rig.css(a, 10, 14), RGBA.red);
  rig.store.markDamage(a, null, 'caret');
  rig.store.commitLanded();
  assert.deepEqual(rig.css(a, 10, 14), RGBA.red, 'tracker says hidden: a repeated damage does not flip it');
  visible = true;
  rig.store.markDamage(a, null, 'caret');
  rig.store.commitLanded();
  assert.deepEqual(rig.css(a, 10, 14), RGBA.blue);
});

test('a tile over the caret does not paste stale saved pixels back later', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 100, 60);
  const caret = { rect: { x: 10, y: 10, width: 1, height: 16 }, color: 'rgb(0,0,255)' };
  rig.script.push({ caret });
  await rig.build(a);
  rig.color = 'lime';
  rig.script.push({ caret });
  await rig.build(a, { x: 0, y: 0, width: 40, height: 40 });
  assert.deepEqual(rig.css(a, 10, 14), RGBA.blue, 'caret is back on top of the new tile');
  rig.store.markDamage(a, null, 'caret');
  rig.store.commitLanded();
  assert.deepEqual(rig.css(a, 10, 14), RGBA.lime, 'lifting it reveals the NEW tile pixels, not the red from before');
});

test('a tile that shows the control without a caret clears it; a tile elsewhere keeps it', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 100, 60);
  rig.script.push({ caret: { rect: { x: 10, y: 10, width: 1, height: 16 }, color: 'rgb(0,0,255)' } });
  await rig.build(a);
  rig.color = 'lime';
  await rig.build(a, { x: 70, y: 40, width: 10, height: 10 });
  assert.deepEqual(rig.css(a, 10, 14), RGBA.blue, 'a far-away tile leaves the caret alone');
  await rig.build(a, { x: 0, y: 0, width: 40, height: 40 });
  assert.deepEqual(rig.css(a, 10, 14), RGBA.lime, 'covering tile without a caret: it is gone');
  const id = rig.store.version(a).id;
  rig.store.markDamage(a, null, 'caret');
  assert.equal(rig.store.hasLanded(), false);
  assert.equal(rig.store.version(a).id, id);
});

test('G-element-image: the caret patch forks a pinned surface instead of writing it', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 100, 60);
  rig.script.push({ caret: { rect: { x: 10, y: 10, width: 1, height: 16 }, color: 'rgb(0,0,255)' } });
  await rig.build(a);
  const p = rig.store.pin(a);
  rig.store.markDamage(a, null, 'caret');
  rig.store.commitLanded();
  const v = rig.store.version(a);
  assert.notEqual(v.surface, p.surface);
  assert.deepEqual(pixel(p.surface, 14, 18), RGBA.blue, 'the pinned image keeps the caret it was pinned with');
  assert.deepEqual(rig.css(a, 10, 14), RGBA.red, 'the fork shows the lifted caret');
  rig.store.markDamage(a, null, 'caret');
  rig.store.commitLanded();
  assert.equal(rig.store.version(a).surface, v.surface, 'no second fork');
  rig.store.unpin(p);
  assert.equal(rig.store.stats().pinnedSurfaces, 0);
});

test('changed drawables are listed in tree order whatever the damage order', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 50, 50);
  const b = rig.add('b', 50, 50);
  const c = rig.add('c', 50, 50);
  rig.store.markDamage(c, null, 'forced');
  rig.store.markDamage(a, null, 'forced');
  rig.store.markDamage(b, null, 'forced');
  rig.pump({ ...rig.budget, maxInFlight: 3 });
  await until(() => rig.store.hasLanded());
  await sleep(100);
  const cs = rig.store.commitLanded();
  assert.deepEqual(cs.changed, [a, b, c]);
  assert.equal(rig.commits.length, 1);
});

test('a full tile on a pinned surface costs one draw (the new surface), not a fork plus a draw', async (t) => {
  const rig = await makeRig(t);
  const a = rig.add('a', 100, 60);
  await rig.build(a);
  const p = rig.store.pin(a);
  const proto = OffscreenCanvasRenderingContext2D.prototype;
  const real = proto.drawImage;
  let draws = 0;
  proto.drawImage = function (...args) { draws++; return real.apply(this, args); };
  try {
    await rig.build(a, null, 'mutation');
  } finally {
    proto.drawImage = real;
  }
  assert.equal(draws, 1);
  rig.store.unpin(p);
});

test('a build whose synchronous part is long starts its decode in the next task (no task carries clone + SVG document); a short or urgent one at once', async (t) => {
  const tasks = [];
  const rig = await makeRig(t, { nextTask: (fn) => tasks.push(fn), virtualBusy: true });
  const a = rig.add('a', 100, 60);
  rig.script.push({ busyMs: 5 });
  rig.store.markDamage(a, null, 'input');
  rig.pump();
  assert.equal(rig.decodes, 0, 'the decode waits for the next task');
  assert.equal(rig.store.isSettled(a), false, 'and counts as in flight');
  assert.equal(tasks.length, 1);
  tasks.shift()();
  assert.equal(rig.decodes, 1);
  await until(() => rig.store.hasLanded(), 3000, 'the deferred decode lands');
  rig.store.commitLanded();
  rig.script.push({ busyMs: 0 });
  rig.store.markDamage(a, null, 'input');
  rig.pump();
  assert.equal(rig.decodes, 2, 'a short build decodes at once');
  await until(() => rig.store.hasLanded(), 3000, 'landed');
  rig.store.commitLanded();
  rig.script.push({ busyMs: 5 });
  rig.store.markDamage(a, null, 'focus');
  rig.store.pump(performance.now(), { ...rig.budget, urgent: true });
  assert.equal(rig.decodes, 3, 'an urgent build decodes at once even when long');
  assert.equal(tasks.length, 0);
});

test('the deferred decode start runs before the tasks the page queued earlier (a user-blocking task), so whether a build took 3.5 ms does not reorder its paint', async (t) => {
  const { createNextTask } = await import('/src/snapshot/store/store.js');
  const errors = [];
  const next = createNextTask(window, (e) => errors.push(e));
  t.cleanup(() => next.dispose());
  const order = [];
  // the WPT pattern: the page's one-frame wait queues a setTimeout from its rAF callback; the post-frame build defers its decode after that
  await new Promise((resolve) => requestAnimationFrame(() => {
    setTimeout(() => { order.push('page task'); resolve(); }, 0);
    next(() => order.push('decode 1'));
    next(() => order.push('decode 2'));
  }));
  await sleep(20);
  assert.deepEqual(order, ['decode 1', 'decode 2', 'page task'], 'WPT onpaint: the deferred decode landed after the test installed its next handler');
  assert.deepEqual(errors, []);
  // without the Prioritized Task Scheduling API (Safari): one MessageChannel task per batch
  const fallback = createNextTask(/** @type {any} */ ({ MessageChannel }), (e) => errors.push(e));
  const ran = [];
  fallback(() => ran.push(1));
  fallback(() => { throw new Error('reported, not thrown'); });
  fallback(() => ran.push(2));
  await sleep(20);
  assert.deepEqual(ran, [1, 2]);
  assert.equal(errors.length, 1);
  fallback.dispose();
});

test('first builds use no credit of the snapshot-rate cap: the change right after the first paint is built in the next frame, then the cap paces (WPT onpaint-remove-non-drawable-element)', async (t) => {
  const rig = await makeRig(t, { options: { maxSnapshotFps: 60 } });
  const a = rig.add('a', 100, 60);
  const b = rig.add('b', 100, 60);
  const frame = 1000 / 120;
  const t0 = performance.now();
  rig.store.markDamage(a, null, 'forced');
  rig.store.markDamage(b, null, 'forced');
  assert.equal(rig.store.pump(t0, rig.budget).started, 2, 'the first snapshot');
  await until(() => rig.store.hasLanded());
  rig.store.commitLanded();
  rig.store.markDamage(a, A, 'mutation');
  assert.equal(rig.store.pump(t0 + frame, rig.budget).started, 1, 'one frame later: not held by the cap');
  await until(() => rig.store.hasLanded());
  rig.store.commitLanded();
  rig.store.markDamage(a, A, 'mutation');
  assert.equal(rig.store.pump(t0 + 2 * frame, rig.budget).started, 0, 'then the cap holds');
  assert.equal(rig.store.pump(t0 + 3 * frame, rig.budget).started, 1);
});

test('an in-frame (urgent) resize / DPR re-raster is not held by the snapshot-rate cap; everything else still is', async (t) => {
  const rig = await makeRig(t, { options: { maxSnapshotFps: 60 } });
  const a = rig.add('a', 100, 60);
  await rig.build(a); // the first build uses no credit of the gate (see the test above): pace from a later one
  const t0 = performance.now() + 1000;
  rig.store.markDamage(a, null, 'input');
  rig.store.pump(t0, rig.budget);
  assert.equal(rig.decodes, 2, 'a build');
  await until(() => rig.store.hasLanded(), 3000, 'landed');
  rig.store.commitLanded();
  const soon = t0 + 1000 / 120;
  rig.store.markDamage(a, null, 'input');
  rig.store.pump(soon, { ...rig.budget, urgent: true });
  assert.equal(rig.decodes, 2, 'other damage one 120 Hz frame later waits for the 60 fps gate, even in an urgent pump');
  rig.store.markDamage(a, null, 'resize');
  rig.store.pump(soon, rig.budget);
  assert.equal(rig.decodes, 2, 'a resize built after the frame (not urgent) waits for the gate too');
  rig.store.pump(soon, { ...rig.budget, urgent: true });
  assert.equal(rig.decodes, 3, 'the in-frame resize re-raster starts at once: the retained tile has the wrong geometry');
});

test('the canvas framecap still holds an in-frame resize re-raster (only maxSnapshotFps is lifted)', async (t) => {
  const rig = await makeRig(t, { options: { maxSnapshotFps: 60 } });
  rig.record.frameCap = 30;
  const a = rig.add('a', 100, 60);
  await rig.build(a); // the first build uses no credit of the gate: pace from a later one
  const t0 = performance.now() + 1000;
  rig.store.markDamage(a, null, 'input');
  rig.store.pump(t0, rig.budget);
  assert.equal(rig.decodes, 2);
  await until(() => rig.store.hasLanded(), 3000, 'landed');
  rig.store.commitLanded();
  rig.store.markDamage(a, null, 'resize');
  rig.store.pump(t0 + 1000 / 60, { ...rig.budget, urgent: true });
  assert.equal(rig.decodes, 2, 'framecap 30: the resize re-raster waits for the author cap');
});
