import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunawayGuard, RUNAWAY_MIN_COMMITS, RUNAWAY_WINDOW_MS } from '../../../src/snapshot/store/runaway.js';

/** Feeds `n` commits `gapMs` apart starting at `t0`; returns the clock after the last one. */
function feed(guard, n, gapMs, t0 = 0) {
  let t = t0;
  for (let i = 0; i < n; i++) { t += gapMs; guard.commit(t); }
  return t;
}

test('commits at 30 per second for 3 seconds with no outside damage trip the guard exactly once', () => {
  const trips = [];
  const guard = createRunawayGuard({ onTrip: (i) => trips.push(i) });
  feed(guard, 400, 1000 / 30);
  assert.equal(trips.length, 1);
  assert.ok(trips[0].commits >= RUNAWAY_MIN_COMMITS);
  assert.equal(trips[0].windowMs, RUNAWAY_WINDOW_MS);
});

test('control: the same commit rate with outside damage before every commit never trips (an animation is not a loop)', () => {
  const trips = [];
  const guard = createRunawayGuard({ onTrip: (i) => trips.push(i) });
  let t = 0;
  for (let i = 0; i < 600; i++) { t += 1000 / 30; guard.damage(i % 2 ? 'mutation' : 'animation', t); guard.commit(t); }
  assert.deepEqual(trips, []);
});

test('pipeline-internal damage (forced, geometry, resource, caret) does not count as outside damage', () => {
  const trips = [];
  const guard = createRunawayGuard({ onTrip: (i) => trips.push(i) });
  let t = 0;
  for (let i = 0; i < 200; i++) { t += 20; guard.damage(['forced', 'geometry', 'resource', 'caret'][i % 4], t); guard.commit(t); }
  assert.equal(trips.length, 1);
});

test('a burst shorter than the window, or a slow stream, does not trip; a late outside event restarts the count', () => {
  const trips = [];
  const guard = createRunawayGuard({ onTrip: (i) => trips.push(i) });
  const t1 = feed(guard, RUNAWAY_MIN_COMMITS + 10, 5); // 100 commits in half a second
  assert.deepEqual(trips, [], 'a burst is not a runaway');
  guard.damage('input', t1 + 1);
  feed(guard, 40, 100, t1 + 1000); // 10 per second for 4 s
  assert.deepEqual(trips, [], 'a slow stream is not a runaway');
});
