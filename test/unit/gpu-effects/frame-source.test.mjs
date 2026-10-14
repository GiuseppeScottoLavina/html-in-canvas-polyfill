import test from 'node:test';
import assert from 'node:assert/strict';
import { rafFrameSource, schedulerFrameSource } from '../../../src/effects/frame-source.js';

/** A display at `hz` with a virtual clock: runs queued rAF callbacks once per refresh. */
function display(hz = 120) {
  const period = 1000 / hz;
  let t = 0;
  let id = 0;
  /** @type {Map<number, (t: number) => void>} */
  const queue = new Map();
  return {
    win: {
      requestAnimationFrame: (cb) => { queue.set(++id, cb); return id; },
      cancelAnimationFrame: (i) => { queue.delete(i); },
    },
    /** advance `n` refreshes */
    run(n) { for (let i = 0; i < n; i += 1) { t += period; const cbs = [...queue.values()]; queue.clear(); for (const cb of cbs) cb(t); } },
    pending: () => queue.size,
  };
}

function canvas(attrs = {}) {
  const listeners = new Map();
  return {
    attrs,
    getAttribute: (n) => (n in attrs ? String(attrs[n]) : null),
    addEventListener: (t, l) => listeners.set(t, l),
    removeEventListener: (t) => listeners.delete(t),
    fire: (t) => listeners.get(t)?.(),
    listeners,
  };
}
const env = (d, defaultFrameCap = 0) => ({ window: d.win, options: { defaultFrameCap } });

test('rAF source is idle until woken and stops when the hook returns false', () => {
  const d = display();
  const calls = [];
  const src = rafFrameSource(env(d), canvas(), (now, info) => { calls.push(info); return calls.length < 3; });
  d.run(5);
  assert.equal(calls.length, 0, 'no wake, no frame');
  src.wake();
  src.wake();
  assert.equal(d.pending(), 1, 'wake is idempotent: one rAF');
  d.run(10);
  assert.equal(calls.length, 3, 'the hook stopped the loop by returning false');
  assert.equal(d.pending(), 0);
  src.wake();
  d.run(1);
  assert.equal(calls.length, 4, 'a later wake runs it again');
});

test('uncapped: every refresh is due', () => {
  const d = display(120);
  const dues = [];
  const src = rafFrameSource(env(d, 0), canvas(), (now, info) => { dues.push(info.due); return true; });
  src.wake();
  d.run(12);
  assert.deepEqual(dues, new Array(12).fill(true));
});

test('framecap 60 on a 120 Hz display renders every second refresh, not every 2.5th', () => {
  const d = display(120);
  let due = 0;
  let total = 0;
  const src = rafFrameSource(env(d), canvas({ framecap: 60 }), (now, info) => { total += 1; if (info.due) due += 1; assert.equal(info.frameCap, 60); return true; });
  src.wake();
  d.run(120);
  assert.equal(total, 120);
  assert.ok(Math.abs(due - 60) <= 1, `60 due frames in one second, got ${due}`);
});

test('framecap 90 on 120 Hz paces by phase (90 +- 1 per second)', () => {
  const d = display(120);
  let due = 0;
  const src = rafFrameSource(env(d), canvas({ framecap: 90 }), (now, info) => { if (info.due) due += 1; return true; });
  src.wake();
  d.run(240);
  assert.ok(Math.abs(due - 180) <= 2, `got ${due}`);
});

test('the default cap applies without the attribute; values above 240 clamp', () => {
  const d = display(240);
  const seen = [];
  const src = rafFrameSource(env(d, 30), canvas(), (now, info) => { seen.push(info.frameCap); return false; });
  src.wake();
  d.run(1);
  const src2 = rafFrameSource(env(d), canvas({ framecap: 9999 }), (now, info) => { seen.push(info.frameCap); return false; });
  src2.wake();
  d.run(1);
  assert.deepEqual(seen, [30, 240]);
});

test('a paint event on the canvas wakes the loop; remove() cancels everything', () => {
  const d = display();
  const c = canvas();
  let n = 0;
  const src = rafFrameSource(env(d), c, () => { n += 1; return false; });
  c.fire('paint');
  d.run(1);
  assert.equal(n, 1);
  src.wake();
  src.remove();
  assert.equal(d.pending(), 0);
  assert.equal(c.listeners.size, 0);
  src.wake();
  assert.equal(d.pending(), 0, 'a removed source never schedules again');
});

test('scheduler source: registers the hook and wakes through Scheduler.wake', () => {
  const log = [];
  let removed = 0;
  const scheduler = { addFrameHook: (rec, hook) => { log.push(['add', rec, hook]); return () => { removed += 1; }; }, wake: (r) => log.push(['wake', r]) };
  const rec = { id: 1 };
  const hook = () => {};
  const src = schedulerFrameSource(scheduler, rec, hook);
  assert.equal(log[0][2], hook);
  src.wake();
  assert.deepEqual(log[1], ['wake', rec]);
  src.remove();
  assert.equal(removed, 1);
});
