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

test('the macOS overlay thumb of a listbox, in device px, as measured on the native oracle (Chrome Canary 158) at DPR 1, 1.25 and 2', async () => {
  const { macOverlayThumbRect } = await import('../../../src/snapshot/capture/scroll-emulation.js');
  // 4 rows of 6 (scrollport 68, content 102 css px): DPR 1 at the top, the thumb 7 px wide 2 px from the right, rows 2..43 of the scrollport
  assert.deepEqual(macOverlayThumbRect(1, 68, 102, 0), { right: 2, width: 7, top: 2, len: 41 });
  // scrolled 17 px (half way): rows 13..54 (measured 324..365 under a scrollport top of 311)
  assert.deepEqual(macOverlayThumbRect(1, 68, 102, 17), { right: 2, width: 7, top: 13, len: 41 });
  // 40 rows: the minimum slot of 26 px, at DPR 2 52 device px; DPR 1.25: 8 px wide, 3 px from the right, a slot of trunc(32.5)
  assert.deepEqual(macOverlayThumbRect(1, 68, 680, 0), { right: 2, width: 7, top: 2, len: 22 });
  assert.deepEqual(macOverlayThumbRect(2, 68, 680, 0), { right: 4, width: 14, top: 4, len: 44 });
  assert.deepEqual(macOverlayThumbRect(1.25, 68, 680, 0), { right: 3, width: 8, top: 3, len: 26 });
  // control: a scroll offset under one device pixel of thumb travel still moves it by one, and nothing to scroll gives no thumb
  assert.equal(macOverlayThumbRect(1, 68, 680, 0.5).top, 3);
  assert.equal(macOverlayThumbRect(1, 68, 68, 0), null);
});
