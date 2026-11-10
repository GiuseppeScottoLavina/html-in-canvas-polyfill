// Scroll compositor, store side (scroll-compose.js): the tiles of the cover check (ScrollPlan.cover, vet) where the browser's canvas is not Chromium's.
// - ScrollPlan.softCorners (WebKit): the four corner pixels of an image drawn into a canvas are not exact in Safari on macOS (27.0.1: up to 4 levels off, an alpha
//   of 253 to 255, different from one drawing to the next). The check was exact on them, so no scroller was composed there. The corner pixels of the tile are left
//   out, and nothing else: the pixel beside a corner still refuses the plan. Control: without softCorners the same tiles are refused.
// - ScrollPlan.grid (WebKit): the cover tiles are rendered with one pixel per grid cell, whatever the scale of the surface (the image is laid out in css px and
//   scaled with a transform, so the tile holds the same boxes); the pages keep the surface's scale. Control: a plan without a grid asks for the surface's scale.
// - A read that costs by the call (Safari on macOS: 40 to 50 ms for each getImageData that follows a drawing or comes in a later task, whatever its size): at the
//   first later band of a tile one pixel is read, timed; when it took more than 5 ms, the rest of each tile is read in one task instead of band by band. Control:
//   with fast reads the same port is read in bands.
import { test, assert } from '/test/unit/lib/t.js';
import { RGBA, makeRig, svgUrl } from './helpers.mjs';

const FRAME = { x: 10, y: 10, width: 60, height: 40 };
const COVER = /** @type {[number, number, number]} */ ([1, 254, 3]);
const COVER2 = /** @type {[number, number, number]} */ ([254, 1, 252]);
const COVERS = [COVER, COVER2];
const rgb = (/** @type {number[]} */ c) => `rgb(${c.join(',')})`;

/** @param {any} t @param {any} plan @param {any[]} script @param {{frame?: any, size?: [number, number], scale?: number}} [o] */
async function planned(t, plan, script, { frame = FRAME, size = [100, 60], scale } = {}) {
  const scroller = { scrollTop: 0, nodeType: 1, localName: 'div' };
  const rig = await makeRig(t, { scale, scrollPlan: () => ({ frame, port: frame, pinned: [], maxTop: 1000, scrollHeight: 1040, ...plan }) });
  const a = rig.add('a', size[0], size[1]);
  await rig.build(a);
  rig.script.push(...script);
  rig.store.scrollSettled(a, scroller);
  let rounds = 0;
  for (; rounds < 100 && !rig.store.isSettled(a); rounds++) { rig.pump(); await new Promise((ok) => setTimeout(ok, 15)); }
  assert.ok(rig.store.isSettled(a), 'planned and built');
  return { rig, a, scroller, rounds };
}

/** @param {any} r @param {number} top */
function step(r, top) {
  const c0 = r.rig.store.stats().scroll.composed;
  r.scroller.scrollTop = top;
  const promised = r.rig.store.scrollCompose(r.a, r.scroller);
  r.rig.store.commitLanded();
  return { promised, composed: r.rig.store.stats().scroll.composed - c0 };
}

/** a w x h tile of `fill` with the pixels `odd` ([x, y]) three levels off in every channel @param {number[]} fill @param {number[][]} odd */
const tile = (fill, odd, w = 60, h = 40) => svgUrl(w, h, `<rect width="${w}" height="${h}" fill="${rgb(fill)}"/>${odd.map(([x, y]) => `<rect x="${x}" y="${y}" width="1" height="1" fill="${rgb(fill.map((v) => (v > 128 ? v - 3 : v + 3)))}"/>`).join('')}`);
const CORNERS = [[0, 0], [59, 0], [0, 39], [59, 39]];
const pages = [{ color: 'lime' }, { color: 'blue' }];

test('softCorners: cover tiles whose four corner pixels are a few levels off are accepted, and the port is composed', async (t) => {
  const r = await planned(t, { cover: COVERS, opaque: true, softCorners: true }, [{ url: tile(COVER, CORNERS) }, { url: tile(COVER2, CORNERS) }, ...pages]);
  assert.equal(r.rig.store.stats().scroll.refusedBy.cover, 0);
  assert.deepEqual(step(r, 20), { promised: true, composed: 1 });
  assert.deepEqual(r.rig.css(r.a, 20, 15), RGBA.lime, 'composed from the pages');
});

