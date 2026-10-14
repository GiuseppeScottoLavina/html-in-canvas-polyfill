// <use> targets outside the drawable are drawn (Chrome draws them; WPT privacy/svg/svg-use-*), paint servers outside it are not.
import { test, assert } from '/test/unit/lib/t.js';
import { mount, rasterize } from './_support.mjs';

test('a <use> whose target (a chain of <use>) is outside the drawable is drawn, with the author rule that styles the target; an outside pattern is not', async (t) => {
  const outside = document.createElement('div');
  outside.innerHTML = '<style>#u-target{fill:rgb(0,128,0)}</style><svg width="0" height="0"><defs><rect id="u-target" width="40" height="20"/><g id="u-chain"><use href="#u-target"/></g>'
    + '<pattern id="u-pat" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="10" height="10" fill="red"/></pattern></defs></svg>';
  document.body.appendChild(outside);
  t.cleanup(() => outside.remove());
  const m = mount('<div class="d" drawable style="width:40px;height:40px"><svg width="40" height="40" style="display:block"><use href="#u-chain"/><rect y="20" width="40" height="20" fill="url(#u-pat)"/></svg></div>', { css: '#u-target{fill:rgb(0,128,0)}' });
  const r = m.capture(m.request(m.layerEl.firstElementChild));
  const got = await rasterize(r);
  const px = (x, y) => Array.from(got.getImageData(x, y, 1, 1).data);
  assert.deepEqual(px(10, 10), [0, 128, 0, 255], 'the use chain draws the outside rect with its author fill');
  assert.equal(px(10, 30)[3], 0, 'the outside pattern is ignored: transparent, never red');
});
