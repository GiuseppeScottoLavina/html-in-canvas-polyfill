import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DamageTracker, subtractRects, WHOLE_RECT } from '../../../src/snapshot/store/damage.js';

const A = { x: 0, y: 0, width: 10, height: 10 };
const B = { x: 50, y: 0, width: 10, height: 10 };

/** @returns {{d: DamageTracker, el: object}} */
const fresh = () => ({ d: new DamageTracker(), el: {} });

test('subtractRects: cuts a hole into four pieces and keeps disjoint input untouched', () => {
  const pieces = subtractRects({ x: 0, y: 0, width: 30, height: 30 }, [{ x: 10, y: 10, width: 10, height: 10 }]);
  assert.equal(pieces.length, 4);
  const area = pieces.reduce((s, p) => s + p.width * p.height, 0);
  assert.equal(area, 900 - 100);
  assert.deepEqual(subtractRects(A, [B]), [A]);
  assert.deepEqual(subtractRects(A, [{ x: -5, y: -5, width: 100, height: 100 }]), []);
});

test('mark unions rects; take clears them and hands out increasing generations', () => {
  const { d, el } = fresh();
  d.mark(el, A, 'mutation', 1);
  d.mark(el, B, 'input', 2);
  assert.equal(d.hasPending(el), true);
  assert.equal(d.pendingSince(el), 1);
  const t1 = d.take(el);
  assert.deepEqual(t1.rect, { x: 0, y: 0, width: 60, height: 10 });
  assert.deepEqual(t1.causes.sort(), ['input', 'mutation']);
  assert.equal(d.hasPending(el), false);
  assert.equal(d.take(el), null);
  d.mark(el, A, 'input', 3);
  assert.equal(d.take(el).generation, t1.generation + 1);
});

test('a whole-drawable mark absorbs rects and a structural cause widens to whole', () => {
  const { d, el } = fresh();
  d.mark(el, A, 'input', 1);
  d.mark(el, null, 'mutation', 2);
  assert.equal(d.take(el).rect, null);
  d.mark(el, A, 'resize', 3);
  assert.equal(d.take(el).rect, null, 'resize is structural: the rect is ignored');
});

test('take records the SHAPED rect as in flight (what the tile will cover)', () => {
  const { d, el } = fresh();
  d.mark(el, A, 'input', 1);
  const grown = { x: -2, y: -2, width: 14, height: 14 };
  const t = d.take(el, () => grown);
  assert.deepEqual(t.rect, grown);
  assert.equal((d.states.get(el)?.inflight.size ?? 0), 1);
});

test('structural damage after a take bumps the epoch; the older result is no longer accepted', () => {
  const { d, el } = fresh();
  d.mark(el, A, 'input', 1);
  const old = d.take(el);
  assert.equal(d.accepts(el, old.epoch, old.generation), true);
  d.mark(el, null, 'resize', 2);
  assert.equal(d.accepts(el, old.epoch, old.generation), false);
  const next = d.take(el);
  assert.equal(next.epoch, old.epoch + 1);
  assert.equal(d.accepts(el, next.epoch, next.generation), true);
});

test('a WHOLE tile from before a DOM mutation is still accepted (a complete, newer picture); a partial one is not; a resize, dpr or stylesheet drops both', () => {
  const { d, el } = fresh();
  d.mark(el, null, 'mutation', 1);
  const whole = d.take(el);
  d.mark(el, null, 'mutation', 2);
  assert.equal(d.accepts(el, whole.epoch, whole.generation, true), true, 'a counter that changes width at 60 Hz is never starved');
  assert.equal(d.accepts(el, whole.epoch, whole.generation, false), false, 'a partial tile of that epoch may show a seam');
  d.committed(el, whole.generation);
  assert.equal(d.accepts(el, whole.epoch, whole.generation, true), false, 'never twice');
  const next = d.take(el);
  assert.equal(next.rect, null, 'the newer mutation is rebuilt');
  d.mark(el, null, 'resize', 3);
  assert.equal(d.accepts(el, next.epoch, next.generation, true), false, 'resize: the geometry of the tile is gone');
  for (const cause of ['dpr', 'stylesheet', 'content-attr', 'forced']) {
    const e = fresh();
    e.d.mark(e.el, null, 'mutation', 1);
    const w = e.d.take(e.el);
    e.d.mark(e.el, null, 'mutation', 2);
    e.d.mark(e.el, null, cause, 3);
    assert.equal(e.d.accepts(e.el, w.epoch, w.generation, true), false, `${cause} after a mutation (no second bump) still drops the older whole tile`);
  }
});

