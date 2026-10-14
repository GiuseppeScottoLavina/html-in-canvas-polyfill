import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IDENTITY16, invertTranslation16, matrixInit, multiply16, scale16, translation16, values16Equal,
} from '../../../src/util/matrix.js';

test('translation16 and scale16 are column-major with the translation in m41..m43', () => {
  assert.deepEqual(translation16(3, 4), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 0, 1]);
  assert.deepEqual(translation16(1, 2, 3).slice(12, 15), [1, 2, 3]);
  assert.deepEqual(scale16(2, 3), [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
});

test('multiply16 applies b first, then a (DOMMatrix.multiply order)', () => {
  // translate(10,0) after scale(2): the point (1,0) -> (2,0) -> (12,0)
  const m = multiply16(translation16(10, 0), scale16(2, 2));
  assert.deepEqual(m.slice(12, 14), [10, 0]);
  assert.equal(m[0], 2);
  // scale(2) after translate(10,0): (1,0) -> (11,0) -> (22,0)
  const n = multiply16(scale16(2, 2), translation16(10, 0));
  assert.deepEqual([n[0], n[12]], [2, 20]);
});

test('multiply16 with the identity is neutral and invertTranslation16 undoes a translation', () => {
  const t = translation16(7, -3, 2);
  assert.deepEqual(multiply16(IDENTITY16, t), t);
  assert.deepEqual(multiply16(t, IDENTITY16), t);
  assert.deepEqual(multiply16(invertTranslation16(t), t), IDENTITY16.slice());
});

test('multiply16 of rotations composes (90deg twice is 180deg)', () => {
  const r90 = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const r180 = multiply16(r90, r90);
  assert.deepEqual([r180[0], r180[1], r180[4], r180[5]].map(v => v + 0), [-1, 0, 0, -1]);
});

test('values16Equal: exact, NaN equals NaN, any difference is not equal', () => {
  assert.equal(values16Equal(IDENTITY16, translation16(0, 0)), true);
  assert.equal(values16Equal(IDENTITY16, translation16(0, 1)), false);
  const a = IDENTITY16.slice(); a[3] = NaN;
  const b = IDENTITY16.slice(); b[3] = NaN;
  assert.equal(values16Equal(a, b), true);
});

test('matrixInit: 2D carries a..f, 3D carries all sixteen members', () => {
  assert.deepEqual(matrixInit(translation16(5, 6), true), { a: 1, b: 0, c: 0, d: 1, e: 5, f: 6, is2D: true });
  const v = Array.from({ length: 16 }, (_, i) => i + 1);
  const init = matrixInit(v, false);
  assert.equal(init.is2D, false);
  assert.deepEqual([init.m11, init.m21, init.m31, init.m41, init.m14, init.m44], [1, 5, 9, 13, 4, 16]);
});
