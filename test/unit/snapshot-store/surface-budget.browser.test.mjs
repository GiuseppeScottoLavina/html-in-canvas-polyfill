// options.maxTotalSurfaceBytes bounds every retained surface of an install: drawable surfaces, surfaces that ElementImages keep alive (pinned), and the scroll
// compositor's pages and tiles. What does not fit is degraded (a smaller raster, a refusal, a caret blink skipped, fewer scroll pages) and reported once per cause
// (`surface-size`); a pinned surface is never written and a drawable keeps its last picture. Each test has a control with an ample budget.
import { test, assert } from '/test/unit/lib/t.js';
import { RGBA, allPixels, makeRig, pixel, samePixels, until } from './helpers.mjs';

/** a 100x60 drawable plus 4 px of ink on every side at scale 1 */
const ONE = 108 * 68 * 4;
const A = { x: 10, y: 10, width: 20, height: 20 };
const sizeReports = (rig) => rig.reports.unsupported.filter((u) => u.feature === 'surface-size');
const within = (rig) => {
  const s = rig.store.stats();
  assert.ok(s.surfaceBytes <= rig.options.maxTotalSurfaceBytes, `surfaceBytes ${s.surfaceBytes} > budget ${rig.options.maxTotalSurfaceBytes}`);
  return s;
};

// ---------------------------------------------------------------------------------------------- A: surfaces pinned by ElementImages

/** @param {number} budget */
async function pinnedPartial(t, budget) {
  const rig = await makeRig(t, budget ? { options: { maxTotalSurfaceBytes: budget } } : {});
  const a = rig.add('a', 100, 60);
  await rig.build(a);
  const pinned = rig.store.pin(a);
  const before = allPixels(pinned.surface);
  rig.color = 'lime';
  await rig.build(a, A);
  if (!rig.store.isSettled(a)) { rig.pump(); await until(() => rig.store.hasLanded(), 3000, 'the re-planned tile'); rig.store.commitLanded(); }
  return { rig, a, pinned, before };
}

test('A: a tile beside a pinned surface fits the budget: rasterised smaller, reported, the pinned pixels untouched', async (t) => {
  const { rig, a, pinned, before } = await pinnedPartial(t, Math.floor(ONE * 1.5));
  within(rig);
  const v = rig.store.version(a);
  assert.ok(v.scale < 1, `reduced raster scale, got ${v.scale}`);
  assert.deepEqual(pixel(v.surface, 50 * v.scale, 30 * v.scale), RGBA.lime, 'the drawable shows the new content');
  assert.ok(samePixels(allPixels(pinned.surface), before), 'the ElementImage keeps its exact pixels');
  assert.ok(sizeReports(rig).length >= 1, 'surface-size reported');
});

test('A control: with an ample budget the pinned surface is copied at full scale and nothing is reported', async (t) => {
  const { rig, a, pinned, before } = await pinnedPartial(t, 0);
  const s = within(rig);
  assert.equal(s.surfaceBytes, 2 * ONE, 'the pinned surface and its copy');
  assert.equal(rig.store.version(a).scale, 1);
  assert.deepEqual(rig.css(a, 15, 15), RGBA.lime);
  assert.ok(samePixels(allPixels(pinned.surface), before));
  assert.equal(sizeReports(rig).length, 0);
});

/** four drawables, each pinned, then one batch of whole tiles @param {number} budget */
async function pinnedBatch(t, budget) {
  const rig = await makeRig(t, budget ? { options: { maxTotalSurfaceBytes: budget } } : {});
  const els = ['a', 'b', 'c', 'd'].map((id) => rig.add(id, 100, 60));
  for (const el of els) await rig.build(el);
  const pins = els.map((el) => rig.store.pin(el));
  rig.color = 'lime';
  for (const el of els) rig.store.markDamage(el, null, 'input');
  const r = rig.store.pump(performance.now(), { ...rig.budget, maxInFlight: 8 });
  assert.equal(r.started, 4, 'one batch: every build is planned before any commit');
  await until(() => rig.store.isSettled(els[3]) || rig.store.hasLanded(), 3000, 'the batch');
  await new Promise((ok) => setTimeout(ok, 50));
  rig.store.commitLanded();
  return { rig, els, pins };
}

