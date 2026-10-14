import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rasterSourceFor } from '../../../src/snapshot/store/raster-source.js';
import { newVersion, parseTransformOrigin, rebaseVersion, reviseVersion } from '../../../src/snapshot/store/versions.js';

const ink = { left: 24, top: 24, right: 24, bottom: 24 };
const surface = { width: 296, height: 296 };
const make = (extra = {}) => newVersion({
  element: new WeakRef({}), canvasId: 1, width: 100, height: 100, canvasWidth: 400, canvasHeight: 300, translation: { e: 50, f: 50 },
  scale: 2, ink, layoutOffset: { x: 3, y: 4 }, surface, ...extra,
}, 10);

test('rasterSourceFor: css rect -> surface px with the ink offset and scale', () => {
  const r = rasterSourceFor(make(), { sx: 0, sy: 0, sw: 100, sh: 100 });
  assert.deepEqual({ sx: r.sx, sy: r.sy, sw: r.sw, sh: r.sh }, { sx: 48, sy: 48, sw: 200, sh: 200 });
  assert.equal(r.source, surface);
});

test('rasterSourceFor: negative origin reaches into the ink margin; overshoot is clipped to the surface', () => {
  const v = make();
  const r = rasterSourceFor(v, { sx: -24, sy: -24, sw: 148, sh: 148 });
  assert.deepEqual({ sx: r.sx, sy: r.sy, sw: r.sw, sh: r.sh }, { sx: 0, sy: 0, sw: 296, sh: 296 });
  const over = rasterSourceFor(v, { sx: -100, sy: 0, sw: 400, sh: 10 });
  assert.equal(over.sx, 0);
  assert.equal(over.sw, 296);
});

test('rasterSourceFor: no overlap, empty or non finite rect -> null', () => {
  const v = make();
  assert.equal(rasterSourceFor(v, { sx: 500, sy: 0, sw: 10, sh: 10 }), null);
  assert.equal(rasterSourceFor(v, { sx: -200, sy: 0, sw: 10, sh: 10 }), null);
  assert.equal(rasterSourceFor(v, { sx: 0, sy: 0, sw: 0, sh: 10 }), null);
  assert.equal(rasterSourceFor(v, { sx: 0, sy: 0, sw: -5, sh: 10 }), null);
  assert.equal(rasterSourceFor(v, { sx: NaN, sy: 0, sw: 10, sh: 10 }), null);
  assert.equal(rasterSourceFor(v, { sx: 0, sy: 0, sw: Infinity, sh: 10 }), null);
});

test('rasterSourceFor: float noise at fractional scales does not turn a 1:1 copy into a resample', () => {
  const v = make({ scale: 2.2, surface: { width: 2000, height: 2000 } });
  const sx = 28.72727272727272;
  assert.notEqual((sx + 24) * 2.2, 116, 'the raw product carries float noise (115.99999999999999)');
  const r = rasterSourceFor(v, { sx, sy: 0, sw: 20, sh: 20 });
  assert.equal(r.sx, 116);
});

test('newVersion: fields are read-only, the object is not extensible, ids grow', () => {
  'use strict';
  const v = make();
  const w = make();
  assert.ok(w.id > v.id);
  assert.throws(() => { v.width = 5; }, TypeError);
  assert.throws(() => { v.surface = null; }, TypeError);
  assert.throws(() => { v.extra = 1; }, TypeError);
  assert.throws(() => { v.ink.left = 0; }, TypeError, 'ink is frozen');
  assert.throws(() => { v.layoutOffset.x = 0; }, TypeError, 'layoutOffset is frozen');
  v.refs++; v.pinned = true;
  assert.equal(v.refs, 1);
  assert.equal(v.pinned, true);
  assert.equal(v.dirty, null);
});

test('newVersion: layoutOffset null is kept, dirty is copied and frozen', () => {
  const v = make({ layoutOffset: null, dirty: { x: 1, y: 2, width: 3, height: 4 } });
  assert.equal(v.layoutOffset, null);
  assert.deepEqual(v.dirty, { x: 1, y: 2, width: 3, height: 4 });
  assert.throws(() => { v.dirty.x = 0; }, TypeError);
});

test('rebaseVersion: metadata-only, same surface and pixels, new canvas size, new id, counters reset', () => {
  const v = make();
  v.refs = 2;
  const r = rebaseVersion(v, { width: 800, height: 600 }, 20);
  assert.equal(r.surface, v.surface);
  assert.equal(r.canvasWidth, 800);
  assert.equal(r.canvasHeight, 600);
  assert.notEqual(r.id, v.id);
  assert.equal(r.refs, 0);
  assert.equal(r.width, v.width);
  assert.deepEqual(r.layoutOffset, v.layoutOffset);
  assert.equal(v.canvasWidth, 400, 'the old version is untouched');
});

test('reviseVersion: swaps the surface (fork) and keeps the rest', () => {
  const v = make();
  const fork = { width: 296, height: 296 };
  const r = reviseVersion(v, { surface: fork, dirty: { x: 0, y: 0, width: 1, height: 1 } }, 30);
  assert.equal(r.surface, fork);
  assert.equal(r.scale, v.scale);
  assert.equal(v.surface, surface);
  assert.deepEqual(r.layoutOffset, v.layoutOffset);
});

test('parseTransformOrigin reads the first two lengths and falls back to 0', () => {
  assert.deepEqual(parseTransformOrigin('120px 40.5px'), { x: 120, y: 40.5 });
  assert.deepEqual(parseTransformOrigin('50px 25px 0px'), { x: 50, y: 25 });
  assert.deepEqual(parseTransformOrigin('left top'), { x: 0, y: 0 });
  assert.deepEqual(parseTransformOrigin(''), { x: 0, y: 0 });
  assert.deepEqual(parseTransformOrigin(undefined), { x: 0, y: 0 });
});
