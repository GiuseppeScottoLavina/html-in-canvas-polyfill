import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '../../../src/schedule/scheduler.js';
import { BUS } from '../../../src/contracts/events.js';
import { createFakeEnv, fakeElement } from './_fakes.mjs';

/** env + scheduler whose firePaint is recorded; `onFire(record, changed)` can be set by a test */
function setup(options) {
  const t = createFakeEnv(options);
  const fired = [];
  const ctl = { onFire: null };
  const hooks = { firePaint: (record, changed) => { fired.push({ record, changed, at: t.clock.t }); ctl.onFire?.(record, changed); } };
  const scheduler = createScheduler(t.env, t.store, hooks);
  return { ...t, scheduler, fired, ctl };
}

/** register a record with one drawable and run until its first paint went out */
function mounted(t, drawables = [fakeElement()]) {
  const record = t.addRecord(drawables);
  t.scheduler.register(record);
  t.run(100);
  return record;
}

test('first paint: a registered canvas fires one paint with [] once the gate is open, then goes quiet (zero rAF, zero observer, no sentinel)', () => {
  const t = setup();
  const record = mounted(t);
  assert.equal(t.fired.length, 1);
  assert.deepEqual(t.fired[0].changed, []);
  assert.equal(record.paint.force, false);
  assert.equal(record.paint.serial, 1);
  assert.equal(record.paint.everFired, true);
  const rafs = t.fw.counters.rafRequests;
  const observers = t.fw.counters.roCreated;
  t.run(2000);
  assert.equal(t.fw.counters.rafRequests, rafs, 'G-idle: no rAF while idle');
  assert.equal(t.fw.counters.roCreated, observers, 'G-idle: no ResizeObserver while idle');
  assert.equal(t.fired.length, 1);
  assert.equal(t.document.added.at(-1).isConnected, false);
});

test('a canvas without any drawable fires no first paint (native does not; WPT moved-webgl-canvas throws in its handler otherwise), an explicit requestPaint still fires', () => {
  const t = setup();
  const record = t.addRecord([]);
  t.scheduler.register(record);
  t.run(100);
  assert.equal(t.fired.length, 0);
  t.scheduler.requestPaint(record);
  t.run(30);
  assert.equal(t.fired.length, 1);
  assert.deepEqual(t.fired[0].changed, []);
});

test('paint gate: the paint is held while the first snapshot is missing, force stays set, and a draw can never run early', () => {
  const t = setup();
  t.store.ready = { ready: false, reason: 'first-commit' };
  const record = t.addRecord([fakeElement()]);
  t.scheduler.register(record);
  t.run(300);
  assert.equal(t.fired.length, 0, 'held');
  assert.equal(record.paint.force, true);
  assert.equal(record.paint.gateReason, 'first-commit');
  t.store.ready = { ready: true, reason: 'ready' };
  t.run(30);
  assert.equal(t.fired.length, 1);
  assert.equal(t.scheduler.stats().gateTimeouts, 0);
});

test('paint gate timeout: fires after paintGateMaxWaitMs anyway, counts a gate timeout and reports a deviation', () => {
  const t = setup();
  t.store.ready = { ready: false, reason: 'first-commit' };
  const record = t.addRecord([fakeElement()]);
  t.scheduler.register(record);
  t.run(390);
  assert.equal(t.fired.length, 0);
  t.run(60);
  assert.equal(t.fired.length, 1);
  assert.equal(t.scheduler.stats().gateTimeouts, 1);
  assert.equal(t.reporter.deviations.some(([id]) => id === 'paint-timing'), true);
});

test('damage reaches the store, arms the tick, pumps, and keeps ticking until the store reports settled', () => {
  const t = setup();
  const el = fakeElement();
  const record = mounted(t, [el]);
  t.store.calls.length = 0;
  t.store.unsettled.add(el);
  t.store.pumpResult = { started: 1, spentMs: 1, moreWork: false, nextDueAt: null };
  t.scheduler.damage(record, 'mutation', el, { x: 1, y: 2, width: 3, height: 4 });
  assert.deepEqual(t.store.calls[0], ['markDamage', el, { x: 1, y: 2, width: 3, height: 4 }, 'mutation']);
  t.run(100);
  const pumpsWhileBusy = t.store.pumps;
  assert.ok(pumpsWhileBusy >= 8, `pumped every frame while the build was in flight (${pumpsWhileBusy})`);
  t.store.unsettled.clear();
  t.run(100);
  const after = t.store.pumps;
  t.run(500);
  assert.equal(t.store.pumps, after, 'quiet once settled');
});