test('A: a batch of whole tiles beside pinned surfaces is checked at commit: what does not fit keeps its last picture, and is built once the images are closed', async (t) => {
  const { rig, els, pins } = await pinnedBatch(t, 6 * ONE);
  within(rig);
  // the re-planned drawables are refused (no room beside the pinned surfaces): they show their last picture
  rig.pump();
  await new Promise((ok) => setTimeout(ok, 50));
  rig.store.commitLanded();
  within(rig);
  const shown = els.map((el) => rig.css(el, 50, 30));
  assert.equal(shown.filter((p) => samePixels(p, RGBA.lime)).length, 2, 'two new surfaces fit beside the four pinned ones');
  assert.equal(shown.filter((p) => samePixels(p, RGBA.red)).length, 2, 'the others keep their last picture (never blank)');
  for (const p of pins) assert.deepEqual(pixel(p.surface, 54, 34), RGBA.red, 'every ElementImage keeps its pixels');
  assert.ok(sizeReports(rig).length >= 1, 'surface-size reported');
  for (const p of pins) rig.store.unpin(p);
  rig.pump();
  await until(() => rig.store.hasLanded(), 3000, 'the builds once the images are closed');
  rig.store.commitLanded();
  for (const el of els) assert.deepEqual(rig.css(el, 50, 30), RGBA.lime, `${el.id} is built once memory is free`);
  within(rig);
});

test('A control: with an ample budget the batch commits every tile and nothing is reported', async (t) => {
  const { rig, els } = await pinnedBatch(t, 0);
  const s = within(rig);
  assert.equal(s.surfaceBytes, 8 * ONE);
  for (const el of els) assert.deepEqual(rig.css(el, 50, 30), RGBA.lime);
  assert.equal(sizeReports(rig).length, 0);
});

// ---------------------------------------------------------------------------------------------- B: caret blinks on a pinned surface

/** a page that captures an ElementImage at every paint and keeps it: the caret blinks 10 times @param {number} budget */
async function pinnedBlinks(t, budget) {
  const rig = await makeRig(t, budget ? { options: { maxTotalSurfaceBytes: budget } } : {});
  const a = rig.add('a', 100, 60);
  rig.script.push({ caret: { rect: { x: 10, y: 10, width: 2, height: 16 }, color: 'rgb(0,0,255)' } });
  await rig.build(a);
  const pins = [];
  const caretShown = [];
  for (let i = 0; i < 10; i++) {
    pins.push({ v: rig.store.pin(a), px: allPixels(rig.store.version(a).surface) });
    rig.store.markDamage(a, null, 'caret');
    rig.store.commitLanded();
    caretShown.push(samePixels(rig.css(a, 11, 15), RGBA.blue));
  }
  return { rig, a, pins, caretShown };
}

test('B: caret blinks never copy a pinned surface beyond the budget: the blink is skipped and reported, the picture stays', async (t) => {
  const { rig, a, pins, caretShown } = await pinnedBlinks(t, 2 * ONE);
  within(rig);
  for (const p of pins) assert.ok(samePixels(allPixels(p.v.surface), p.px), 'every ElementImage keeps its exact pixels');
  assert.ok(sizeReports(rig).length >= 1, 'surface-size reported');
  assert.deepEqual(rig.css(a, 50, 30), RGBA.red, 'the drawable keeps its picture');
  assert.equal(caretShown[0], false, 'the first blink fitted beside the pinned surface: the caret was lifted');
  assert.ok(caretShown.every((x) => x === false), 'later blinks are skipped: the picture stays as it was');
});

test('B control: with an ample budget every blink copies the pinned surface and nothing is reported', async (t) => {
  const { rig, caretShown } = await pinnedBlinks(t, 0);
  const s = within(rig);
  assert.equal(s.surfaceBytes, 11 * ONE, 'ten pinned surfaces and the current one');
  assert.deepEqual(caretShown, [false, true, false, true, false, true, false, true, false, true]);
  assert.equal(sizeReports(rig).length, 0);
});

// ---------------------------------------------------------------------------------------------- C: scroll compositor pages and tiles

const FRAME = { x: 10, y: 10, width: 60, height: 40 };
const PAGE = 60 * 40 * 4;

