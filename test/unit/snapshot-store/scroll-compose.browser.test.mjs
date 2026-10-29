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

// WebKit (ScrollPlan.grid = 1): the image snaps box edges and scroll offsets to whole css px in its layout coordinates (frame + ink, INK = 4 here), then scales them.
// The port 10.4 .. 50.6 (frame css) is 14.4 .. 54.6 in the image: whole css px 14 .. 55, rows 42 .. 165 at DPR 3 (surface pixels would give 43 .. 164).
const GFRAME = { x: 10.4, y: 10.4, width: 60, height: 40.2 };
/** surface pixel at device row `y`, x in css @param {any} rig @param {Element} a @param {number} y */
const row = (rig, a, y) => rig.css(a, 30, y / rig.scale - rig.INK);

async function gridSetup(t, plan = {}) {
  const scroller = { scrollTop: 0, nodeType: 1, localName: 'div' };
  const rig = await makeRig(t, { scale: 3, scrollPlan: () => ({ frame: GFRAME, port: GFRAME, pinned: [], maxTop: 1000, scrollHeight: 1040, grid: 1, ...plan }) });
  const a = rig.add('a', 100, 60);
  await rig.build(a);
  return { rig, a, scroller };
}

test('on a css px grid (WebKit) pages are rendered at whole css px and composed on the port the image snapped', async (t) => {
  const { rig, a, scroller } = await gridSetup(t);
  await warm(rig, a, scroller, ['lime', 'blue']);
  const tops = rig.calls.filter((c) => c.scroll).map((c) => c.scroll.top);
  assert.ok(tops.length >= 2 && tops.every((x) => Number.isInteger(x)), `page offsets at whole css px (${tops}); WebKit renders 40.333 at 40, one device pixel off`);
  assert.ok(tops.includes(41), `the second page one port (41 css px) down (${tops})`);
  scroller.scrollTop = 20;
  assert.equal(rig.store.scrollCompose(a, scroller), true);
  rig.store.commitLanded();
  assert.deepEqual(row(rig, a, 41), RGBA.red, 'row 41: above the port');
  assert.deepEqual(row(rig, a, 42), RGBA.lime, 'row 42: the first port row (css 14), from the page at 0 shifted by 60 rows');
  assert.deepEqual(row(rig, a, 104), RGBA.lime, 'row 104: the last row of the page at 0 (port row 62 = content row 80 = 20 + 60)');
  assert.deepEqual(row(rig, a, 105), RGBA.blue, 'row 105: the page at 41 begins (content row 123 = 41 css px)');
  assert.deepEqual(row(rig, a, 164), RGBA.blue, 'row 164: the last port row (css 55 is its end)');
  assert.deepEqual(row(rig, a, 165), RGBA.red, 'row 165: below the port');
  scroller.scrollTop = 20.4;
  rig.store.scrollCompose(a, scroller);
  rig.store.commitLanded();
  assert.deepEqual([row(rig, a, 104), row(rig, a, 105)], [RGBA.lime, RGBA.blue], 'a fractional live offset is composed where the image renders it (20)');
});

test('on a css px grid a rounded port with a translucent background is refused (its corners are blended source-over, exact over opaque pages only)', async (t) => {
  const round = { tl: { x: 6, y: 6 }, tr: { x: 6, y: 6 }, br: { x: 6, y: 6 }, bl: { x: 6, y: 6 } };
  const { rig, a, scroller } = await gridSetup(t, { round, opaque: false });
  rig.script.push({ color: 'lime' }, { color: 'blue' }, { color: 'lime' });
  rig.store.scrollCompose(a, scroller);
  rig.pump();
  await until(() => rig.store.isSettled(a), 3000, 'planned');
  assert.ok(rig.store.stats().scroll.refusals >= 1, 'refused');
  assert.equal(rig.calls.filter((c) => c.scroll).length, 0, 'no page, pin or backdrop was built');
  scroller.scrollTop = 20;
  assert.equal(rig.store.scrollCompose(a, scroller), false, 'every step keeps the plain path');
});

test('a grid that is not a whole number of surface pixels (a reduced scale) is refused', async (t) => {
  const { rig, a, scroller } = await gridSetup(t, { grid: 0.5 });
  rig.store.scrollCompose(a, scroller);
  rig.pump();
  await until(() => rig.store.isSettled(a), 3000, 'planned');
  assert.ok(rig.store.stats().scroll.refusals >= 1, 'grid 0.5 at scale 3: 1.5 surface px');
});

// Gecko (ScrollPlan.whole): the image renders a scroll offset at its exact value and snaps each box edge to surface pixels on its own, so only offsets on whole surface
// pixels are composed; the plan vouched for the styles of the content, so a change inside it re-plans the scroller instead of dirtying its pages.
async function geckoSetup(t, plan = {}, scale = 2) {
  const scroller = { scrollTop: 0, nodeType: 1, localName: 'div' };
  const rig = await makeRig(t, { scale, scrollPlan: () => ({ frame: FRAME, port: FRAME, pinned: [], maxTop: 1000, scrollHeight: 1040, whole: true, opaque: true, ...plan }) });
  const a = rig.add('a', 100, 60);
  await rig.build(a);
  return { rig, a, scroller };
}