test('null drawable damage marks every tracked drawable of the canvas', () => {
  const t = setup();
  const a = fakeElement();
  const b = fakeElement();
  const record = mounted(t, [a, b]);
  t.store.calls.length = 0;
  t.scheduler.damage(record, 'resize', null, null);
  assert.deepEqual(t.store.calls.filter((c) => c[0] === 'markDamage').map((c) => c[1]), [a, b]);
});

test('damage of an unregistered canvas is ignored; unregister stops ticking', () => {
  const t = setup();
  const record = t.addRecord([fakeElement()]);
  t.scheduler.damage(record, 'mutation', record.layer.drawables[0], null);
  assert.equal(t.store.calls.length, 0);
  t.scheduler.register(record);
  t.scheduler.unregister(record);
  t.run(200);
  assert.equal(t.fired.length, 0);
  assert.equal(t.fw.rafCount(), 0);
});

test('commit: landed results become ONE paint with the committed drawables in tree order', () => {
  const t = setup();
  const a = fakeElement();
  const b = fakeElement();
  const record = mounted(t, [a, b]);
  t.fired.length = 0;
  t.scheduler.damage(record, 'input', b, null);
  t.store.landed = true;
  t.store.nextChange = { changed: [b, a], removed: [] };
  t.run(60);
  assert.equal(t.fired.length, 1, 'one paint per frame per canvas');
  assert.deepEqual(t.fired[0].changed, [b, a]);
  const commits = t.store.calls.filter((c) => c[0] === 'commitLanded').length;
  assert.equal(commits >= 1, true);
});

test('changedElements from two commits that arrived in separate ticks (gate hold) are merged back into tree order', () => {
  const t = setup();
  const a = fakeElement();
  const b = fakeElement();
  const record = mounted(t, [a, b]);
  t.fired.length = 0;
  t.bus.emit(BUS.COMMIT, { record, changed: [b], removed: [] });
  t.bus.emit(BUS.COMMIT, { record, changed: [a], removed: [] });
  t.scheduler.requestPaint(record);
  t.run(30);
  assert.deepEqual(t.fired[0].changed, [a, b]);
});

test('a drawable committed while the paint was held and removed before it fires is not reported; one removed and added back is (WPT onpaint-remove-drawable-element)', () => {
  const t = setup();
  const a = fakeElement();
  const b = fakeElement();
  const record = mounted(t, [a, b]);
  t.fired.length = 0;
  t.store.ready = { ready: false, reason: 'coherence' };
  t.bus.emit(BUS.COMMIT, { record, changed: [a, b], removed: [] });
  t.scheduler.requestPaint(record);
  t.run(20);
  assert.equal(t.fired.length, 0, 'held');
  record.layer.drawables = [a];
  t.bus.emit(BUS.COMMIT, { record, changed: [], removed: [b] });
  t.store.ready = { ready: true, reason: 'ready' };
  t.run(20);
  assert.equal(t.fired.length, 1);
  assert.deepEqual(t.fired[0].changed, [a], 'the removed drawable is not listed');
  t.fired.length = 0;
  t.bus.emit(BUS.COMMIT, { record, changed: [], removed: [b] });
  record.layer.drawables = [a, b];
  t.bus.emit(BUS.COMMIT, { record, changed: [b], removed: [] });
  t.scheduler.requestPaint(record);
  t.run(20);
  assert.deepEqual(t.fired[0].changed, [b], 'added back and committed: listed');
});

test('a store that returns the change set without BUS.COMMIT is attributed through the registry', () => {
  const t = setup();
  const a = fakeElement();
  const record = mounted(t, [a]);
  t.fired.length = 0;
  t.store.emitCommit = false;
  t.scheduler.damage(record, 'input', a, null);
  t.store.landed = true;
  t.store.nextChange = { changed: [a], removed: [] };
  t.run(60);
  assert.deepEqual(t.fired[0].changed, [a]);
});