/** @param {number} budget */
async function scrolled(t, budget) {
  const scroller = { scrollTop: 0, nodeType: 1, localName: 'div' };
  const rig = await makeRig(t, { options: budget ? { maxTotalSurfaceBytes: budget } : {}, scrollPlan: () => ({ frame: FRAME, port: FRAME, pinned: [], maxTop: 1000, scrollHeight: 1040 }) });
  const a = rig.add('a', 100, 60);
  await rig.build(a);
  rig.script.push({ color: 'lime' }, { color: 'blue' }, { color: 'black' });
  rig.store.scrollCompose(a, scroller);
  rig.store.scrollSettled(a, scroller);
  rig.pump();
  await until(() => rig.store.isSettled(a), 3000, 'pages decoded');
  scroller.scrollTop = 20;
  const composed = rig.store.scrollCompose(a, scroller);
  rig.store.commitLanded();
  return { rig, a, scroller, composed };
}

test('C: scroll pages count toward the budget: fewer pages are kept, reported, and they still compose', async (t) => {
  const { rig, a, composed } = await scrolled(t, ONE + Math.floor(2.5 * PAGE));
  const s = rig.store.stats();
  assert.ok(ONE + s.scroll.pages * PAGE <= rig.options.maxTotalSurfaceBytes, `${s.scroll.pages} pages built: more than the budget holds`);
  within(rig);
  assert.equal(s.scroll.pages, 2, 'two pages of the three it plans at an ample budget');
  assert.equal(s.surfaceBytes, ONE + s.scrollSurfaceBytes, 'surfaceBytes counts the pages it holds');
  assert.equal(composed, true, 'the two pages cover the port at 20');
  assert.deepEqual(rig.css(a, 20, 15), RGBA.lime);
  assert.deepEqual(rig.css(a, 20, 45), RGBA.blue);
  assert.ok(sizeReports(rig).length >= 1, 'surface-size reported');
});

test('C: a scroller without room for two pages is not planned: the step is built instead, reported', async (t) => {
  const { rig, a, composed } = await scrolled(t, ONE + Math.floor(1.5 * PAGE));
  const s = within(rig);
  assert.equal(s.scroll.pages, 0);
  assert.equal(composed, false, 'the plain path serves the step');
  assert.ok(sizeReports(rig).length >= 1, 'surface-size reported');
  // the scheduler damages a step that is not composed (the page colours left unused are dropped)
  rig.script.length = 0;
  rig.color = 'black';
  await rig.build(a, FRAME, 'scroll');
  assert.deepEqual(rig.css(a, 20, 15), RGBA.black, 'the step is built');
});

test('C control: with an ample budget the pages are kept and counted, the step is composed, nothing is reported', async (t) => {
  const { rig, a, composed } = await scrolled(t, 0);
  const s = within(rig);
  assert.equal(composed, true);
  assert.deepEqual(rig.css(a, 20, 15), RGBA.lime);
  assert.equal(s.scrollSurfaceBytes, s.scroll.pages * PAGE, 'every page it built is counted');
  assert.equal(s.surfaceBytes, ONE + s.scrollSurfaceBytes);
  assert.equal(sizeReports(rig).length, 0);
});

test('C: a drawable surface that needs the room takes it from the scroll pages (the plain path serves the scroller)', async (t) => {
  const { rig, a, scroller } = await scrolled(t, 2 * ONE + PAGE);
  rig.store.commitLanded();
  assert.ok(rig.store.stats().scrollSurfaceBytes > PAGE, 'pages are held');
  const pinned = rig.store.pin(a);
  scroller.scrollTop = 30;
  assert.equal(rig.store.scrollCompose(a, scroller), true, 'a composition is promised to the next commit');
  rig.color = 'blue';
  await rig.build(a, { x: 80, y: 0, width: 10, height: 10 });
  const s = within(rig);
  assert.deepEqual(rig.css(a, 85, 5), RGBA.blue, 'the tile beside the pinned surface is committed at full scale');
  assert.equal(rig.store.version(a).scale, 1);
  assert.equal(s.scrollSurfaceBytes, 0, 'the pages gave way');
  assert.equal(rig.store.isSettled(a), false, 'the promised step became scroll damage');
  rig.color = 'black';
  rig.pump();
  await until(() => rig.store.hasLanded(), 3000, 'the fallback build');
  rig.store.commitLanded();
  assert.deepEqual(rig.css(a, 20, 15), RGBA.black, 'the plain path served the step');
  within(rig);
  rig.store.unpin(pinned);
});

// ---------------------------------------------------------------------------------------------- D: recovery from a refusal once memory is freed