test('softCorners, control: the same tiles without it refuse the plan (refusedBy.cover)', async (t) => {
  const r = await planned(t, { cover: COVERS, opaque: true }, [{ url: tile(COVER, CORNERS) }, { url: tile(COVER2, CORNERS) }, ...pages]);
  assert.equal(r.rig.store.stats().scroll.refusedBy.cover, 1);
  assert.deepEqual(step(r, 20), { promised: false, composed: 0 });
});

for (const [what, odd] of /** @type {Array<[string, number[][]]>} */ ([['the pixel right of the first corner', [[1, 0]]], ['the pixel under the first corner', [[0, 1]]],
  ['the pixel left of the last corner', [[58, 39]]], ['the pixel above the last corner', [[59, 38]]], ['the pixel diagonal to a corner', [[58, 1]]], ['a pixel in the middle', [[31, 17]]]])) {
  test(`softCorners leaves out the corner pixels only: ${what}, in the first tile or in the second, refuses the plan`, async (t) => {
    const first = await planned(t, { cover: COVERS, opaque: true, softCorners: true }, [{ url: tile(COVER, odd) }, { url: tile(COVER2, []) }, ...pages]);
    assert.equal(first.rig.store.stats().scroll.refusedBy.cover, 1, 'in the first tile');
    const second = await planned(t, { cover: COVERS, opaque: true, softCorners: true }, [{ url: tile(COVER, []) }, { url: tile(COVER2, odd) }, ...pages]);
    assert.equal(second.rig.store.stats().scroll.refusedBy.cover, 1, 'in the second tile');
    assert.deepEqual(step(second, 20), { promised: false, composed: 0 });
  });
}

test('softCorners: the backdrop check of a scroller that is not opaque leaves out its tile\'s corner pixels too, and no other', async (t) => {
  const white = [255, 255, 255];
  const ok = await planned(t, { cover: COVERS, opaque: false, softCorners: true }, [{ color: rgb(COVER) }, { color: rgb(COVER2) }, { url: tile(white, CORNERS) }, ...pages]);
  assert.equal(ok.rig.store.stats().scroll.refusedBy.cover, 0);
  assert.deepEqual(step(ok, 20), { promised: true, composed: 1 });
  const no = await planned(t, { cover: COVERS, opaque: false, softCorners: true }, [{ color: rgb(COVER) }, { color: rgb(COVER2) }, { url: tile(white, [[1, 0]]) }, ...pages]);
  assert.equal(no.rig.store.stats().scroll.refusedBy.cover, 1);
});

test('grid: the cover tiles and the backdrop check are rendered with one pixel per grid cell, the pages at the surface\'s scale', async (t) => {
  const r = await planned(t, { cover: COVERS, opaque: false, grid: 1, softCorners: true }, [{ color: rgb(COVER) }, { color: rgb(COVER2) }, { color: 'white' }, ...pages], { scale: 2 });
  const shaped = r.rig.calls.filter((c) => c.scroll?.shape);
  assert.deepEqual(shaped.map((c) => [c.scroll.shape, c.scale, c.rect]), [['cover', 1, FRAME], ['backdrop', 1, FRAME]], 'the port in css px, at scale 1');
  const page = r.rig.calls.filter((c) => c.scroll && !c.scroll.shape);
  assert.ok(page.length >= 2 && page.every((c) => c.scale === 2 && c.rect.width === 60 && c.rect.height === 40), `the pages at the surface's scale (${JSON.stringify(page.map((c) => c.scale))})`);
  assert.equal(r.rig.store.stats().scroll.refusedBy.cover, 0);
  assert.deepEqual(step(r, 20), { promised: true, composed: 1 });
});

test('grid: one pixel of a cover tile at scale 1 off (a line one css px thin over the port) refuses the plan', async (t) => {
  const r = await planned(t, { cover: COVERS, opaque: true, grid: 1, softCorners: true }, [{ url: tile(COVER, [[31, 17]]) }, { color: rgb(COVER2) }, ...pages], { scale: 2 });
  assert.equal(r.rig.store.stats().scroll.refusedBy.cover, 1);
  assert.deepEqual(step(r, 20), { promised: false, composed: 0 });
});