test('changedElements nested removal rule: a removed nested drawable lists its drawable ancestor, a removed top-level one lists nothing', () => {
  const t = setup();
  const parent = fakeElement();
  const child = fakeElement(parent);
  const top = fakeElement();
  const record = mounted(t, [parent, child, top]);
  t.fired.length = 0;
  t.store.landed = true;
  t.store.nextChange = { changed: [], removed: [child] };
  t.scheduler.damage(record, 'mutation', parent, null);
  t.run(30);
  assert.deepEqual(t.fired[0].changed, [parent], 'nested');
  t.fired.length = 0;
  t.store.landed = true;
  t.store.nextChange = { changed: [], removed: [top] };
  t.scheduler.damage(record, 'mutation', null, null);
  t.run(30);
  assert.equal(t.fired.length, 1, 'a removal alone still fires a paint');
  assert.deepEqual(t.fired[0].changed, [], 'top-level');
});

test('canvases are served in reverse tree order', () => {
  const t = setup();
  const first = t.addRecord([fakeElement()]);
  const second = t.addRecord([fakeElement()]);
  const third = t.addRecord([fakeElement()]);
  for (const r of [first, second, third]) t.scheduler.register(r);
  t.run(60);
  assert.deepEqual(t.fired.map((f) => f.record), [third, second, first]);
});

test('a canvas that contains another one waits for it: the nested canvas paints first, the outer paint stays back while the nested one is held (WPT nested-content-drawable-canvas)', () => {
  const t = setup();
  let nested;
  const outer = t.addRecord([fakeElement()], { layer: { element: { contains: (node) => node === nested.canvas }, drawables: [], drawableElements: () => [{}], nearestDrawable: () => null } });
  nested = t.addRecord([fakeElement()]);
  t.scheduler.register(outer);
  t.scheduler.register(nested);
  t.store.readyFor.set(nested, { ready: false, reason: 'first-commit' });
  t.run(200);
  assert.equal(t.fired.length, 0, 'the nested canvas has no snapshot yet: neither paints');
  t.store.readyFor.delete(nested);
  t.run(30);
  assert.deepEqual(t.fired.map((f) => f.record), [nested, outer], 'nested first, then the canvas that contains it');
});

test('after a nested canvas painted (its handler drew into the bitmap the outer snapshot shows) the outer paint waits one tick and then for a fresh snapshot', () => {
  const t = setup();
  let nested;
  const outer = t.addRecord([fakeElement()], { layer: { element: { contains: (node) => node === nested.canvas }, drawables: [], drawableElements: () => [{}], nearestDrawable: () => null } });
  nested = t.addRecord([fakeElement()]);
  t.scheduler.register(outer);
  t.scheduler.register(nested);
  t.step();
  assert.deepEqual(t.fired.map((f) => f.record), [nested], 'same tick: the nested canvas paints, the outer one is held');
  t.store.freshFor.set(outer, false);
  t.run(100);
  assert.deepEqual(t.fired.map((f) => f.record), [nested], 'its drawable is damaged by the nested draw: held until the new snapshot lands');
  t.store.freshFor.delete(outer);
  t.run(30);
  assert.deepEqual(t.fired.map((f) => f.record), [nested, outer]);
});

test('the nested hold is bounded by paintGateMaxWaitMs', () => {
  const t = setup();
  let nested;
  const outer = t.addRecord([fakeElement()], { layer: { element: { contains: (node) => node === nested.canvas }, drawables: [], drawableElements: () => [{}], nearestDrawable: () => null } });
  nested = t.addRecord([fakeElement()]);
  t.scheduler.register(outer);
  t.scheduler.register(nested);
  t.store.readyFor.set(nested, { ready: false, reason: 'first-commit' });
  t.run(380);
  assert.equal(t.fired.length, 0);
  t.run(80);
  assert.equal(t.fired.map((f) => f.record).includes(outer), true, 'the outer paint goes out after the cap');
});

