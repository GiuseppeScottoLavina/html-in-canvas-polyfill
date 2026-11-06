// SnapshotStore dispose and drawable removal while side builds (a scroll plan, its cover tiles and their bands, its pages) are queued or decoding. The store is kept
// after dispose, as an app keeps its HicInstalled after uninstall: nothing it still reaches may hold a surface, and nothing may wait for a pump that never comes.
// The real store runs against a controlled backend: a canvas class that records a WeakRef of every surface it makes, and decodes the test settles itself.
// Reachability is read after explicit garbage collections (a counter at zero is not proof that a surface was let go).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { createSnapshotStore } from '../../../src/snapshot/store/store.js';
import { createBus } from '../../../src/util/bus.js';
import { DEFAULT_OPTIONS } from '../../../src/api/options.js';
import { BUS } from '../../../src/contracts/events.js';

v8.setFlagsFromString('--expose-gc');
const gc = /** @type {() => void} */ (vm.runInNewContext('gc'));

/** @type {Array<{w: number, h: number, ref: WeakRef<object>}>} every surface made (pads, the drawable's surface) */
const made = [];
class Canvas {
  /** @param {number} w @param {number} h */
  constructor(w, h) {
    this.width = w;
    this.height = h;
    const ctx = {
      color: [255, 255, 255, 255], isContextLost: () => false, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, fillRect() {}, clearRect() {},
      drawImage(/** @type {any} */ src) { this.color = src.color ?? [255, 255, 255, 255]; },
      getImageData(/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ w, /** @type {number} */ h) {
        const data = new Uint8ClampedArray(w * h * 4);
        new Uint32Array(data.buffer).fill(new Uint32Array(new Uint8Array(this.color).buffer)[0]);
        return { data };
      },
    };
    this.getContext = () => ctx;
    this.addEventListener = () => {};
    this.removeEventListener = () => {};
    made.push({ w, h, ref: new WeakRef(this) });
  }
}
class Matrix {
  constructor() { Object.assign(this, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, is2D: true }); }
  multiply() { return this; }
  inverse() { return this; }
  /** @param {any} p */ transformPoint(p) { return p; }
}
Object.assign(globalThis, { OffscreenCanvas: Canvas, DOMMatrix: Matrix, DOMMatrixReadOnly: Matrix });

const W = 620, H = 520, PORT = { x: 10, y: 10, width: 600, height: 500 };
const COVERS = { cover0: [1, 254, 3, 255], cover1: [254, 1, 252, 255] };
const budget = { mainThreadMs: 0, mainThreadShare: 0.35, maxInFlight: 2, interaction: false };
const flush = async () => { for (let k = 0; k < 15; k++) await Promise.resolve(); };
/** Live surfaces after three collections, each after a task (a WeakRef read in a task keeps its target until that task ends). @param {number} [w] @param {number} [h] */
async function live(w, h) {
  for (let k = 0; k < 3; k++) { await new Promise((ok) => setImmediate(ok)); gc(); }
  return made.filter((m) => (w === undefined || (m.w === w && m.h === h)) && m.ref.deref()).length;
}

/**
 * One drawable (620 x 520) with a list whose port is 600 x 500, planned with two cover colours: its pages and cover tiles are 600 x 500 pads.
 * `defer`: decodes wait for `settle` (else they land in a microtask).
 * @param {{defer?: boolean, el?: any}} [o]
 */
