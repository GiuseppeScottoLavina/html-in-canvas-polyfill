// Scroll compositor (snapshot/store/scroll-compose.js): a scroller whose plan was refused is planned again after newer damage OR once it moved on screen (the plan
// reads the page too: its whole port must lie in the viewport), at most every REPLAN_MS. A list that was below the fold when its scrolling began, brought into view by
// a page scroll (no damage), stayed refused for good before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScrollCompositor } from '../../../src/snapshot/store/scroll-compose.js';

function rig() {
  const clock = { t: 0 };
  const jobs = [];
  let plans = 0;
  const c = createScrollCompositor({
    plan: () => { plans++; return null; },
    capture: () => null,
    decode: () => Promise.reject(new Error('unused')),
    canvas: () => { throw new Error('unused'); },
    schedule: (_entry, run) => jobs.push(run),
    now: () => clock.t,
  });
  const pump = () => { while (jobs.length) jobs.shift()(); };
  const box = { left: 0, top: 900, width: 300, height: 200 };
  const scroller = { nodeType: 1, isConnected: true, scrollTop: 0, getBoundingClientRect: () => ({ ...box }) };
  const entry = { el: {}, surface: {}, geo: { scale: 1, widthPx: 400, heightPx: 300, ink: { left: 0, top: 0 } }, version: 1, lost: false, record: {} };
  return { c, clock, pump, box, scroller, entry, plans: () => plans };
}

test('a refused scroller is planned again once it moved on screen (a page scroll brought it into view), not while it stays where it was refused', () => {
  const r = rig();
  r.c.prepare(r.entry, r.scroller);
  r.pump();
  assert.equal(r.plans(), 1, 'planned once, refused');
  r.clock.t += 5000;
  r.c.prepare(r.entry, r.scroller);
  r.pump();
  assert.equal(r.plans(), 1, 'no damage, no move: the refusal stands');
  r.box.top = 120;
  r.c.prepare(r.entry, r.scroller);
  r.pump();
  assert.equal(r.plans(), 2, 'it moved on screen: planned again');
  r.box.top = 80;
  r.clock.t += 400;
  r.c.prepare(r.entry, r.scroller);
  r.pump();
  assert.equal(r.plans(), 2, 'at most every REPLAN_MS');
  r.clock.t += 700;
  r.c.prepare(r.entry, r.scroller);
  r.pump();
  assert.equal(r.plans(), 3);
});

test('a refused scroller is planned again after newer damage of its drawable (as before), at most every REPLAN_MS', () => {
  const r = rig();
  r.c.prepare(r.entry, r.scroller);
  r.pump();
  r.c.damaged(r.entry, { x: 0, y: 0, width: 10, height: 10 }, 'mutation');
  r.c.prepare(r.entry, r.scroller);
  r.pump();
  assert.equal(r.plans(), 1, 'too recent');
  r.clock.t += 1100;
  r.c.prepare(r.entry, r.scroller);
  r.pump();
  assert.equal(r.plans(), 2);
});

/**
 * A plan made in steps (the planner's generator): `between(c, entry, k, n)` runs between step k and k + 1 of the n-th plan. The scroller's frame is 0,0 300x200 in the drawable.
 * @param {(c: any, entry: any, k: number, n: number) => void} between @param {{whole?: boolean}} [o]
 */