test('structural damage with nothing taken in between does not bump the epoch twice', () => {
  const { d, el } = fresh();
  d.mark(el, null, 'resize', 1);
  d.mark(el, null, 'dpr', 2);
  const t = d.take(el);
  assert.equal(t.epoch, 1);
});

test('non-structural damage after a take keeps older results acceptable (monotonic progress)', () => {
  const { d, el } = fresh();
  d.mark(el, A, 'input', 1);
  const t = d.take(el);
  d.mark(el, B, 'input', 2);
  assert.equal(d.accepts(el, t.epoch, t.generation), true);
});

test('a generation not newer than the last commit is rejected', () => {
  const { d, el } = fresh();
  d.mark(el, A, 'input', 1);
  const g1 = d.take(el);
  d.mark(el, B, 'input', 2);
  const g2 = d.take(el);
  d.committed(el, g2.generation);
  assert.equal(d.accepts(el, g1.epoch, g1.generation), false);
  assert.equal(d.accepts(el, g2.epoch, g2.generation), false, 'same generation twice');
});

test('G-out-of-order: tile 5 lands after tile 6 -> its rect is re-damaged', () => {
  const { d, el } = fresh();
  d.mark(el, A, 'input', 1);
  const t5 = d.take(el);
  d.mark(el, B, 'input', 2);
  const t6 = d.take(el);
  d.committed(el, t6.generation);
  assert.equal(d.accepts(el, t5.epoch, t5.generation), false);
  const again = d.reclaim(el, t5.rect, t5.generation);
  assert.deepEqual(again, A, 'the older, non-overlapping tile covered a region the newer one does not');
  assert.equal(d.hasPending(el), true);
  assert.equal((d.states.get(el)?.inflight.size ?? 0), 0, 'the dropped generation is settled');
  assert.deepEqual(d.take(el).rect, A);
});

test('reclaim re-damages only the part no newer tile covers', () => {
  const { d, el } = fresh();
  d.mark(el, { x: 0, y: 0, width: 20, height: 10 }, 'input', 1);
  const old = d.take(el);
  d.mark(el, { x: 0, y: 0, width: 10, height: 10 }, 'input', 2);
  const newer = d.take(el);
  d.committed(el, newer.generation);
  assert.deepEqual(d.reclaim(el, old.rect, old.generation), { x: 10, y: 0, width: 10, height: 10 });
});

test('reclaim returns null and re-damages nothing when a newer tile covers the rect', () => {
  const { d, el } = fresh();
  d.mark(el, A, 'input', 1);
  const old = d.take(el);
  d.mark(el, { x: -5, y: -5, width: 40, height: 40 }, 'input', 2);
  const newer = d.take(el);
  d.committed(el, newer.generation);
  assert.equal(d.reclaim(el, old.rect, old.generation), null);
  assert.equal(d.hasPending(el), false);
});

test('a newer whole-drawable tile covers any dropped rect; a dropped whole result is re-marked whole', () => {
  const { d, el } = fresh();
  d.mark(el, A, 'input', 1);
  const old = d.take(el);
  d.mark(el, null, 'mutation', 2);
  const whole = d.take(el);
  d.committed(el, whole.generation);
  assert.equal(d.reclaim(el, old.rect, old.generation), null);

  const e2 = fresh();
  e2.d.mark(e2.el, null, 'forced', 1);
  const w = e2.d.take(e2.el);
  assert.equal(e2.d.reclaim(e2.el, null, w.generation), WHOLE_RECT);
  assert.equal(e2.d.take(e2.el).rect, null, 'whole request stays whole');
});

