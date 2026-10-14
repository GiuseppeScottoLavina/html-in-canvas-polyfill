// Scroll compositor, store side (scroll-compose.js): pages are built by the pump (never inside the commit), a scroll step is composed by the next commit once the pages
// cover the live offset, any other damage drops the cache, and a promised composition that cannot happen falls back to ordinary scroll damage.
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
  rig.pump();
  assert.equal(rig.calls.length, calls, 'nothing is planned or built behind the first scroll step');
  rig.store.scrollSettled(a, scroller);
  assert.equal(rig.calls.length, calls, 'pages are not built inside the settle callback either');
  rig.pump();
  assert.ok(rig.calls.length > calls, 'the pump built the pages');
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

test('damage other than the scroller own scrolling drops the pages; the next step is built as usual', async (t) => {
  const { rig, a, scroller } = await setup(t);
  await warm(rig, a, scroller, ['lime', 'blue']);
  rig.store.markDamage(a, FRAME, 'scroll');
  scroller.scrollTop = 10;
  assert.equal(rig.store.scrollCompose(a, scroller), true, 'its own scroll damage keeps the pages');
  rig.store.commitLanded();
  rig.store.markDamage(a, { x: 0, y: 0, width: 5, height: 5 }, 'mutation');
  scroller.scrollTop = 30;
  assert.equal(rig.store.scrollCompose(a, scroller), false, 'a mutation dropped them: re-planned, cold again');
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
