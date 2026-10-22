import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeFrameSource, schedulerFrameSource } from '../../../src/effects/frame-source.js';

/** A display at `hz` with a virtual clock: runs queued rAF callbacks once per refresh; `afterRaf` runs after them in the same frame (the paint step). */
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
      document: { timeline: { get currentTime() { return t; } } },
      performance: { now: () => t },
    },
    /** advance `n` refreshes */
    run(n, afterRaf = null) { for (let i = 0; i < n; i += 1) { t += period; const cbs = [...queue.values()]; queue.clear(); for (const cb of cbs) cb(t); afterRaf?.(i, t); } },
    pending: () => queue.size,
    now: () => t,
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

test('native source is idle until woken and stops when the hook returns false', () => {
  const d = display();
  const calls = [];
  const src = nativeFrameSource(env(d), canvas(), (now, info) => { calls.push(info); return calls.length < 3; });
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
  const src = nativeFrameSource(env(d, 0), canvas(), (now, info) => { dues.push(info.due); return true; });
  src.wake();
  d.run(12);
  assert.deepEqual(dues, new Array(12).fill(true));
});

test('framecap 60 on a 120 Hz display renders every second refresh, not every 2.5th', () => {
  const d = display(120);
  let due = 0;
  let total = 0;
  const src = nativeFrameSource(env(d), canvas({ framecap: 60 }), (now, info) => { total += 1; if (info.due) due += 1; assert.equal(info.frameCap, 60); return true; });
  src.wake();
  d.run(120);
  assert.equal(total, 120);
  assert.ok(Math.abs(due - 60) <= 1, `60 due frames in one second, got ${due}`);
});

test('framecap 90 on 120 Hz paces by phase (90 +- 1 per second)', () => {
  const d = display(120);
  let due = 0;
  const src = nativeFrameSource(env(d), canvas({ framecap: 90 }), (now, info) => { if (info.due) due += 1; return true; });
  src.wake();
  d.run(240);
  assert.ok(Math.abs(due - 180) <= 2, `got ${due}`);
});

test('the default cap applies without the attribute; values above 240 clamp', () => {
  const d = display(240);
  const seen = [];
  const src = nativeFrameSource(env(d, 30), canvas(), (now, info) => { seen.push(info.frameCap); return false; });
  src.wake();
  d.run(1);
  const src2 = nativeFrameSource(env(d), canvas({ framecap: 9999 }), (now, info) => { seen.push(info.frameCap); return false; });
  src2.wake();
  d.run(1);
  assert.deepEqual(seen, [30, 240]);
});

test('a paint event runs the hook at once, in its frame; remove() cancels everything', () => {
  const d = display();
  const c = canvas();
  const seen = [];
  const src = nativeFrameSource(env(d), c, (now, info) => { seen.push([now, info.repeat]); return false; });
  d.run(1);
  c.fire('paint');
  assert.deepEqual(seen, [[d.now(), false]], 'called synchronously from the paint event, with the frame time');
  src.wake();
  src.remove();
  assert.equal(d.pending(), 0);
  assert.equal(c.listeners.size, 0);
  src.wake();
  c.fire('paint');
  assert.equal(d.pending(), 0, 'a removed source never schedules again');
  assert.equal(seen.length, 1);
});

test('the paint event after a rAF frame is the same frame: repeat=true, and the cap is decided once per frame', () => {
  const d = display(120);
  const c = canvas({ framecap: 60 });
  const calls = [];
  const src = nativeFrameSource(env(d), c, (now, info) => { calls.push({ now, ...info }); return true; });
  src.wake();
  d.run(120, () => c.fire('paint'));
  const raf = calls.filter((x) => !x.repeat);
  const rep = calls.filter((x) => x.repeat);
  assert.equal(raf.length, 120);
  assert.equal(rep.length, 120, 'every paint followed a rAF call of the same frame');
  for (let i = 0; i < 120; i += 1) {
    assert.equal(rep[i].now, raf[i].now);
    assert.equal(rep[i].due, raf[i].due, 'the paint event of a frame gets the decision of that frame');
  }
  const due = raf.filter((x) => x.due).length;
  assert.ok(Math.abs(due - 60) <= 1, `60 due frames per second, the paint events did not advance the pacing (got ${due})`);
});

test('a paint event in a frame without a rAF call paces that frame; a hook that wants more schedules the rAF', () => {
  const d = display(120);
  const c = canvas({ framecap: 30 });
  const calls = [];
  nativeFrameSource(env(d), c, (now, info) => { calls.push(info); return !info.due; });
  d.run(1);
  c.fire('paint');
  assert.deepEqual(calls[0], { frameCap: 30, due: true, repeat: false });
  d.run(1, () => c.fire('paint'));
  assert.equal(calls[1].due, false, 'the next refresh is not due at 30 fps');
  assert.equal(d.pending(), 1, 'not due and the hook wants a frame: a rAF is armed');
});

test('a cap set again after an uncapped stretch starts a new phase: one frame at once, then none for a whole period (no stale catch-up)', () => {
  const d = display(120);
  const c = canvas({ framecap: 1 });
  const dues = [];
  const src = nativeFrameSource(env(d), c, (now, info) => { dues.push(info.due); return true; });
  src.wake();
  d.run(120);
  delete c.attrs.framecap;
  d.run(150);
  c.attrs.framecap = 1;
  dues.length = 0;
  d.run(110);
  assert.equal(dues.filter(Boolean).length, 1, 'exactly one due frame in the first 0.9 s after the cap came back');
  assert.equal(dues[0], true, 'and it is the first one');
});

test('the attribute follows the HTML integer rules of the polyfill ("30fps" = 30)', () => {
  const d = display(120);
  const seen = [];
  nativeFrameSource(env(d), canvas({ framecap: '30fps' }), (now, info) => { seen.push(info.frameCap); return false; }).wake();
  d.run(1);
  assert.deepEqual(seen, [30]);
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