/** one drawable whose surface takes the whole budget, pinned: its next build is refused @param {number} budget */
async function refusedWhilePinned(t, budget) {
  const rig = await makeRig(t, { options: { maxTotalSurfaceBytes: budget } });
  const a = rig.add('a', 100, 60);
  await rig.build(a);
  const pinned = rig.store.pin(a);
  rig.color = 'lime';
  rig.store.markDamage(a, A, 'input');
  const unsettled = rig.store.isSettled(a);
  const r = rig.pump();
  return { rig, a, pinned, unsettled, started: r.started };
}

test('D: a build refused beside the pinned current surface is retried when the image is closed; a refused drawable does not keep the loop busy; the limit holds', async (t) => {
  const { rig, a, pinned, unsettled, started } = await refusedWhilePinned(t, ONE);
  assert.equal(unsettled, false, 'damage waiting for a build is not settled (control)');
  assert.equal(started, 0, 'refused: no room beside the pinned surface');
  assert.ok(sizeReports(rig).length >= 1, 'surface-size reported');
  assert.deepEqual(rig.css(a, 50, 30), RGBA.red, 'the drawable keeps its last picture (never blank)');
  assert.equal(rig.store.isSettled(a), true, 'a refusal that nothing but freed memory can lift is settled: the scheduler stops ticking');
  assert.equal(rig.store.needsPump(), false, 'no pump is owed while it is refused');
  rig.store.unpin(pinned);
  assert.equal(rig.store.needsPump(), true, 'closing the image re-opens the refused build');
  rig.pump();
  await until(() => rig.store.hasLanded(), 3000, 'the build once the image is closed');
  rig.store.commitLanded();
  assert.deepEqual(rig.css(a, 15, 15), RGBA.lime, 'the change made while it was refused is shown');
  within(rig);
  rig.color = 'blue';
  await rig.build(a, A, 'mutation');
  assert.deepEqual(rig.css(a, 15, 15), RGBA.blue, 'and later changes are built as usual');
  assert.equal(rig.store.version(a).scale, 1);
  within(rig);
});

test('D control: with an ample budget the same build is not refused, and pending damage keeps a drawable unsettled', async (t) => {
  const { rig, a, pinned, unsettled, started } = await refusedWhilePinned(t, 4 * ONE);
  assert.equal(unsettled, false, 'damage waiting for a build is not settled');
  assert.equal(started, 1);
  await until(() => rig.store.hasLanded(), 3000, 'the build');
  rig.store.commitLanded();
  assert.deepEqual(rig.css(a, 15, 15), RGBA.lime);
  assert.equal(sizeReports(rig).length, 0);
  rig.store.unpin(pinned);
  within(rig);
});

test('D: removing the drawable that holds the budget lets a refused one be built', async (t) => {
  const rig = await makeRig(t, { options: { maxTotalSurfaceBytes: ONE } });
  const a = rig.add('a', 100, 60);
  await rig.build(a);
  rig.color = 'lime';
  const b = rig.add('b', 100, 60);
  assert.equal(rig.pump().started, 0, 'b does not fit beside a');
  assert.equal(rig.store.isSettled(b), true, 'the refused drawable is settled');
  rig.remove(a);
  assert.equal(rig.store.needsPump(), true, 'the freed surface re-opens the refused build');
  rig.pump();
  await until(() => rig.store.hasLanded(), 3000, 'the build of b');
  rig.store.commitLanded();
  assert.deepEqual(rig.css(b, 50, 30), RGBA.lime);
  within(rig);
});

// ---------------------------------------------------------------------------------------------- E: backdrops of the text overlay

const FIELD = { x: 10, y: 10, width: 40, height: 20 };
/** the field's content box in surface pixels at scale 1, ink 4 */
const PAD = 40 * 20 * 4;
const gradientPlan = { box: FIELD, fill: null, text: 'x', color: 'black', x: 12, baseline: 25, font: '10px sans-serif', letterSpacing: '0px', wordSpacing: '0px', kerning: 'auto', caret: null };