test('requestPaint fires once with [] and inside a handler fires on the NEXT frame, never re-entrantly', () => {
  const t = setup();
  const record = mounted(t);
  t.fired.length = 0;
  let inside = 0;
  t.ctl.onFire = (r) => { if (inside++ === 0) t.scheduler.requestPaint(r); };
  t.scheduler.requestPaint(record);
  t.scheduler.requestPaint(record);
  assert.equal(t.fired.length, 0, 'never synchronous');
  t.step();
  assert.equal(t.fired.length, 1, 'idempotent until fired');
  assert.deepEqual(t.fired[0].changed, []);
  t.step();
  assert.equal(t.fired.length, 2, 'the request made inside the handler lands the next frame');
  t.run(200);
  assert.equal(t.fired.length, 2);
});

test('requestPaint after a DOM change is held until the damage is snapshotted (WPT waitForCanvasPaint pattern), then fires with the fresh commit', () => {
  const t = setup();
  const record = mounted(t);
  t.fired.length = 0;
  t.store.fresh = false;
  t.scheduler.requestPaint(record);
  t.run(100);
  assert.equal(t.fired.length, 0, 'held: the snapshot the handler would draw is stale');
  assert.equal(record.paint.force, true);
  t.store.nextChange = { changed: [record.layer.drawables[0]], removed: [] };
  t.store.landed = true;
  t.store.commitRecord = record;
  t.run(20);
  assert.equal(t.fired.length, 1, 'the landed build is committed and reported');
  assert.deepEqual(t.fired[0].changed, [record.layer.drawables[0]]);
  assert.equal(record.paint.holdSince, null);
});

test('a held requestPaint paint gives up after paintGateMaxWaitMs (a drawable whose build never settles cannot stall it), and an unrelated paint is never held', () => {
  const t = setup();
  const record = mounted(t);
  t.fired.length = 0;
  t.store.fresh = false;
  t.scheduler.requestPaint(record);
  t.run(380);
  assert.equal(t.fired.length, 0);
  t.run(60);
  assert.equal(t.fired.length, 1);
  assert.equal(record.paint.holdSince, null);
  t.store.fresh = true;
  t.fired.length = 0;
  t.scheduler.requestPaint(record);
  t.step();
  assert.equal(t.fired.length, 1, 'fresh store: fires at once');
});

test('paintNow: immediate, at most once per frame, never re-entrant, falls back to requestPaint', () => {
  const t = setup();
  const record = mounted(t);
  t.fired.length = 0;
  assert.equal(t.scheduler.paintNow(record), true);
  assert.equal(t.fired.length, 1);
  assert.equal(t.scheduler.paintNow(record), false, 'second call in the same frame');
  assert.equal(t.fired.length, 1);
  t.step();
  assert.equal(t.fired.length, 2, 'the refused call became a requestPaint for the next RUN');
  assert.equal(t.scheduler.paintNow(record), true, 'a new frame has passed');
  t.fired.length = 0;
  t.step();
  t.ctl.onFire = (r) => { t.ctl.onFire = null; assert.equal(t.scheduler.paintNow(r), false); };
  t.scheduler.requestPaint(record);
  t.step();
  assert.equal(t.fired.length, 1, 'inside a dispatch it does not re-enter');
  t.step();
  assert.equal(t.fired.length, 2, 'it degraded to requestPaint');
});

test('paintNow ignores the frame cap (the app just cleared the bitmap) but honours the paint gate', () => {
  const t = setup();
  const record = mounted(t);
  t.scheduler.setFrameCap(record, 1);
  t.run(50);
  t.fired.length = 0;
  assert.equal(t.scheduler.paintNow(record), true);
  t.step();
  t.store.ready = { ready: false, reason: 'first-commit' };
  assert.equal(t.scheduler.paintNow(record), false);
  assert.equal(record.paint.force, true, 'force stays set for the opening of the gate');
});

test('G-fps-cap: continuous requestPaint loop stays within 0.9N..1.1N for N in 10, 15, 30, 60 on a 120 Hz display', () => {
  for (const n of [10, 15, 30, 60]) {
    const t = setup();
    const record = mounted(t);
    t.scheduler.setFrameCap(record, n);
    t.fired.length = 0;
    t.ctl.onFire = (r) => t.scheduler.requestPaint(r);
    t.scheduler.requestPaint(record);
    t.run(3000);
    const perSecond = t.fired.length / 3;
    assert.ok(perSecond >= 0.9 * n && perSecond <= 1.1 * n, `cap ${n}: ${perSecond}/s`);
  }
});