test('Gecko: a live offset on a whole surface pixel is composed, one between two (20.25 css px at scale 2) keeps the plain path', async (t) => {
  const { rig, a, scroller } = await geckoSetup(t);
  await warm(rig, a, scroller, ['lime', 'blue']);
  scroller.scrollTop = 20.5;
  assert.equal(rig.store.scrollCompose(a, scroller), true, '20.5 css px = surface row 41');
  rig.store.commitLanded();
  scroller.scrollTop = 20.25;
  assert.equal(rig.store.scrollCompose(a, scroller), false, '20.25 css px = surface row 40.5: the image shows the edges of that offset rounded one by one');
});

test('Gecko: a change inside the content drops the pages; the scroller is planned again after newer damage, at most every second (Chromium dirties them)', async (t) => {
  const { rig, a, scroller } = await geckoSetup(t);
  await warm(rig, a, scroller, ['lime', 'blue']);
  const before = rig.store.stats().scroll;
  rig.store.markDamage(a, { x: 10, y: 35, width: 60, height: 5 }, 'hover');
  const after = rig.store.stats().scroll;
  assert.equal(after.dirtied, before.dirtied, 'no page was dirtied');
  assert.equal(after.dropped, before.dropped + 1, 'the scroller was dropped');
  rig.store.markDamage(a, { x: 80, y: 0, width: 15, height: 15 }, 'mutation');
  assert.equal(rig.store.stats().scroll.dropped, after.dropped, 'a change beside the scroller drops nothing');
  scroller.scrollTop = 6;
  assert.equal(rig.store.scrollCompose(a, scroller), false, 'no pages: the plain path');
  rig.pump();
  assert.equal(rig.store.stats().scroll.plans, after.plans, 'not planned again at once (rows changing under a resting pointer would re-plan it at every step)');
  await new Promise((ok) => setTimeout(ok, 1050));
  rig.script.push({ color: 'lime' }, { color: 'blue' });
  rig.store.markDamage(a, { x: 10, y: 35, width: 60, height: 5 }, 'hover');
  rig.store.scrollCompose(a, scroller);
  rig.pump();
  assert.equal(rig.store.stats().scroll.plans, after.plans + 1, 'planned again a second later, after newer damage');
});

test('Gecko: a raster scale that is not a whole number is refused', async (t) => {
  const { rig, a, scroller } = await geckoSetup(t, {}, 1.25);
  rig.store.scrollCompose(a, scroller);
  rig.pump();
  await until(() => rig.store.isSettled(a), 3000, 'planned');
  assert.ok(rig.store.stats().scroll.refusals >= 1, 'scale 1.25 refused');
  assert.equal(rig.calls.filter((c) => c.scroll).length, 0, 'no page was built');
});

test('Gecko: a rounded port is refused, opaque or not (Gecko and the canvas antialias the arc differently)', async (t) => {
  const round = { tl: { x: 6, y: 6 }, tr: { x: 6, y: 6 }, br: { x: 6, y: 6 }, bl: { x: 6, y: 6 } };
  const { rig, a, scroller } = await geckoSetup(t, { round, opaque: true });
  rig.store.scrollCompose(a, scroller);
  rig.pump();
  await until(() => rig.store.isSettled(a), 3000, 'planned');
  assert.ok(rig.store.stats().scroll.refusals >= 1, 'refused');
  assert.equal(rig.calls.filter((c) => c.scroll).length, 0, 'no page, pin or backdrop was built');
});

/** a live scroller inside drawable `a`, wholly in the viewport (scrollWarm plans only such a port) */
function liveScroller(t, a) {
  const sc = document.createElement('div');
  sc.style.cssText = 'position:fixed;left:0;top:0;width:60px;height:40px;overflow-y:auto';
  sc.innerHTML = '<div style="height:1040px"></div>';
  a.append(sc);
  t.cleanup(() => sc.remove());
  return sc;
}