function rig(o = {}) {
  const bus = createBus();
  /** @type {any[]} */ const errors = [];
  /** @type {any[]} */ const events = [];
  for (const topic of Object.values(BUS)) bus.on(topic, () => events.push(topic));
  const el = o.el ?? { localName: 'div', matches: () => false, parentElement: null, isConnected: true, getAttribute: () => null };
  const scroller = { scrollTop: 0, nodeType: 1, localName: 'div' };
  const layer = { element: {}, drawableElements: () => [el], isLaidOut: () => true, borderBoxSize: () => ({ width: W, height: H }), frameRect: (/** @type {any} */ e) => (e === scroller ? PORT : { x: 0, y: 0, width: W, height: H }) };
  const record = /** @type {any} */ ({ id: 1, canvas: {}, state: 'active', frameCap: 0, layer, contentBox: { width: W, height: H, gridScaleX: 1, gridScaleY: 1 } });
  const env = /** @type {any} */ ({
    options: { ...DEFAULT_OPTIONS, inkMargin: 0, maxDpr: 1, maxSnapshotFps: 0 }, bus, now: () => 1000,
    window: { devicePixelRatio: 1, getComputedStyle: () => ({ mixBlendMode: 'normal', backdropFilter: 'none', transformOrigin: '0px 0px' }) }, document: { activeElement: null },
    registry: { ownerOfDrawable: () => record, get: () => record, all: () => [record] },
    reporter: { unsupported() {}, deviation() {}, caught(/** @type {unknown} */ e, /** @type {string} */ where) { errors.push({ e: String(e), where }); } },
  });
  /** @param {any} req */
  const capture = (req) => {
    const rect = req.rect ?? { x: 0, y: 0, width: W, height: H };
    const urls = req.scroll?.fills ? req.scroll.fills.map((/** @type {string} */ _, /** @type {number} */ k) => `cover${k}`) : null;
    return {
      url: urls ? urls[0] : 'plain', ...(urls ? { urls } : {}), cropCss: rect, widthPx: rect.width, heightPx: rect.height, nodes: 1, complete: true, unsupported: [],
      layoutOffset: { x: 0, y: 0 }, caret: null, timings: { cloneMs: 0, cssMs: 0, shakeMs: 0, svgMs: 0, bytes: 1 },
    };
  };
  /** @type {Array<{url: string, settle: () => void, fail: () => void}>} */ const pending = [];
  /** images handed out, and those whose src was cleared (released) */
  const images = { made: 0, released: 0 };
  /** @param {string} url */
  const image = (url) => {
    images.made++;
    let src = url;
    return { complete: true, naturalWidth: W, color: /** @type {any} */ (COVERS)[url] ?? [255, 255, 255, 255], get src() { return src; }, set src(v) { if (v === '' && src !== '') images.released++; src = v; } };
  };
  const decode = (/** @type {string} */ url) => (o.defer
    ? new Promise((resolve, reject) => { pending.push({ url, settle: () => resolve(image(url)), fail: () => reject(new Error('decode failed')) }); })
    : Promise.resolve(image(url)));
  const store = createSnapshotStore(env, /** @type {any} */ (capture), { decode, scrollPlan: () => ({ frame: PORT, port: PORT, pinned: [], maxTop: 1000, scrollHeight: 1500, cover: [[1, 254, 3], [254, 1, 252]], opaque: true }) });
  const r = {
    store, bus, el, scroller, record, errors, events, pending, images,
    pump: async () => { store.pump(1000, budget); await flush(); },
    /** settles the oldest deferred decode whose url starts with `prefix` */
    settle: async (/** @type {string} */ prefix) => {
      const i = pending.findIndex((p) => p.url.startsWith(prefix));
      assert.ok(i >= 0, `a pending decode of ${prefix}`);
      pending.splice(i, 1)[0].settle();
      await flush();
    },
    /** the first tile committed, then the list planned (the plan is queued as a side job) */
    async planned() {
      bus.emit(BUS.DRAWABLES_CHANGED, { record, added: [el], removed: [] });
      store.pump(1000, budget);
      await flush();
      if (o.defer) await r.settle('plain');
      store.commitLanded();
      store.scrollSettled(el, scroller);
    },
  };
  return r;
}

/** The plan made and its first side build (the cover tiles, one capture) run: both cover decodes started. @param {ReturnType<typeof rig>} r */
async function coversDecoding(r) {
  await r.planned();
  await r.pump();
  await r.pump();
}

test('dispose before the plan ran: no pump is needed and no surface stays reachable from the kept store', async () => {
  const r = rig();
  await r.planned();
  assert.equal(r.store.needsPump(), true, 'control: the plan waits for the pump');
  assert.ok(await live(W, H) >= 1, 'control: the drawable surface is reachable before dispose');
  r.store.dispose();
  assert.equal(r.store.needsPump(), false);
  assert.equal(await live(), 0);
  r.store.dispose();
  assert.equal(r.store.needsPump(), false, 'a second dispose is a no-op');
  assert.deepEqual(r.errors, []);
});

test('dispose between the bands of two cover tiles: no pump is needed and both tiles are let go', async () => {
  const r = rig();
  await coversDecoding(r);
  assert.equal(r.store.stats().scrollSurfaceBytes, 2 * 600 * 500 * 4, 'control: both cover tiles decoded, their first band read');
  assert.equal(await live(600, 500), 2, 'control: the two tiles are reachable before dispose');
  r.store.dispose();
  assert.equal(r.store.needsPump(), false);
  assert.equal(await live(), 0);
  assert.deepEqual(r.errors, []);
});