/** a field over a non-uniform background: its overlay needs a backdrop tile @param {number} budget */
async function overlaid(t, budget) {
  const control = document.createElement('input');
  const rig = await makeRig(t, { options: { maxTotalSurfaceBytes: budget }, textOverlay: () => gradientPlan, frameRect: () => ({ x: 8, y: 8, width: 44, height: 24 }) });
  const a = rig.add('a', 100, 60);
  await rig.build(a);
  rig.store.overlayText(a, control);
  rig.store.commitLanded();
  rig.color = 'blue';
  rig.pump();
  await until(() => rig.store.isSettled(a) || rig.store.hasLanded(), 3000, 'the backdrop');
  await new Promise((ok) => setTimeout(ok, 30));
  rig.store.commitLanded();
  const backdrops = rig.calls.filter((c) => c.hideText === control).length;
  return { rig, a, control, backdrops };
}

test('E: an overlay backdrop is counted in the budget and the stats, and is released when the drawable changes or goes', async (t) => {
  const { rig, a, backdrops } = await overlaid(t, 4 * ONE);
  assert.equal(backdrops, 1, 'one backdrop tile was built');
  assert.deepEqual(rig.css(a, 20, 15), RGBA.blue, 'the overlay painted the backdrop');
  const s = within(rig);
  assert.equal(s.surfaceBytes, ONE + PAD, 'surfaceBytes counts the backdrop');
  rig.store.markDamage(a, null, 'focus');
  assert.equal(within(rig).surfaceBytes, ONE, 'a change that is not typing (the key of the backdrop) releases it');
  rig.store.overlayText(a, document.createElement('input'));
  rig.store.commitLanded();
  rig.pump();
  await until(() => rig.store.isSettled(a) || rig.store.hasLanded(), 3000, 'the second backdrop');
  await new Promise((ok) => setTimeout(ok, 30));
  assert.equal(rig.store.stats().surfaceBytes, ONE + PAD);
  rig.remove(a);
  assert.equal(rig.store.stats().surfaceBytes, 0, 'removing the drawable releases its backdrop');
});

test('E: a backdrop that does not fit the budget is not built: the field takes the normal snapshot path, the limit holds', async (t) => {
  const { rig, a, backdrops } = await overlaid(t, ONE + PAD - 4);
  assert.equal(backdrops, 0, 'no backdrop tile');
  within(rig);
  assert.ok(sizeReports(rig).length >= 1, 'surface-size reported');
  assert.deepEqual(rig.css(a, 5, 5), RGBA.red, 'the drawable keeps its picture');
});

// ---------------------------------------------------------------------------------------------- F: scroll caches give way progressively

test('F: a surface that needs room sheds the scroll caches served least recently first, and only as many as it needs', async (t) => {
  const plan = () => ({ frame: FRAME, port: FRAME, pinned: [], maxTop: 1000, scrollHeight: 1040 });
  const rig = await makeRig(t, { options: { maxTotalSurfaceBytes: 3 * ONE + 5 * PAGE }, scrollPlan: plan });
  const sa = { scrollTop: 0, nodeType: 1, localName: 'div' };
  const sb = { scrollTop: 0, nodeType: 1, localName: 'div' };
  const a = rig.add('a', 100, 60);
  const b = rig.add('b', 100, 60);
  await rig.build(a);
  await rig.build(b);
  for (const [el, sc] of [[b, sb], [a, sa]]) {
    rig.store.scrollCompose(el, sc);
    rig.store.scrollSettled(el, sc);
    rig.pump();
    await until(() => rig.store.isSettled(el), 3000, 'pages decoded');
  }
  const held = rig.store.stats().scrollSurfaceBytes;
  assert.ok(held >= 4 * PAGE, `both scrollers hold pages (${held} bytes)`);
  sa.scrollTop = 10;
  assert.equal(rig.store.scrollCompose(a, sa), true, 'a composed step: the cache of a is the one served last');
  rig.store.commitLanded();
  const pinned = rig.store.pin(b);
  rig.color = 'lime';
  await rig.build(b, { x: 80, y: 0, width: 10, height: 10 });
  assert.deepEqual(rig.css(b, 85, 5), RGBA.lime, 'the copy of the pinned surface fits once a cache gave way');
  const s = within(rig);
  assert.ok(s.scrollSurfaceBytes > 0, 'the cache served last is kept');
  sa.scrollTop = 20;
  assert.equal(rig.store.scrollCompose(a, sa), true, 'a still composes from its pages');
  sb.scrollTop = 20;
  assert.equal(rig.store.scrollCompose(b, sb), false, 'the least recently served cache gave way');
  rig.store.unpin(pinned);
});
