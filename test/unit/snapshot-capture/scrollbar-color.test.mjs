import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScrollbarColor } from '../../../src/snapshot/capture/scroll-emulation.js';

test('m3: scrollbar-color computed values split into thumb and track colours; auto is null', () => {
  assert.equal(parseScrollbarColor('auto'), null);
  assert.equal(parseScrollbarColor(''), null);
  assert.deepEqual(parseScrollbarColor('rgb(245, 158, 11) rgb(55, 65, 81)'), { thumb: 'rgb(245, 158, 11)', track: 'rgb(55, 65, 81)' });
  assert.deepEqual(parseScrollbarColor('rgba(1, 2, 3, 0.5) rgb(4, 5, 6)'), { thumb: 'rgba(1, 2, 3, 0.5)', track: 'rgb(4, 5, 6)' });
  assert.deepEqual(parseScrollbarColor('color(srgb 1 0 0) red'), { thumb: 'color(srgb 1 0 0)', track: 'red' });
});