test('grid, controls: without a grid the cover tiles keep the surface\'s scale; on a grid at a scale of 1 they are the port as it is', async (t) => {
  const plain = await planned(t, { cover: COVERS, opaque: true }, [{ color: rgb(COVER) }, { color: rgb(COVER2) }, ...pages], { scale: 2 });
  assert.deepEqual(plain.rig.calls.filter((c) => c.scroll?.shape).map((c) => [c.scroll.shape, c.scale]), [['cover', 2]]);
  assert.deepEqual(step(plain, 20), { promised: true, composed: 1 });
  const one = await planned(t, { cover: COVERS, opaque: true, grid: 1 }, [{ color: rgb(COVER) }, { color: rgb(COVER2) }, ...pages]);
  assert.deepEqual(one.rig.calls.filter((c) => c.scroll?.shape).map((c) => [c.scroll.shape, c.scale, c.rect]), [['cover', 1, FRAME]]);
  assert.deepEqual(step(one, 20), { promised: true, composed: 1 });
});

// A port of 600 x 900 px is 540,000 pixels: three bands of 262,144 for each of its two cover tiles when a read is fast.
const TALL = { x: 10, y: 10, width: 600, height: 900 };
/** every getImageData of the page takes `ms` longer; returns the reads made since (their heights, in rows) @param {any} t @param {number} ms */
function slowReads(t, ms) {
  /** @type {number[]} */ const reads = [];
  // the pads are OffscreenCanvases where the browser has them
  for (const proto of [CanvasRenderingContext2D.prototype, globalThis.OffscreenCanvasRenderingContext2D?.prototype]) {
    if (!proto) continue;
    const real = proto.getImageData;
    proto.getImageData = function (/** @type {any[]} */ ...a) {
      if (a[2] > 1) reads.push(a[3]);
      for (const t0 = performance.now(); performance.now() - t0 < ms;);
      return real.apply(this, /** @type {any} */ (a));
    };
    t.cleanup(() => { proto.getImageData = real; });
  }
  return reads;
}
const tall = (/** @type {number[]} */ fill, /** @type {number[][]} */ odd) => tile(fill, odd, 600, 900);

test('a read that costs by the call: after a slow read of one pixel at the first later band, the rest of each tile is read in one task', async (t) => {
  const reads = slowReads(t, 8);
  const r = await planned(t, { cover: COVERS, opaque: true }, [{ url: tall(COVER, []) }, { url: tall(COVER2, []) }, ...pages], { frame: TALL, size: [620, 920] });
  // (the reads of more than one pixel) the first band of each tile as it lands; then, after the timed pixel, the rest of the first tile at once, and the rest of the second
  assert.deepEqual(reads, [436, 436, 464, 464], `rows read (${JSON.stringify(reads)})`);
  assert.equal(r.rig.store.stats().scroll.refusedBy.cover, 0);
  assert.deepEqual(step(r, 20), { promised: true, composed: 1 });
});

test('a read that costs by the call: one pixel off in the last row of the second tile is still found', async (t) => {
  slowReads(t, 8);
  const r = await planned(t, { cover: COVERS, opaque: true }, [{ url: tall(COVER, []) }, { url: tall(COVER2, [[599, 899]]) }, ...pages], { frame: TALL, size: [620, 920] });
  assert.equal(r.rig.store.stats().scroll.refusedBy.cover, 1);
  assert.deepEqual(step(r, 20), { promised: false, composed: 0 });
});

test('a read that costs by the call, control: with fast reads the same port is read in bands of 262,144 pixels', async (t) => {
  const reads = slowReads(t, 0);
  const r = await planned(t, { cover: COVERS, opaque: true }, [{ url: tall(COVER, []) }, { url: tall(COVER2, []) }, ...pages], { frame: TALL, size: [620, 920] });
  assert.ok(reads.length >= 5 && reads.every((h) => h <= 436) && reads.reduce((a, b) => a + b, 0) === 1800, `bands (${JSON.stringify(reads)})`);
  assert.deepEqual(step(r, 20), { promised: true, composed: 1 });
});
