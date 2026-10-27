// Scroll compositor, store side (scroll-compose.js): pages are built by the post-frame pump (never inside the commit or a frame), a scroll step is composed by the next
// commit once clean pages cover the live offset; damage beside the scroller keeps the pages, damage inside its content makes that part dirty until a tile repairs it,
// damage across its edge drops them; a promised composition that cannot happen falls back to ordinary scroll damage.
import { test, assert } from '/test/unit/lib/t.js';
import { RGBA, makeRig, until } from './helpers.mjs';

const FRAME = { x: 10, y: 10, width: 60, height: 40 };

async function setup(t) {
  const scroller = { scrollTop: 0, nodeType: 1, localName: 'div' };
  const rig = await makeRig(t, { scrollPlan: () => ({ frame: FRAME, port: FRAME, pinned: [], maxTop: 1000, scrollHeight: 1040 }) });
  const a = rig.add('a', 100, 60);
  await rig.build(a);
  return { rig, a, scroller };
}

/** serve until the pages are decoded; `colors` are the page colours in build order */
async function warm(rig, a, scroller, colors) {
  rig.script.push(...colors.map((color) => ({ color })));
  const calls = rig.calls.length;
  assert.equal(rig.store.scrollCompose(a, scroller), false, 'cold: no pages yet, the plain path serves this step');
  assert.equal(rig.calls.length, calls, 'nothing is planned or built inside the scroll step');
  rig.store.scrollSettled(a, scroller);
  assert.equal(rig.calls.length, calls, 'nor inside the callback that saw the scroller');
  rig.pump({ ...rig.budget, urgent: true });
  assert.equal(rig.calls.length, calls, 'nor in a pump inside the rendering update');
  rig.pump();
  assert.ok(rig.calls.length > calls, 'the post-frame pump planned it and built the pages');
  await until(() => rig.store.isSettled(a), 3000, 'pages decoded');
}

test('a scroll step is composed from cached pages by the next commit, inside the scrollport only', async (t) => {
  const { rig, a, scroller } = await setup(t);
  await warm(rig, a, scroller, ['lime', 'blue']);
  scroller.scrollTop = 20;
  assert.equal(rig.store.scrollCompose(a, scroller), true);
  assert.equal(rig.store.hasLanded(rig.record), true, 'the promised composition is work for the next commit');
  const v1 = rig.store.version(a);
  const cs = rig.store.commitLanded();
  assert.deepEqual(cs.changed, [a]);
  assert.notEqual(rig.store.version(a).id, v1.id);
  assert.deepEqual(rig.css(a, 20, 15), RGBA.lime, 'the top of the port comes from the page at 0, shifted');
  assert.deepEqual(rig.css(a, 20, 45), RGBA.blue, 'the bottom from the page at 40');
  assert.deepEqual(rig.css(a, 5, 5), RGBA.red, 'outside the port nothing changed');
  assert.deepEqual(rig.css(a, 80, 30), RGBA.red);
});

test('damage that covers the scroller drops the pages; damage elsewhere keeps them; the next step is built as usual', async (t) => {
  const { rig, a, scroller } = await setup(t);
  await warm(rig, a, scroller, ['lime', 'blue']);
  rig.store.markDamage(a, FRAME, 'scroll');
  scroller.scrollTop = 10;
  assert.equal(rig.store.scrollCompose(a, scroller), true, 'its own scroll damage keeps the pages');
  rig.store.commitLanded();
  rig.store.markDamage(a, { x: 80, y: 0, width: 15, height: 15 }, 'mutation');
  scroller.scrollTop = 20;
  assert.equal(rig.store.scrollCompose(a, scroller), true, 'a change beside the scroller (a counter) keeps them');
  rig.store.commitLanded();
  assert.ok(rig.store.stats().scroll.kept >= 1);
  rig.store.markDamage(a, { x: 0, y: 0, width: 90, height: 60 }, 'mutation');
  scroller.scrollTop = 30;
  assert.equal(rig.store.scrollCompose(a, scroller), false, 'a change that covers the scroller (an ancestor, the scroller itself) dropped them: re-planned, cold again');
  rig.store.markDamage(a, null, 'stylesheet');
  assert.equal(rig.store.scrollCompose(a, scroller), false, 'damage without a rect drops them too');
});

test('damage inside the content makes that part of the pages dirty: no composition over it until a tile repairs it', async (t) => {
  const { rig, a, scroller } = await setup(t);
  await warm(rig, a, scroller, ['lime', 'blue']);
  // content row 25..30 (css, at offset 0: frame y 35..40) changes: the page at 0 shows it, the page at 40 does not
  rig.store.markDamage(a, { x: 10, y: 35, width: 60, height: 5 }, 'hover');
  scroller.scrollTop = 4;
  assert.equal(rig.store.scrollCompose(a, scroller), false, 'the port at 4 needs the dirty rows of the page at 0');
  rig.store.commitLanded();
  assert.ok(rig.store.stats().scroll.dirtied >= 1);
  // the fallback tile (the scroller at 4, black) lands and repairs the page at 0 where it covers the dirty rows
  rig.color = 'black';
  rig.pump();
  await until(() => rig.store.hasLanded(), 3000, 'the fallback tile');
  rig.store.commitLanded();
  assert.ok(rig.store.stats().scroll.patched >= 1, 'the tile repaired the page');
  scroller.scrollTop = 6;
  assert.equal(rig.store.scrollCompose(a, scroller), true, 'composed again once repaired');
  rig.store.commitLanded();
  assert.deepEqual(rig.css(a, 20, 30), RGBA.black, 'the repaired rows come from the tile, shifted by 2');
  assert.deepEqual(rig.css(a, 20, 15), RGBA.lime, 'the rest of the page is untouched');
});

