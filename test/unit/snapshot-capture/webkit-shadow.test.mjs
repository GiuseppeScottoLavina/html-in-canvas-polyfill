import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShadows, webkitShadowStyle } from '../../../src/snapshot/capture/webkit-shadow.js';

const RING = 'rgba(85, 232, 255, 0.09) 0px 0px 0px 3px, rgba(255, 255, 255, 0.035) 0px 1px 0px 0px inset';

test('parseShadows: computed lists with rgba commas and inset', () => {
  assert.deepEqual(parseShadows(RING), [
    { color: 'rgba(85, 232, 255, 0.09)', x: 0, y: 0, blur: 0, spread: 3, inset: false },
    { color: 'rgba(255, 255, 255, 0.035)', x: 0, y: 1, blur: 0, spread: 0, inset: true },
  ]);
  assert.deepEqual(parseShadows('none'), []);
  assert.equal(parseShadows('rgb(0, 0, 0) 0px 24px 60px 0px')[0].blur, 60);
});

test('webkitShadowStyle: a spread-only focus ring becomes an outline, inset shadows stay (regression: Safari focus ring painted as a box beside the field)', () => {
  const d = webkitShadowStyle({ boxShadow: RING, outlineStyle: 'none', filter: 'none', position: 'static' });
  assert.equal(d, 'box-shadow:rgba(255, 255, 255, 0.035) 0px 1px 0px 0px inset!important;outline:3px solid rgba(85, 232, 255, 0.09)!important;outline-offset:0px!important;');
});

test('webkitShadowStyle: blurred outer shadows become drop-shadow only on a positioned element without a filter, else they are removed', () => {
  const blur = 'rgba(0, 0, 0, 0.22) 0px 24px 60px 0px';
  assert.equal(webkitShadowStyle({ boxShadow: blur, outlineStyle: 'none', filter: 'none', position: 'relative' }), 'box-shadow:none!important;filter:drop-shadow(rgba(0, 0, 0, 0.22) 0px 24px 30px)!important;');
  assert.equal(webkitShadowStyle({ boxShadow: blur, outlineStyle: 'none', filter: 'none', position: 'static' }), 'box-shadow:none!important;');
  assert.equal(webkitShadowStyle({ boxShadow: blur, outlineStyle: 'none', filter: 'blur(2px)', position: 'relative' }), 'box-shadow:none!important;');
  assert.equal(webkitShadowStyle({ boxShadow: 'rgb(0, 0, 0) 0px 1px 0px 0px inset', outlineStyle: 'none', filter: 'none', position: 'static' }), '', 'inset only: untouched');
  assert.equal(webkitShadowStyle({ boxShadow: 'rgb(255, 0, 0) 0px 0px 0px 2px', outlineStyle: 'solid', filter: 'none', position: 'static' }), 'box-shadow:none!important;', 'an author outline is kept, the ring is dropped');
});