test('G-fps-cap positive control: the uncapped canvas exceeds 1.3 x N', () => {
  const t = setup();
  const record = mounted(t);
  t.fired.length = 0;
  t.ctl.onFire = (r) => t.scheduler.requestPaint(r);
  t.scheduler.requestPaint(record);
  t.run(3000);
  assert.ok(t.fired.length / 3 > 1.3 * 30);
});

test('a runtime cap change is stored once and is effective within 2 frames', () => {
  const t = setup();
  const record = mounted(t);
  t.ctl.onFire = (r) => t.scheduler.requestPaint(r);
  t.scheduler.setFrameCap(record, 10);
  t.scheduler.requestPaint(record);
  t.run(1000);
  t.fired.length = 0;
  t.scheduler.setFrameCap(record, 120);
  t.scheduler.setFrameCap(record, 120);
  assert.equal(record.frameCap, 120);
  t.run(1000 / 120 * 4);
  assert.ok(t.fired.length >= 3, `fast again after ${t.fired.length} paints in 4 frames`);
  t.scheduler.setFrameCap(record, 10);
  t.fired.length = 0;
  t.run(1000);
  assert.ok(t.fired.length <= 11 && t.fired.length >= 9);
});

test('setFrameCap clamps to 1..240 and 0 means uncapped; register reads the framecap attribute, else the default', () => {
  const t = setup({ defaultFrameCap: 20 });
  const record = t.addRecord([fakeElement()], { canvas: { getAttribute: (n) => (n === 'framecap' ? '45' : null) } });
  t.scheduler.register(record);
  assert.equal(record.frameCap, 45);
  t.scheduler.setFrameCap(record, 9999);
  assert.equal(record.frameCap, 240);
  t.scheduler.setFrameCap(record, 0);
  assert.equal(record.frameCap, 0);
  const other = t.addRecord([fakeElement()]);
  t.scheduler.register(other);
  assert.equal(other.frameCap, 20);
});

test('interaction floor: input damage may exceed a low cap only when interactionFloorFps says so (default strict)', () => {
  /** @param {number} floor */
  const typing = (floor) => {
    const t = setup({ interactionFloorFps: floor });
    const el = fakeElement();
    const record = mounted(t, [el]);
    t.scheduler.setFrameCap(record, 10);
    t.run(300);
    t.fired.length = 0;
    for (let i = 0; i < 240; i++) {
      t.scheduler.damage(record, 'input', el, null);
      t.store.landed = true;
      t.store.nextChange = { changed: [el], removed: [] };
      t.step();
    }
    return { fired: t.fired.length, interaction: t.store.lastBudget.interaction };
  };
  const strict = typing(0);
  const floor = typing(60);
  assert.ok(strict.fired >= 18 && strict.fired <= 22, `strict: ${strict.fired} paints in 2 s at cap 10`);
  assert.ok(floor.fired >= 100 && floor.fired <= 125, `floor 60: ${floor.fired} paints in 2 s`);
  assert.equal(strict.interaction, true, 'the pump is told that input damage is pending');
});

test('frame hooks run after paint and the pump, see due/frameCap, and keep the tick alive only while they return true', () => {
  const t = setup();
  const record = mounted(t);
  t.scheduler.setFrameCap(record, 30);
  const calls = [];
  let keep = true;
  const remove = t.scheduler.addFrameHook(record, (now, info) => { calls.push({ now, ...info }); return keep; });
  t.scheduler.wake(record);
  t.run(1000);
  const due = calls.filter((c) => c.due).length;
  assert.ok(due >= 27 && due <= 33, `${due} due frames in 1 s at cap 30`);
  assert.ok(calls.length > 100, 'the hook is also called on frames the cap skipped, with due:false');
  assert.equal(calls[0].frameCap, 30);
  keep = false;
  t.run(100);
  const n = calls.length;
  t.run(500);
  assert.equal(calls.length, n, 'no more ticks once the hook stopped asking');
  t.scheduler.wake(record);
  t.run(50);
  assert.ok(calls.length > n, 'wake() runs it once');
  remove();
  const m = calls.length;
  t.scheduler.wake(record);
  t.run(50);
  assert.equal(calls.length, m);
});

