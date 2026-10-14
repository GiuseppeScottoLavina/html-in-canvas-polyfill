import { test, assert, fixture } from '/test/unit/lib/t.js';
import { resetGeometry } from '/src/api/geometry.js';
import { arrange } from './fakes.mjs';

const setup = (t) => arrange(t, fixture, { patches: [] });
const fields = (m) => [m.a, m.b, m.c, m.d, m.e, m.f];

test('get is identity until an update; update stores transform and clip verbatim, 2D and 3D', async (t) => {
  const { geometry, record, el } = await setup(t);
  assert.equal(geometry.get(record, el).isIdentity, true);
  geometry.update(record, el, { canvasTransform: { a: 2, d: 3, e: 4, f: 5 }, clip: { x: 1, y: 2, width: 3, height: 4 } });
  assert.deepEqual(fields(geometry.get(record, el)), [2, 0, 0, 3, 4, 5]);
  geometry.update(record, el, { canvasTransform: { m11: 1, m14: 0.5, m43: 7 } });
  const m = geometry.get(record, el);
  assert.equal(m.is2D, false);
  assert.deepEqual([m.m14, m.m43], [0.5, 7]);
  const clip = record.geometry.byElement.get(el).clip;
  assert.deepEqual([clip.x, clip.width], [1, 3], 'clip kept when only the transform is updated');
});

test('an unchanged update is a no-op: no layer write, order untouched', async (t) => {
  const { geometry, record, el } = await setup(t);
  const opts = { canvasTransform: { e: 5 }, clip: { x: 0, y: 0, width: 10, height: 10 } };
  geometry.update(record, el, opts);
  geometry.update(record, el, opts);
  geometry.update(record, el, { canvasTransform: { e: 5 } });
  assert.equal(record.layerCalls.applyGeometry.length, 1);
  assert.equal(record.layerCalls.setHitTestOrder.length, 1);
  geometry.update(record, el, { canvasTransform: { e: 6 } });
  assert.equal(record.layerCalls.applyGeometry.length, 2);
  assert.equal(record.layerCalls.setHitTestOrder.length, 1, 'rank did not change');
  assert.equal(record.layerCalls.applyGeometry.at(-1).el, el);
});

test('an element in the drawn list with no transform is passed to the layer as identity geometry (hit-testable at the origin)', async (t) => {
  const { geometry, record, el } = await setup(t);
  geometry.update(record, el, {});
  assert.deepEqual(record.geometry.order, [el]);
  const call = record.layerCalls.applyGeometry.at(-1);
  assert.deepEqual([call.geometry.transform, call.geometry.clip], [null, null]);
  assert.equal(geometry.get(record, el).isIdentity, true);
});

test('rank: update moves to the end, preserveHitTestOrder keeps a listed element where it is and appends a new one', async (t) => {
  const { geometry, record, el, canvas } = await setup(t);
  const b = canvas.appendChild(document.createElement('div'));
  const c = canvas.appendChild(document.createElement('div'));
  geometry.update(record, el, {});
  geometry.update(record, b, {});
  assert.deepEqual(record.geometry.order, [el, b]);
  geometry.update(record, el, { preserveHitTestOrder: true, canvasTransform: { e: 1 } });
  assert.deepEqual(record.geometry.order, [el, b]);
  geometry.update(record, el, {});
  assert.deepEqual(record.geometry.order, [b, el]);
  geometry.update(record, c, { preserveHitTestOrder: true });
  assert.deepEqual(record.geometry.order, [b, el, c]);
  assert.deepEqual(record.layerCalls.setHitTestOrder.at(-1), [b, el, c]);
});

test('clear and resetGeometry remove transform, clip and rank, and tell the layer', async (t) => {
  const { geometry, record, el } = await setup(t);
  geometry.clear(record, el);
  assert.equal(record.layerCalls.applyGeometry.length, 0, 'nothing to clear');
  assert.equal(record.layerCalls.setHitTestOrder.length, 0, 'nothing to clear');
  geometry.update(record, el, { canvasTransform: { e: 9 } });
  geometry.clear(record, el);
  assert.equal(geometry.get(record, el).isIdentity, true);
  assert.deepEqual(record.geometry.order, []);
  assert.equal(record.layerCalls.applyGeometry.at(-1).geometry, null);
  assert.deepEqual(record.layerCalls.setHitTestOrder.at(-1), []);
  assert.equal(record.layerCalls.applyGeometry.length, 2);
  geometry.update(record, el, { canvasTransform: { e: 9 } });
  assert.equal(resetGeometry(record, el), true);
  assert.equal(resetGeometry(record, el), false);
  assert.equal(record.geometry.byElement.has(el), false);
});

test('invalid options throw TypeError and leave the state untouched', async (t) => {
  const { geometry, record, el } = await setup(t);
  assert.throws(() => geometry.update(record, el, { canvasTransform: { a: 1, m11: 2 } }), TypeError);
  assert.equal(record.geometry.byElement.has(el), false);
  assert.deepEqual(record.geometry.order, []);
});

test('the layer receives the layoutOffset of the newest version and never a measured one', async (t) => {
  const { geometry, record, el, store } = await setup(t);
  store.commit(el, { layoutOffset: { x: 11, y: 12 } });
  geometry.update(record, el, { canvasTransform: { e: 1 } });
  assert.deepEqual(record.layerCalls.applyGeometry.at(-1).layoutOffset, { x: 11, y: 12 });
  store.drop(el);
  geometry.update(record, el, { canvasTransform: { e: 2 } });
  assert.equal(record.layerCalls.applyGeometry.at(-1).layoutOffset, null);
});
