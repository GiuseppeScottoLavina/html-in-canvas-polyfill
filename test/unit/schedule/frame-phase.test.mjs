import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFramePhase } from '../../../src/schedule/frame-phase.js';
import { createFakeEnv } from './_fakes.mjs';

function setup(run) {
  const t = createFakeEnv();
  const log = [];
  const phase = createFramePhase(t.env, (ts) => { log.push(['run', ts]); run?.(ts, phase, t, log); });
  return { ...t, phase, log };
}

test('arm -> ARM in rAF, RUN in the frame-end observer of the SAME frame', () => {
  const t = setup();
  t.phase.arm();
  assert.equal(t.fw.rafCount(), 1);
  t.step();
  assert.equal(t.log.length, 1, 'ran in the frame that armed it');
  assert.equal(t.log[0][1], t.clock.t, 'the run receives the rAF timestamp');
  assert.deepEqual(t.phase.stats(), { armed: 1, ran: 1, fallbacks: 0 });
});

test('RUN comes after app rAF callbacks and after an app ResizeObserver created earlier (the fresh observer is created per tick)', () => {
  const t = setup();
  const order = [];
  const appTarget = { isConnected: true };
  const appRo = new t.env.window.ResizeObserver(() => order.push('app-ro'));
  t.fw.win.requestAnimationFrame(() => { order.push('app-raf'); appRo.observe(appTarget); });
  t.phase.arm();
  const origRun = t.log.push.bind(t.log);
  t.log.push = (entry) => { order.push(entry[0]); return origRun(entry); };
  t.step();
  assert.deepEqual(order, ['app-raf', 'app-ro', 'run']);
});

test('positive control: an observer created at install time would run BEFORE an app observer created later', () => {
  const t = createFakeEnv();
  const order = [];
  const target = { isConnected: true };
  const early = new t.env.window.ResizeObserver(() => order.push('early'));
  early.observe(target);
  const appRo = new t.env.window.ResizeObserver(() => order.push('app-ro'));
  appRo.observe(target);
  t.step();
  assert.deepEqual(order, ['early', 'app-ro']);
});

test('idle: no rAF, no live observer and no sentinel left after a tick that does not re-arm', () => {
  const t = setup();
  t.phase.arm();
  t.step();
  assert.equal(t.fw.rafCount(), 0);
  assert.equal(t.fw.liveObservers(), 0);
  assert.equal(t.document.added.every((el) => el.isConnected === false), true);
  const rafBefore = t.fw.counters.rafRequests;
  for (let i = 0; i < 20; i++) t.step();
  assert.equal(t.fw.counters.rafRequests, rafBefore, 'nothing is requested while idle');
});

test('the sentinel is one polyfill-owned node reused while ticks follow each other, removed at the end', () => {
  let left = 3;
  const t = setup((ts, phase) => { if (--left > 0) phase.arm(); });
  t.phase.arm();
  t.step();
  assert.equal(t.document.added.length, 1);
  assert.equal(t.document.added[0].isConnected, true, 'kept while re-arming');
  t.step();
  t.step();
  assert.equal(t.log.length, 3);
  assert.equal(t.document.added.length, 1, 'one node for the whole chain');
  assert.equal(t.document.added[0].isConnected, false);
  assert.ok('data-hic-node' in t.document.added[0].attrs, 'polyfill-owned marker');
});

test('arm() is idempotent: a second arm before the frame does not double the rAF or the run', () => {
  const t = setup();
  t.phase.arm();
  t.phase.arm();
  assert.equal(t.fw.rafCount(), 1);
  t.step();
  assert.equal(t.log.length, 1);
});

test('arm() inside the run schedules the NEXT frame', () => {
  let again = true;
  const t = setup((ts, phase) => { if (again) { again = false; phase.arm(); } });
  t.phase.arm();
  t.step();
  assert.equal(t.log.length, 1);
  assert.equal(t.fw.rafCount(), 1);
  t.step();
  assert.equal(t.log.length, 2);
});

test('fallback: when the observer is not delivered, the next rAF runs the tick and counts it; reported once', () => {
  const t = setup();
  t.fw.flags.suppressRO = true;
  t.phase.arm();
  t.step();
  assert.equal(t.log.length, 0, 'not run in the armed frame');
  t.step();
  assert.equal(t.log.length, 1, 'run by the watchdog rAF');
  assert.equal(t.phase.stats().fallbacks, 1);
  t.phase.arm();
  t.step();
  t.step();
  assert.equal(t.phase.stats().fallbacks, 2);
  assert.equal(t.reporter.deviations.filter(([id]) => id === 'paint-timing').length, 1, 'reported once per install');
});

test('cancel() drops the pending rAF, the observer and the sentinel', () => {
  const t = setup();
  t.phase.arm();
  t.step();
  t.phase.arm();
  t.phase.cancel();
  assert.equal(t.fw.rafCount(), 0);
  assert.equal(t.fw.liveObservers(), 0);
  t.step();
  assert.equal(t.log.length, 1);
});

test('a throwing run is reported and the phase stays usable', () => {
  let boom = true;
  const t = setup(() => { if (boom) { boom = false; throw new Error('boom'); } });
  t.phase.arm();
  t.step();
  assert.equal(t.reporter.errors.length, 1);
  assert.equal(t.reporter.errors[0][1], 'schedule.run');
  t.phase.arm();
  t.step();
  assert.equal(t.log.length, 2);
});