test('a throwing frame hook or firePaint is reported and does not stop the loop', () => {
  const t = setup();
  const record = mounted(t);
  t.scheduler.addFrameHook(record, () => { throw new Error('hook'); });
  let ok = 0;
  t.scheduler.addFrameHook(record, () => { ok++; });
  t.ctl.onFire = () => { throw new Error('handler'); };
  t.scheduler.requestPaint(record);
  t.run(50);
  assert.ok(ok > 0, 'the second hook still ran');
  assert.equal(t.reporter.errors.some(([e, where]) => where === 'schedule.frame-hook' && e.message === 'hook'), true);
  assert.equal(t.reporter.errors.some(([, where]) => where === 'schedule.firePaint'), true);
  t.ctl.onFire = null;
  t.scheduler.requestPaint(record);
  t.run(50);
  assert.equal(t.fired.at(-1).at > 0, true);
});

test('phase fallback: a frame whose observer never arrives is counted in stats and the paint still goes out', () => {
  const t = setup();
  const record = t.addRecord([fakeElement()]);
  t.fw.flags.suppressRO = true;
  t.scheduler.register(record);
  t.run(100);
  assert.equal(t.fired.length, 1);
  assert.ok(t.scheduler.stats().phaseFallbacks >= 1);
});

test('hidden tab: nothing runs, and becoming visible queues a full-damage forced paint with fresh gate and cap clocks', () => {
  const t = setup();
  const el = fakeElement();
  const record = mounted(t, [el]);
  record.paint.waitingSince = 5;
  record.paint.gateReason = 'first-commit';
  t.fired.length = 0;
  t.store.calls.length = 0;
  t.document.hidden = true;
  t.document.dispatch('visibilitychange');
  assert.equal(t.store.calls.length, 0, 'hidden: no work');
  t.document.hidden = false;
  t.document.dispatch('visibilitychange');
  assert.equal(record.paint.waitingSince, null);
  assert.deepEqual(t.store.calls[0], ['markDamage', el, null, 'forced']);
  t.run(50);
  assert.equal(t.fired.length, 1);
});

test('a canvas that becomes active again repaints fully', () => {
  const t = setup();
  const el = fakeElement();
  const record = mounted(t, [el]);
  record.state = 'suspended';
  t.fired.length = 0;
  t.store.calls.length = 0;
  t.scheduler.damage(record, 'mutation', el, null);
  t.run(50);
  assert.equal(t.fired.length, 0, 'suspended canvases are not served');
  record.state = 'active';
  t.bus.emit(BUS.CANVAS_STATE, { record, state: 'active', previous: 'suspended' });
  t.run(50);
  assert.equal(t.fired.length, 1);
});

test('stats: frames, paintsFired, lateFrames (a skipped frame while ticking back to back), gateTimeouts, phaseFallbacks', () => {
  const t = setup();
  const record = mounted(t);
  t.ctl.onFire = (r) => t.scheduler.requestPaint(r);
  t.scheduler.requestPaint(record);
  t.run(100);
  const before = t.scheduler.stats();
  t.step(40);
  t.step();
  const after = t.scheduler.stats();
  assert.equal(after.lateFrames, before.lateFrames + 1);
  assert.ok(after.frames > before.frames && after.paintsFired > before.paintsFired);
  assert.deepEqual(Object.keys(after).sort(), ['frames', 'gateTimeouts', 'lateFrames', 'paintsFired', 'phaseFallbacks']);
});

test('dispose removes the visibility listener, the pending frame and all state', () => {
  const t = setup();
  const record = mounted(t);
  assert.equal(t.document.listenerCount('visibilitychange'), 1);
  t.scheduler.requestPaint(record);
  t.scheduler.dispose();
  assert.equal(t.document.listenerCount('visibilitychange'), 0);
  assert.equal(t.fw.rafCount(), 0);
  t.fired.length = 0;
  t.run(100);
  assert.equal(t.fired.length, 0);
});