function stepped(between, { whole = false } = {}) {
  const jobs = [];
  let plans = 0;
  const frame = { x: 0, y: 0, width: 300, height: 200 };
  const checked = [];
  const c = createScrollCompositor({
    plan: () => {
      plans++;
      return (function* () {
        const n = plans;
        for (let k = 0; k < 3; k++) { yield; between(c, entry, k, n); }
        return { frame, port: frame, client: frame, scrollHeight: 2000, maxTop: 1800, pinned: [], bar: null, whole, clear: (rects) => { checked.push(...rects); return true; } };
      })();
    },
    // page builds start and never land: the cache stays as installed
    capture: () => 'data:,',
    decode: () => new Promise(() => {}),
    canvas: () => { throw new Error('unused'); },
    schedule: (_entry, run) => jobs.push(run),
    now: () => 0,
  });
  const scroller = { nodeType: 1, isConnected: true, scrollTop: 0, scrollHeight: 2000, clientHeight: 200, clientWidth: 300, getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 200 }) };
  const entry = { el: {}, surface: {}, geo: { scale: 1, widthPx: 400, heightPx: 300, ink: { left: 0, top: 0 } }, version: 1, lost: false, record: { layer: { frameRect: (el) => (el === scroller ? frame : null) } } };
  c.prepare(entry, scroller);
  while (jobs.length) jobs.shift()();
  return { c, plans, checked, cached: c.scrollers(entry).length, step: () => c.step(entry, () => null) };
}

test('a plan made in steps: damage between two steps that would drop an installed plan (no rect, or one over the whole scroller) makes it again from the start; a second time it is refused', () => {
  const quiet = stepped(() => {});
  assert.equal(quiet.plans, 1, 'control: planned once');
  assert.equal(quiet.cached, 1, 'control: installed');
  assert.equal(quiet.c.stats().stale, 0);
  const once = stepped((c, entry, k, n) => { if (n === 1 && k === 0) c.damaged(entry, null, 'mutation'); });
  assert.equal(once.plans, 2, 'made again');
  assert.equal(once.c.stats().stale, 1);
  assert.equal(once.cached, 1, 'the second plan saw no change: installed');
  const twice = stepped((c, entry, k) => { if (k === 1) c.damaged(entry, { x: -5, y: -5, width: 400, height: 300 }, 'mutation'); });
  assert.equal(twice.plans, 2, 'made again once');
  assert.equal(twice.c.stats().stale, 2);
  assert.equal(twice.cached, 0, 'then refused');
  assert.equal(twice.c.stats().refusals, 1);
});

test('a plan made in steps: damage inside the scroller between two steps keeps the plan, and its port part is checked for an obstruction; damage beside it is not; a Gecko plan (whole) is made again', () => {
  const inside = stepped((c, entry, k) => { if (k === 0) c.damaged(entry, { x: 10, y: 10, width: 50, height: 20 }, 'mutation'); });
  assert.equal(inside.plans, 1, 'not made again');
  assert.equal(inside.cached, 1, 'installed');
  assert.equal(inside.c.stats().stale, 0);
  inside.step();
  assert.deepEqual(inside.checked, [{ x: 10, y: 10, width: 50, height: 20 }], 'its port part checked for an obstruction before a composition');
  const beside = stepped((c, entry, k) => { if (k === 0) c.damaged(entry, { x: 320, y: 10, width: 50, height: 20 }, 'mutation'); });
  assert.equal(beside.plans, 1);
  assert.equal(beside.cached, 1);
  beside.step();
  assert.deepEqual(beside.checked, [], 'nothing to check');
  const gecko = stepped((c, entry, k, n) => { if (n === 1 && k === 0) c.damaged(entry, { x: 10, y: 10, width: 50, height: 20 }, 'mutation'); }, { whole: true });
  assert.equal(gecko.plans, 2, 'Gecko: made again');
  assert.equal(gecko.c.stats().stale, 1);
});

test('a refusal is counted by reason: focus inside a scroller in a shadow root is `focus` (the document\'s active element is the host there), not `plan`', () => {
  const r = rig();
  const field = { nodeType: 1 };
  const shadow = { activeElement: field };
  const host = { nodeType: 1 };
  Object.assign(r.scroller, { ownerDocument: { activeElement: host, getSelection: () => null }, getRootNode: () => shadow, contains: (n) => n === field });
  r.c.prepare(r.entry, r.scroller);
  r.pump();
  assert.deepEqual(r.c.stats().refusedBy, { plan: 0, focus: 1, selection: 0, scale: 0, shape: 0, budget: 0, pinned: 0, sticky: 0, cover: 0 });
});
