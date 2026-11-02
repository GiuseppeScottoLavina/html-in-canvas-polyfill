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