test('the build pump runs in a task AFTER the rendering update, never inside the frame-end tick (commit and paint stay in the tick)', () => {
  const t = setup();
  const el = fakeElement();
  const record = mounted(t, [el]);
  const seen = [];
  t.scheduler.addFrameHook(record, () => { seen.push(t.store.pumps); return false; });
  const before = t.store.pumps;
  t.scheduler.damage(record, 'mutation', el, null);
  t.step(1000 / 120);
  assert.equal(seen.length, 1, 'the tick ran');
  assert.equal(seen[0], before, 'no pump inside the tick (the frame hooks run at its end)');
  assert.equal(t.store.pumps, before + 1, 'the pump ran right after the frame');
});

test('builds are paced in frame time: a post-frame or input pump gets the last rendering update plus whole frame periods, not the time its task ran (WPT onpaint)', async () => {
  const t = setup();
  const el = fakeElement();
  const record = mounted(t, [el]);
  t.store.unsettled.add(el);
  t.scheduler.damage(record, 'mutation', el, null);
  t.run(50);
  t.store.unsettled.delete(el);
  t.run(50);
  assert.ok(t.scheduler.stats().frames > 3, 'ticks ran back to back: the frame period is known');
  const frame = 1000 / 120;
  t.env.now = () => t.clock.t + 3.7;
  t.scheduler.damage(record, 'mutation', el, null);
  t.step(frame);
  const tick = t.clock.t;
  assert.ok(Math.abs(t.store.lastNow - tick) < 1e-6, `post-frame pump at ${t.store.lastNow}, frame at ${tick} (its task ran 3.7 ms later)`);
  t.env.now = () => tick + 2 * frame + 1.2;
  t.scheduler.damage(record, 'focus', el, null, true);
  await Promise.resolve();
  assert.ok(Math.abs(t.store.lastNow - (tick + 2 * frame)) < 1e-6, `input pump at ${t.store.lastNow}: two whole frames after the last one`);
});

test('while the window is being resized every build runs inside the tick (a post-frame build lands a frame late); after a pause, after the frame again', () => {
  const t = setup();
  const el = fakeElement();
  const record = mounted(t, [el]);
  t.step();
  t.fw.runTasks();
  const seen = [];
  t.scheduler.addFrameHook(record, () => { seen.push(t.store.pumps); return true; });
  t.fw.win.dispatch('resize');
  const before = t.store.pumps;
  t.scheduler.damage(record, 'mutation', el, null);
  t.step();
  assert.equal(seen.at(-1), before + 1, 'a non-resize build (layout inside the canvas) during a window resize is pumped inside the tick');
  t.step(150);
  t.fw.runTasks();
  const later = t.store.pumps;
  t.scheduler.damage(record, 'mutation', el, null);
  t.step();
  assert.equal(seen.at(-1), later, 'once the resizing paused, no pump inside the tick');
  assert.ok(t.store.pumps > later, 'it ran after the frame');
  t.scheduler.dispose();
  assert.equal(t.fw.win.listenerCount('resize'), 0, 'dispose removes the window listener');
});

test('focus / active (and urgent value changes) are built in a microtask of the input task itself; other damage waits for the frame', async () => {
  const t = setup();
  const el = fakeElement();
  const record = mounted(t, [el]);
  const before = t.store.pumps;
  t.scheduler.damage(record, 'focus', el, null);
  assert.equal(t.store.pumps, before, 'not synchronously inside the listener');
  await null;
  assert.equal(t.store.pumps, before + 1, 'focus: pumped in a microtask, before any task or frame');
  t.scheduler.damage(record, 'input', el, null, true);
  await null;
  assert.equal(t.store.pumps, before + 2, 'an urgent value change too');
  t.scheduler.damage(record, 'input', el, null);
  t.scheduler.damage(record, 'hover', el, null);
  await null;
  t.fw.runTasks();
  assert.equal(t.store.pumps, before + 2, 'typing (keydown precedes the value) and hover wait for the frame');
  t.step();
  assert.equal(t.store.pumps, before + 3, 'and are pumped after it');
});