test('tiles of an OLDER epoch do not count as covering (their layout is gone)', () => {
  const { d, el } = fresh();
  d.mark(el, A, 'input', 1);
  const g1 = d.take(el);
  d.mark(el, A, 'input', 2);
  const g2 = d.take(el);
  d.committed(el, g2.generation);
  d.mark(el, null, 'resize', 3);
  assert.equal(d.accepts(el, g1.epoch, g1.generation), false);
  assert.deepEqual(d.reclaim(el, g1.rect, g1.generation), A);
});

test('committed tiles are forgotten once no older generation is unresolved', () => {
  const { d, el } = fresh();
  d.mark(el, A, 'input', 1);
  const g1 = d.take(el);
  d.mark(el, B, 'input', 2);
  const g2 = d.take(el);
  d.committed(el, g2.generation);
  assert.equal(d.states.get(el).committedTiles.length, 1);
  d.reclaim(el, g1.rect, g1.generation);
  assert.equal(d.states.get(el).committedTiles.length, 0);
  assert.equal((d.states.get(el)?.inflight.size ?? 0), 0);
});

test('forget drops all state; an unknown element accepts nothing', () => {
  const { d, el } = fresh();
  d.mark(el, A, 'input', 1);
  const t = d.take(el);
  d.forget(el);
  assert.equal(d.accepts(el, t.epoch, t.generation), false);
  assert.equal(d.reclaim(el, t.rect, t.generation), null);
  assert.equal(d.hasPending(el), false);
});

test('in-flight tiles of an older epoch do not count as covering either', () => {
  const { d, el } = fresh();
  d.mark(el, A, 'input', 1);
  const g1 = d.take(el);
  d.mark(el, A, 'input', 2);
  d.take(el);
  d.mark(el, null, 'resize', 3);
  assert.deepEqual(d.reclaim(el, g1.rect, g1.generation), A);
});

test('pendingScroll: scroll damage alone, or with hover inside the scrolled box; anything else, or hover outside it, is not', () => {
  const riders = new Set(['hover']);
  const list = { x: 0, y: 0, width: 100, height: 300 };
  let { d, el } = fresh();
  assert.equal(d.pendingScroll(el, riders), false, 'nothing pending');
  d.mark(el, list, 'scroll', 0);
  assert.equal(d.pendingScroll(el, riders), true);
  d.mark(el, { x: 0, y: 40, width: 100, height: 30 }, 'hover', 0);
  assert.equal(d.pendingScroll(el, riders), true, 'a row under the still pointer rides along');
  d.mark(el, { x: 120, y: 40, width: 30, height: 30 }, 'hover', 0);
  assert.equal(d.pendingScroll(el, riders), false, 'hover outside the scrolled box does not');
  ({ d, el } = fresh());
  d.mark(el, list, 'scroll', 0);
  d.mark(el, { x: 0, y: 40, width: 10, height: 10 }, 'mutation', 0);
  assert.equal(d.pendingScroll(el, riders), false, 'a DOM change keeps every limit');
  ({ d, el } = fresh());
  d.mark(el, { x: 0, y: 40, width: 10, height: 10 }, 'hover', 0);
  assert.equal(d.pendingScroll(el, riders), false, 'hover without scroll');
  ({ d, el } = fresh());
  d.mark(el, null, 'scroll', 0);
  assert.equal(d.pendingScroll(el, riders), false, 'whole-drawable damage');
  ({ d, el } = fresh());
  d.mark(el, list, 'scroll', 0);
  d.take(el);
  assert.equal(d.pendingScroll(el, riders), false, 'taken');
});

test('pendingScroll: a rider may reach past the scrolled box by the slack (its ink margin), not further', () => {
  const riders = new Set(['hover']);
  const { d, el } = fresh();
  d.mark(el, { x: 10, y: 10, width: 100, height: 300 }, 'scroll', 0);
  d.mark(el, { x: -14, y: 40, width: 148, height: 80 }, 'hover', 0);
  assert.equal(d.pendingScroll(el, riders), false);
  assert.equal(d.pendingScroll(el, riders, 25), true);
  assert.equal(d.pendingScroll(el, riders, 23), false);
});
