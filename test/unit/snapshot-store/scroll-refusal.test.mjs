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