test('damage elsewhere in the content (rows scrolled out of view) dirties only the pages that show them', async (t) => {
  const { rig, a, scroller } = await setup(t);
  await warm(rig, a, scroller, ['lime', 'blue']);
  // frame y 80..85 at offset 0 = content 70..75: only the page at 40 (content 40..80) shows it
  rig.store.markDamage(a, { x: 10, y: 80, width: 60, height: 5 }, 'mutation');
  scroller.scrollTop = 10;
  assert.equal(rig.store.scrollCompose(a, scroller), true, 'the port at 10 (content 10..50) does not need the dirty rows');
  rig.store.commitLanded();
  scroller.scrollTop = 38;
  assert.equal(rig.store.scrollCompose(a, scroller), false, 'the port at 38 (content 38..78) does');
});

test('a promised composition that cannot happen any more becomes ordinary scroll damage', async (t) => {
  const { rig, a, scroller } = await setup(t);
  await warm(rig, a, scroller, ['lime', 'blue']);
  scroller.scrollTop = 20;
  assert.equal(rig.store.scrollCompose(a, scroller), true);
  scroller.scrollTop = 600;
  rig.store.commitLanded();
  assert.deepEqual(rig.css(a, 20, 15), RGBA.red, 'nothing composed (no page near 600)');
  assert.equal(rig.store.isSettled(a), false, 'the fallback damage waits for a build');
  rig.color = 'black';
  rig.pump();
  await until(() => rig.store.hasLanded(), 3000, 'the fallback build');
  rig.store.commitLanded();
  assert.deepEqual(rig.css(a, 20, 15), RGBA.black, 'the build served the step');
});

test('a tile that shows an older offset is composed over at the live one in the same commit', async (t) => {
  const { rig, a, scroller } = await setup(t);
  await warm(rig, a, scroller, ['lime', 'blue']);
  rig.deferDecode = true;
  rig.color = 'black';
  rig.store.markDamage(a, FRAME, 'scroll');
  rig.pump();
  scroller.scrollTop = 20;
  await rig.release();
  rig.store.commitLanded();
  assert.deepEqual(rig.css(a, 8, 30), RGBA.black, 'the tile was drawn (its margin, outside the port)');
  assert.deepEqual(rig.css(a, 20, 15), RGBA.lime, 'and its port, built at 0, was recomposed at 20');
  assert.deepEqual(rig.css(a, 20, 45), RGBA.blue);
});

// A plan in several steps (planSteps yields while it scans a large subtree or hit-tests the port) read the DOM before the damage that comes between its steps.
for (const [what, rect, cause] of [['a change over the port', { x: 20, y: 20, width: 8, height: 8 }, 'mutation'], ['a change of the scroller itself', null, 'style']]) {
  test(`${what} between the steps of a plan: ${rect ? 'hit-tested before the first composition' : 'the plan is not used'}`, async (t) => {
    const scroller = { scrollTop: 0, nodeType: 1, localName: 'div' };
    /** @type {any[][]} */
    const cleared = [];
    let a = null;
    const rig = await makeRig(t, {
      scrollPlan: () => (function* () {
        yield;
        rig.store.markDamage(a, rect, cause);
        return { frame: FRAME, port: FRAME, pinned: [], maxTop: 1000, scrollHeight: 1040, clear: (rects) => { cleared.push(rects); return false; } };
      })(),
    });
    a = rig.add('a', 100, 60);
    await rig.build(a);
    rig.script.push({ color: 'lime' }, { color: 'blue' }, { color: 'lime' });
    rig.store.scrollSettled(a, scroller);
    // the plan's two steps, its page builds and the build of the damage it heard; commits land the tiles
    await until(() => { rig.pump(); rig.store.commitLanded(); return rig.store.isSettled(a); }, 3000, 'settled');
    const sc = rig.store.stats().scroll;
    if (!rect) {
      assert.equal(sc.pages + sc.pins, 0, 'nothing built from a plan the scroller changed under');
      assert.equal(sc.refusals, 0, 'not a refusal: the scroller is planned again at its next scroll');
      assert.equal(cleared.length, 0);
      return;
    }
    assert.deepEqual(cleared, [[rect]], 'the change heard during the plan was hit-tested before the first composition');
    assert.equal(sc.obstructed, 1, 'and its obstruction stopped the composition');
  });
}

test('a scroll composed for 4 s with no other change is input, not a runaway loop (the guard uninstalled the polyfill)', async (t) => {
  const { rig, a, scroller } = await setup(t);
  await warm(rig, a, scroller, ['lime', 'blue', 'lime']);
  let clock = performance.now();
  rig.env.now = () => clock;
  /** @type {any[]} */
  const trips = [];
  rig.bus.on(rig.BUS.RUNAWAY, (e) => trips.push(e));
  let composed = 0;
  for (let i = 0; i < 200; i++) {
    clock += 20;
    scroller.scrollTop = i % 2 ? 10 : 20;
    if (rig.store.scrollCompose(a, scroller)) composed++;
    rig.store.commitLanded();
  }
  assert.ok(composed >= 190, `the steps were composed (${composed})`);
  assert.ok(rig.store.stats().commits >= 190, 'each one a commit');
  assert.deepEqual(trips, [], 'no runaway report');
});