test('dispose during a decode: the tile already decoded is let go before the other decode settles, which then publishes nothing', async () => {
  const r = rig({ defer: true });
  await coversDecoding(r);
  assert.deepEqual(r.pending.map((p) => p.url), ['cover0', 'cover1'], 'control: both cover decodes are in flight');
  await r.settle('cover0');
  assert.equal(await live(600, 500), 1, 'control: the first cover tile is reachable while the second decodes');
  r.store.dispose();
  assert.equal(r.store.needsPump(), false);
  assert.equal(await live(), 0, 'nothing is held while the second decode is still in flight');
  const surfaces = made.length, events = r.events.length, stats = JSON.stringify(r.store.stats()), released = r.images.released;
  await r.settle('cover1');
  assert.equal(made.length, surfaces, 'the late decode makes no surface');
  assert.equal(r.images.released, released + 1, 'its image is released');
  assert.equal(r.events.length, events, 'nothing is announced');
  assert.equal(JSON.stringify(r.store.stats()), stats);
  assert.equal(r.store.hasLanded(), false);
  assert.equal(r.store.needsPump(), false);
  assert.deepEqual(r.errors, []);
});

test('dispose while the first tile decodes: the late tile lands nowhere and is released', async () => {
  const r = rig({ defer: true });
  r.bus.emit(BUS.DRAWABLES_CHANGED, { record: r.record, added: [r.el], removed: [] });
  r.store.pump(1000, budget);
  await flush();
  assert.equal(r.pending.length, 1, 'control: the first tile decodes');
  r.store.dispose();
  const events = r.events.length, released = r.images.released;
  await r.settle('plain');
  assert.equal(r.store.hasLanded(), false);
  assert.equal(r.images.released, released + 1);
  assert.equal(r.events.length, events);
  assert.equal(r.store.needsPump(), false);
  assert.equal(await live(), 0);
});

test('dispose after the side work completed: every page and tile is let go', async () => {
  const r = rig();
  await coversDecoding(r);
  for (let k = 0; k < 40 && r.store.needsPump(); k++) await r.pump();
  assert.equal(r.store.needsPump(), false, 'control: the side work completed');
  const s = r.store.stats().scroll;
  assert.ok(s.pages >= 2, `control: pages were built (${s.pages})`);
  assert.ok(await live(600, 500) >= 2, 'control: the pages are reachable before dispose');
  r.store.dispose();
  assert.equal(r.store.needsPump(), false);
  assert.equal(await live(), 0);
  assert.deepEqual(r.errors, []);
});

test('a drawable removed between the bands of its cover tiles: its side builds go with it, without a pump', async () => {
  const r = rig();
  await coversDecoding(r);
  assert.equal(await live(600, 500), 2, 'control: the two tiles are reachable before the removal');
  r.bus.emit(BUS.DRAWABLES_CHANGED, { record: r.record, added: [], removed: [r.el] });
  assert.equal(r.store.has(r.el), false);
  assert.equal(r.store.needsPump(), false, 'nothing is left to pump');
  assert.equal(await live(), 0);
  assert.deepEqual(r.errors, []);
});

test('reinstall: a decode of the disposed store that settles after the new store committed changes nothing in either', async () => {
  const a = rig({ defer: true });
  await coversDecoding(a);
  a.store.dispose();
  const b = rig({ el: a.el });
  await coversDecoding(b);
  for (let k = 0; k < 40 && b.store.needsPump(); k++) await b.pump();
  const stats = JSON.stringify(b.store.stats()), events = b.events.length, oldEvents = a.events.length, surfaces = made.length;
  assert.ok(b.store.stats().scroll.pages >= 2, 'control: the new store planned and built its pages');
  await a.settle('cover0');
  await a.settle('cover1');
  assert.equal(made.length, surfaces, 'the old decodes make no surface');
  assert.equal(a.images.released, a.images.made, 'their images are released');
  assert.equal(JSON.stringify(b.store.stats()), stats);
  assert.equal(b.events.length, events);
  assert.equal(b.store.hasLanded(), false);
  assert.equal(b.store.needsPump(), false);
  assert.equal(a.events.length, oldEvents);
  assert.equal(a.store.needsPump(), false);
  assert.deepEqual([...a.errors, ...b.errors], []);
  b.store.dispose();
});
