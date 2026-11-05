// Scroll compositor, store side (scroll-compose.js): what a plan vouched for is checked again where it can change.
// - ScrollPlan.cover: before its first composition the port is rendered without the scroller's content and with the cover colour as its background; one pixel of
//   another colour there is painted by something else (an element outside the scroller, which every page would carry along): the plan is refused (refusedBy.cover).
//   A scroller that is not opaque is also rendered without its content: what shows through it must be one colour.
// - ScrollPlan.pinnable: a pinned element that a change reaches is checked against the pin requirements before the next composition; one that lost them (a header
//   that turned translucent) makes the plan stale (stats.scroll.stale), and the step falls back to the plain path.
// The captures are scripted tiles (helpers.mjs makeRig): in build order, the cover tile, the backdrop tile, the pinned elements, then the pages.
import { test, assert } from '/test/unit/lib/t.js';
import { RGBA, makeRig, svgUrl, until } from './helpers.mjs';

const FRAME = { x: 10, y: 10, width: 60, height: 40 };
const COVER = /** @type {[number, number, number]} */ ([1, 254, 3]);
const FILL = `rgb(${COVER.join(',')})`;

/** @param {any} t @param {any} plan @param {any[]} script @param {(el: Element) => any} [frameRect] @param {{frame?: any, size?: [number, number]}} [o] */
async function planned(t, plan, script, frameRect, { frame = FRAME, size = [100, 60] } = {}) {
  const scroller = { scrollTop: 0, nodeType: 1, localName: 'div' };
  const rig = await makeRig(t, { frameRect, scrollPlan: () => ({ frame, port: frame, pinned: [], maxTop: 1000, scrollHeight: 1040, ...plan }) });
  const a = rig.add('a', size[0], size[1]);
  await rig.build(a);
  rig.script.push(...script);
  rig.store.scrollSettled(a, scroller);
  // the pages and the cover check's bands are post-frame jobs
  for (let k = 0; k < 100 && !rig.store.isSettled(a); k++) { rig.pump(); await new Promise((ok) => setTimeout(ok, 15)); }
  assert.ok(rig.store.isSettled(a), 'planned and built');
  return { rig, a, scroller };
}

/** one scroll step: was it promised, and composed by the commit? @param {any} r @param {number} top */
function step(r, top) {
  const c0 = r.rig.store.stats().scroll.composed;
  r.scroller.scrollTop = top;
  const promised = r.rig.store.scrollCompose(r.a, r.scroller);
  r.rig.store.commitLanded();
  return { promised, composed: r.rig.store.stats().scroll.composed - c0 };
}

/** a 60 x 40 tile of the cover colour with one pixel of `odd` at (x, y) */
const oneOff = (odd, x = 31, y = 17) => svgUrl(60, 40, `<rect width="60" height="40" fill="${FILL}"/><rect x="${x}" y="${y}" width="1" height="1" fill="${odd}"/>`);

test('cover: a port that shows only the cover colour without the scroller\'s content is composed; the cover tile is built first and not kept', async (t) => {
  const r = await planned(t, { cover: COVER, opaque: true }, [{ color: FILL }, { color: 'lime' }, { color: 'blue' }]);
  const covers = r.rig.calls.filter((c) => c.scroll?.shape === 'cover');
  assert.equal(covers.length, 1, 'one cover tile');
  assert.equal(covers[0].scroll.fill, FILL, 'rendered with the cover colour');
  assert.equal(r.rig.calls.find((c) => c.scroll), covers[0], 'before the pages');
  assert.deepEqual(step(r, 20), { promised: true, composed: 1 });
  assert.deepEqual(r.rig.css(r.a, 20, 15), RGBA.lime, 'composed from the pages');
  assert.equal(r.rig.store.stats().scroll.refusedBy.cover, 0);
});

for (const [what, url] of [['one pixel of another colour (a box with pointer-events: none over the port)', oneOff('rgb(255,0,255)')], ['one pixel one level off', oneOff('rgb(1,254,4)')], ['the corner pixel', oneOff('red', 0, 0)], ['the last pixel', oneOff('red', 59, 39)]]) {
  test(`cover: ${what} refuses the plan (refusedBy.cover): no step is composed`, async (t) => {
    const r = await planned(t, { cover: COVER, opaque: true }, [{ url }, { color: 'lime' }, { color: 'blue' }]);
    assert.deepEqual(step(r, 20), { promised: false, composed: 0 });
    const sc = r.rig.store.stats().scroll;
    assert.equal(sc.refusedBy.cover, 1);
    assert.equal(sc.refusals, 1);
  });
}

test('cover: a large port is read in bands of 262,144 pixels, one post-frame job each: one pixel off in its last row is found, a clean one composes', async (t) => {
  const BIG = { x: 10, y: 10, width: 600, height: 500 };
  const tile = (odd) => svgUrl(600, 500, `<rect width="600" height="500" fill="${FILL}"/>${odd ? '<rect x="599" y="499" width="1" height="1" fill="red"/>' : ''}`);
  const ok = await planned(t, { cover: COVER, opaque: true }, [{ url: tile(false) }, { color: 'lime' }, { color: 'blue' }], undefined, { frame: BIG, size: [620, 520] });
  assert.deepEqual(step(ok, 20), { promised: true, composed: 1 }, 'control: 300,000 pixels of the cover colour (two bands)');
  const no = await planned(t, { cover: COVER, opaque: true }, [{ url: tile(true) }, { color: 'lime' }, { color: 'blue' }], undefined, { frame: BIG, size: [620, 520] });
  assert.deepEqual(step(no, 20), { promised: false, composed: 0 }, 'the last pixel, in the second band');
  assert.equal(no.rig.store.stats().scroll.refusedBy.cover, 1);
});

