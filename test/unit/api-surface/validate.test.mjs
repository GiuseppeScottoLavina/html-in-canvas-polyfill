import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  frameCapFromIdl, geometryOptionsValues, matrixInitValues, parseFrameCap, rectInitValues,
} from '../../../src/api/validate.js';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

test('matrixInitValues: undefined, null and {} are the 2D identity', () => {
  for (const init of [undefined, null, {}]) assert.deepEqual(matrixInitValues(init), { values: IDENTITY, is2D: true });
});

test('matrixInitValues: 2D aliases a..f land on the right members', () => {
  const m = matrixInitValues({ a: 2, b: 3, c: 4, d: 5, e: 6, f: 7 });
  assert.deepEqual(m.values, [2, 3, 0, 0, 4, 5, 0, 0, 0, 0, 1, 0, 6, 7, 0, 1]);
  assert.equal(m.is2D, true);
});

test('matrixInitValues: m-members; any non-identity 3D member makes it 3D, an identity-valued one does not', () => {
  assert.equal(matrixInitValues({ m11: 2 }).is2D, true);
  assert.equal(matrixInitValues({ m33: 1 }).is2D, true);
  const m = matrixInitValues({ m34: 0.001, m43: 5 });
  assert.equal(m.is2D, false);
  assert.equal(m.values[11], 0.001);
  assert.equal(m.values[14], 5);
});

test('matrixInitValues: explicit is2D', () => {
  assert.equal(matrixInitValues({ is2D: false }).is2D, false);
  assert.equal(matrixInitValues({ is2D: true, m11: 3 }).is2D, true);
});

test('matrixInitValues: conflicting aliases and a 2D matrix with 3D members are TypeErrors (WPT canvas-transform-get-set)', () => {
  assert.throws(() => matrixInitValues({ a: 1, m11: 2 }), TypeError);
  assert.throws(() => matrixInitValues({ f: 1, m42: 2 }), TypeError);
  assert.throws(() => matrixInitValues({ is2D: true, m13: 1 }), TypeError);
  assert.throws(() => matrixInitValues({ is2D: true, m44: 2 }), TypeError);
  assert.throws(() => matrixInitValues(5), TypeError);
  assert.throws(() => matrixInitValues('x'), TypeError);
});

test('matrixInitValues: equal aliases and NaN pairs do not conflict', () => {
  assert.equal(matrixInitValues({ a: 2, m11: 2 }).values[0], 2);
  assert.ok(Number.isNaN(matrixInitValues({ a: NaN, m11: NaN }).values[0]));
});

test('rectInitValues: defaults to zeros, accepts non-finite members (unrestricted double), rejects non-objects', () => {
  assert.deepEqual(rectInitValues(undefined), { x: 0, y: 0, width: 0, height: 0 });
  assert.deepEqual(rectInitValues({ x: 1, y: 2, width: 3, height: 4 }), { x: 1, y: 2, width: 3, height: 4 });
  assert.deepEqual(rectInitValues({ width: '5' }), { x: 0, y: 0, width: 5, height: 0 });
  assert.ok(Number.isNaN(rectInitValues({ x: NaN }).x));
  assert.equal(rectInitValues({ height: Infinity }).height, Infinity);
  assert.throws(() => rectInitValues(3), TypeError);
});

test('geometryOptionsValues: a clip with negative dimensions is normalised to the same rectangle (WPT elementsFromPoint-update-element-geometry)', () => {
  assert.deepEqual(geometryOptionsValues({ clip: { x: 50, y: 40, width: -25, height: -10 } }).clip, { x: 25, y: 30, width: 25, height: 10 });
  assert.deepEqual(geometryOptionsValues({ clip: { x: 5, y: 6, width: -2, height: 3 } }).clip, { x: 3, y: 6, width: 2, height: 3 });
  assert.deepEqual(geometryOptionsValues({ clip: { x: 1, y: 2, width: 3, height: 4 } }).clip, { x: 1, y: 2, width: 3, height: 4 });
});

test('geometryOptionsValues: clip and canvasClip are both accepted, clip wins', () => {
  assert.deepEqual(geometryOptionsValues({ clip: { x: 1, width: 2 } }).clip, { x: 1, y: 0, width: 2, height: 0 });
  assert.deepEqual(geometryOptionsValues({ canvasClip: { y: 5 } }).clip, { x: 0, y: 5, width: 0, height: 0 });
  assert.deepEqual(geometryOptionsValues({ clip: { x: 1 }, canvasClip: { x: 9 } }).clip.x, 1);
});

test('geometryOptionsValues: defaults, preserveHitTestOrder coercion, transform parsing, errors', () => {
  const none = geometryOptionsValues(undefined);
  assert.deepEqual(none, { preserveHitTestOrder: false, transform: undefined, clip: undefined });
  assert.equal(geometryOptionsValues(null).preserveHitTestOrder, false);
  assert.equal(geometryOptionsValues({ preserveHitTestOrder: 1 }).preserveHitTestOrder, true);
  assert.deepEqual(geometryOptionsValues({ canvasTransform: { e: 3 } }).transform.values.slice(12, 14), [3, 0]);
  assert.throws(() => geometryOptionsValues({ canvasTransform: { a: 1, m11: 2 } }), TypeError);
  assert.ok(Number.isNaN(geometryOptionsValues({ clip: { x: NaN } }).clip.x));
  assert.throws(() => geometryOptionsValues(7), TypeError);
});

test('parseFrameCap: HTML non-negative integer parsing, clamp to 240, otherwise the default', () => {
  assert.equal(parseFrameCap('30', 7), 30);
  assert.equal(parseFrameCap('  12abc', 7), 12);
  assert.equal(parseFrameCap('+5', 7), 5);
  assert.equal(parseFrameCap('0', 7), 0);
  assert.equal(parseFrameCap('240', 7), 240);
  assert.equal(parseFrameCap('9999', 7), 240);
  assert.equal(parseFrameCap('-3', 7), 7);
  assert.equal(parseFrameCap('abc', 7), 7);
  assert.equal(parseFrameCap('', 7), 7);
  assert.equal(parseFrameCap(null, 7), 7);
  assert.equal(parseFrameCap('1.9', 7), 1);
});

test('frameCapFromIdl: unsigned long conversion, then the clamp', () => {
  assert.equal(frameCapFromIdl(30), 30);
  assert.equal(frameCapFromIdl('45'), 45);
  assert.equal(frameCapFromIdl(1.9), 1);
  assert.equal(frameCapFromIdl(300), 240);
  assert.equal(frameCapFromIdl(NaN), 0);
  assert.equal(frameCapFromIdl(Infinity), 0);
  assert.equal(frameCapFromIdl(-1), 240, 'ToUint32(-1) is 2^32-1, clamped');
  assert.equal(frameCapFromIdl(4294967296), 0, 'wraps to 0');
});
