import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromLegacyGpuArgs, toLegacyGpuArgs } from '../../../src/api/native-bridge.js';

const texture = { label: 'tex' };
const source = { source: { id: 'el' }, sourceX: 1, sourceY: 2, sourceWidth: 30, sourceHeight: 40 };

test('drawElementImageToTexture -> copyElementImageToTexture dictionaries (API-CONTRACT 5.4 / 2.1)', () => {
  const [src, dst] = toLegacyGpuArgs(source, { texture, size: [64, 32], origin: { x: 5, y: 6 }, premultipliedAlpha: true });
  assert.deepEqual(src, { source: source.source, sx: 1, sy: 2, swidth: 30, sheight: 40 });
  assert.deepEqual(dst, { destination: { texture, origin: { x: 5, y: 6 }, premultipliedAlpha: true }, width: 64, height: 32 });
});

test('size accepts the array form and the dictionary form; a 1-element array gets height 1', () => {
  assert.deepEqual(toLegacyGpuArgs(source, { texture, size: { width: 7, height: 9, depthOrArrayLayers: 1 } })[1], { destination: { texture }, width: 7, height: 9 });
  assert.deepEqual(toLegacyGpuArgs(source, { texture, size: [7] })[1], { destination: { texture }, width: 7, height: 1 });
});

test('undefined members are dropped so a native build sees a minimal dictionary', () => {
  const [src] = toLegacyGpuArgs({ source: source.source }, { texture, size: [1, 1] });
  assert.deepEqual(src, { source: source.source });
});

test('the inverse mapping reproduces the current-name dictionaries', () => {
  const [legacySrc, legacyDst] = toLegacyGpuArgs(source, { texture, size: [64, 32], origin: { x: 5, y: 6 } });
  const [back, dest] = fromLegacyGpuArgs(legacySrc, legacyDst);
  assert.deepEqual(back, source);
  assert.deepEqual(dest, { texture, origin: { x: 5, y: 6 }, size: [64, 32] });
});

test('mutation check: swapping sx and sy in the mapping is caught', () => {
  const [src] = toLegacyGpuArgs({ ...source, sourceX: 10, sourceY: 20 }, { texture, size: [1, 1] });
  assert.equal(src.sx, 10);
  assert.equal(src.sy, 20);
});