test('planned ahead (a touch-first device at rest): the scrollers a tile found get a plan and two pages, so the first step of the first gesture is composed', async (t) => {
  const rig = await makeRig(t, { scrollPlan: () => ({ frame: FRAME, port: FRAME, pinned: [], maxTop: 1000, scrollHeight: 1040 }) });
  const a = rig.add('a', 100, 60);
  const sc = liveScroller(t, a);
  rig.script.push({ color: 'red', scrollers: [sc] });
  await rig.build(a);
  rig.script.push({ color: 'lime' }, { color: 'blue' });
  const calls = rig.calls.length;
  assert.equal(rig.store.scrollWarm(rig.record), true, 'the scroller the tile found is planned');
  assert.equal(rig.calls.length, calls, 'nothing is built inside the call: the plan and pages are side builds');
  rig.pump();
  assert.equal(rig.calls.length - calls, 2, 'two pages, the one under the port and the next (AHEAD_PAGES)');
  await until(() => rig.store.isSettled(a), 3000, 'pages decoded');
  assert.equal(rig.store.scrollWarm(rig.record), false, 'planned already: nothing more to do at rest');
  sc.scrollTop = 20;
  assert.equal(rig.store.scrollCompose(a, sc), true, 'the first scroll step is composed (before: a plain build, then the plan, then the pages)');
  rig.store.commitLanded();
  assert.deepEqual(rig.css(a, 20, 15), RGBA.lime);
  assert.deepEqual(rig.css(a, 20, 45), RGBA.blue);
});

test('planned ahead once until scrolled: a cache dropped at rest is not rebuilt ahead again (no work loop on a page that changes), one dropped after a gesture is', async (t) => {
  const rig = await makeRig(t, { scrollPlan: () => ({ frame: FRAME, port: FRAME, pinned: [], maxTop: 1000, scrollHeight: 1040 }) });
  const a = rig.add('a', 100, 60);
  const sc = liveScroller(t, a);
  rig.script.push({ color: 'red', scrollers: [sc] });
  await rig.build(a);
  assert.equal(rig.store.scrollWarm(rig.record), true);
  rig.pump();
  await until(() => rig.store.isSettled(a), 3000, 'pages decoded');
  await rig.build(a, null, 'stylesheet');
  assert.equal(rig.store.stats().scroll.dropped, 1);
  assert.equal(rig.store.scrollWarm(rig.record), false, 'dropped while nobody scrolled it: not planned ahead again');
  sc.scrollTop = 20;
  assert.equal(rig.store.scrollCompose(a, sc), false, 'its gesture plans it as before');
  rig.pump();
  await until(() => rig.store.isSettled(a), 3000, 'pages decoded');
  await rig.build(a, null, 'stylesheet');
  assert.equal(rig.store.stats().scroll.dropped, 2);
  assert.equal(rig.store.scrollWarm(rig.record), true, 'scrolled since: planned ahead again');
});

test('planning ahead skips a scroller that left the drawable, no longer overflows, or whose port is not wholly in the viewport', async (t) => {
  const rig = await makeRig(t, { scrollPlan: () => ({ frame: FRAME, port: FRAME, pinned: [], maxTop: 1000, scrollHeight: 1040 }) });
  const a = rig.add('a', 100, 60);
  const sc = liveScroller(t, a);
  rig.script.push({ color: 'red', scrollers: [sc] });
  await rig.build(a);
  sc.style.top = `${innerHeight - 10}px`;
  assert.equal(rig.store.scrollWarm(rig.record), false, 'below the fold: its plan would be refused');
  sc.style.top = '0px';
  /** @type {HTMLElement} */ (sc.firstElementChild).style.height = '10px';
  assert.equal(rig.store.scrollWarm(rig.record), false, 'nothing to scroll');
  /** @type {HTMLElement} */ (sc.firstElementChild).style.height = '1040px';
  sc.remove();
  assert.equal(rig.store.scrollWarm(rig.record), false, 'gone');
});

test('a finger landing stops what is planned ahead and still waits to be built (its gesture must not wait for it); the scroller is planned ahead again at the next rest', async (t) => {
  const rig = await makeRig(t, { scrollPlan: () => ({ frame: FRAME, port: FRAME, pinned: [], maxTop: 1000, scrollHeight: 1040 }) });
  const a = rig.add('a', 100, 60);
  const sc = liveScroller(t, a);
  rig.script.push({ color: 'red', scrollers: [sc] });
  await rig.build(a);
  const calls = rig.calls.length;
  assert.equal(rig.store.scrollWarm(rig.record), true);
  rig.store.scrollYield();
  rig.pump();
  assert.equal(rig.calls.length, calls, 'the plan queued before the finger landed is not made, no page is built');
  assert.equal(rig.store.scrollWarm(rig.record), true, 'planned ahead again later');
  rig.pump({ ...rig.budget, mainThreadMs: 0 });
  assert.equal(rig.calls.length, calls, 'one side job: the plan, which queues the pages');
  rig.store.scrollYield();
  rig.pump();
  assert.equal(rig.calls.length, calls, 'the pages queued before the finger landed are not built');
  sc.scrollTop = 20;
  assert.equal(rig.store.scrollCompose(a, sc), false, 'its gesture plans it as before');
  rig.script.push({ color: 'lime' }, { color: 'blue' }, { color: 'lime' }, { color: 'blue' });
  rig.pump();
  assert.ok(rig.calls.length > calls, 'and its pages are built');
});