test('cover: a scroller that is not opaque is also checked without its content: one colour through it composes, a gradient through it is refused', async (t) => {
  const ok = await planned(t, { cover: COVER, opaque: false }, [{ color: FILL }, { color: 'white' }, { color: 'lime' }, { color: 'blue' }]);
  assert.deepEqual(ok.rig.calls.filter((c) => c.scroll?.shape).map((c) => c.scroll.shape), ['cover', 'backdrop'], 'the cover tile and a backdrop tile');
  assert.deepEqual(step(ok, 20), { promised: true, composed: 1 }, 'control: one colour shows through it');
  const grad = svgUrl(60, 40, '<rect width="60" height="20" fill="white"/><rect y="20" width="60" height="20" fill="rgb(250,250,250)"/>');
  const no = await planned(t, { cover: COVER, opaque: false }, [{ color: FILL }, { url: grad }, { color: 'lime' }, { color: 'blue' }]);
  assert.deepEqual(step(no, 20), { promised: false, composed: 0 }, 'what shows through it changes across the port');
  assert.equal(no.rig.store.stats().scroll.refusedBy.cover, 1);
});

test('cover: an opaque scroller gets no backdrop check (what lies under it never shows); a plan without `cover` (trusted) builds no cover tile', async (t) => {
  const r = await planned(t, { cover: COVER, opaque: true }, [{ color: FILL }, { color: 'lime' }, { color: 'blue' }]);
  assert.deepEqual(r.rig.calls.filter((c) => c.scroll?.shape).map((c) => c.scroll.shape), ['cover']);
  const plain = await planned(t, { opaque: true }, [{ color: 'lime' }, { color: 'blue' }]);
  assert.equal(plain.rig.calls.filter((c) => c.scroll?.shape).length, 0);
  assert.deepEqual(step(plain, 20), { promised: true, composed: 1 });
});

const PIN = { x: 10, y: 10, width: 60, height: 8 };

/** damage, then pumps and commits until the drawable is settled (the plain tile and the pin's tile landed) @param {any} r @param {any} rect */
async function damageSettled(r, rect) {
  r.rig.store.markDamage(r.a, rect, 'mutation');
  for (let k = 0; k < 50 && !r.rig.store.isSettled(r.a); k++) { r.rig.pump(); await new Promise((ok) => setTimeout(ok, 20)); r.rig.store.commitLanded(); }
  assert.ok(r.rig.store.isSettled(r.a), 'settled after the damage');
}

/**
 * scroll steps from `top` on (2 css px each, pumps and commits between them) until one is composed, at most `n`: the pages under a changed pin are dirty until they are
 * rebuilt (a tile does not repair what lies under a pinned element) @param {any} r @param {number} top @param {number} [n] @returns {Promise<number>} the step that composed, -1: none
 */
async function composesWithin(r, top, n = 6) {
  for (let k = 0; k < n; k++) {
    if (step(r, top + 2 * k).composed) return k;
    for (let j = 0; j < 20 && !r.rig.store.isSettled(r.a); j++) { r.rig.pump(); await new Promise((ok) => setTimeout(ok, 20)); r.rig.store.commitLanded(); }
  }
  return -1;
}

test('pinnable: a pinned element that a change reaches and that still is a pin keeps the plan; one that lost the requirements makes it stale, and no step is composed', async (t) => {
  const pin = document.createElement('div');
  let ok = true;
  const r = await planned(t, { pinned: [pin], pinnable: (/** @type {Element} */ el) => el === pin && ok }, [{ color: 'black' }, { color: 'lime' }, { color: 'blue' }], (el) => (el === pin ? PIN : null));
  assert.deepEqual(step(r, 10), { promised: true, composed: 1 }, 'composed');
  assert.deepEqual(r.rig.css(r.a, 20, 12), RGBA.black, 'the pin from its tile');
  // its text changes, it stays opaque: its tile is rendered again, and the steps compose once it is back
  await damageSettled(r, { x: 12, y: 10, width: 20, height: 8 });
  assert.ok(await composesWithin(r, 14) >= 0, 'still a pin: composed');
  assert.equal(r.rig.store.stats().scroll.stale, 0);
  // it turns translucent (pinnable() now says no): the plan is stale, dropped before it composes again
  ok = false;
  await damageSettled(r, { x: 12, y: 10, width: 20, height: 8 });
  const c0 = r.rig.store.stats().scroll.composed;
  const plans = r.rig.store.stats().scroll.plans;
  assert.equal(await composesWithin(r, 30, 1), -1, 'no composition with a pin that lost the requirements');
  assert.equal(r.rig.store.stats().scroll.stale, 1, 'counted as stale');
  assert.equal(r.rig.store.stats().scroll.composed, c0, 'nothing composed');
  assert.ok(r.rig.store.stats().scroll.plans > plans, 'the scroller is planned again (the planner then reads the pin requirements)');
});

test('pinnable: damage that does not reach the pinned element does not check it again; damage that does is checked once', async (t) => {
  const pin = document.createElement('div');
  let asked = 0;
  const r = await planned(t, { pinned: [pin], pinnable: () => { asked++; return true; } }, [{ color: 'black' }, { color: 'lime' }, { color: 'blue' }], (el) => (el === pin ? PIN : null));
  await damageSettled(r, { x: 12, y: 30, width: 20, height: 5 });
  step(r, 10);
  assert.equal(asked, 0, 'a row below the pin');
  await damageSettled(r, { x: 12, y: 12, width: 20, height: 4 });
  assert.ok(await composesWithin(r, 12) >= 0, 'composed');
  assert.equal(asked, 1, 'control: a change of the pin is checked once');
  step(r, 40);
  assert.equal(asked, 1, 'and not again at the next step');
});
