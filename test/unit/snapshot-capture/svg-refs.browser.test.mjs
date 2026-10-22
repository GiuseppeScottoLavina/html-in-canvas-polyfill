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

test('a <use> of an external SVG document draws a same-origin one (its root, or the fragment element) once loaded and never a cross-origin one (read-back-allowed rendering, WPT privacy/svg/svg-use-ignored)', async () => {
  const cross = `http://localhost:${location.port}/test/unit/snapshot-capture/assets/red.svg`;
  const m = mount('<svg drawable width="40" height="60" style="display:block"><use href="/test/unit/snapshot-capture/assets/red.svg"/>'
    + `<use y="20" href="/test/unit/snapshot-capture/assets/sprite.svg#green"/><use y="40" href="${cross}"/><use y="40" href="/test/unit/snapshot-capture/assets/sprite.svg#missing"/></svg>`);
  const el = m.layerEl.firstElementChild;
  const first = m.capture(m.request(el));
  assert.equal(first.complete, false, 'the same-origin documents are still loading');
  await new Promise((ok) => setTimeout(ok, 400));
  const r = m.capture(m.request(el));
  assert.equal(r.complete, true);
  const svg = decodeURIComponent(r.url.slice(r.url.indexOf(',') + 1));
  assert.ok(!svg.includes('localhost:') && !svg.includes('/assets/'), 'no external URL reaches the snapshot');
  const got = await rasterize(r);
  const px = (x, y) => Array.from(got.getImageData(x, y, 1, 1).data);
  assert.deepEqual(px(20, 10), [224, 0, 0, 255], 'positive control: the whole same-origin document is drawn');
  assert.deepEqual(px(20, 30), [0, 128, 0, 255], 'positive control: the fragment element of a same-origin document is drawn');
  assert.equal(px(20, 50)[3], 0, 'the cross-origin document and a missing fragment draw nothing');
});

test('a <use> of a same-origin URL that redirects to another origin draws nothing, even when that origin allows a credentialed CORS read (the platform fetches an external <use> document same-origin only); controls: the target is readable through CORS, and a same-origin redirect is drawn', async () => {
  const asset = '/test/unit/snapshot-capture/assets/red.svg';
  const cross = `http://localhost:${location.port}${asset}?cors=1`;
  const control = await fetch(cross, { credentials: 'include' });
  assert.equal(control.ok, true, 'control: the cross-origin target answers a CORS read');
  const viaCross = `${asset}?redirect=${encodeURIComponent(cross)}`;
  const viaSame = `${asset}?redirect=${encodeURIComponent(asset)}`;
  const m = mount(`<svg drawable width="40" height="40" style="display:block"><use href="${viaCross}"/><use y="20" href="${viaSame}"/></svg>`);
  const el = m.layerEl.firstElementChild;
  m.capture(m.request(el));
  await new Promise((ok) => setTimeout(ok, 400));
  const r = m.capture(m.request(el));
  const got = await rasterize(r);
  const px = (x, y) => Array.from(got.getImageData(x, y, 1, 1).data);
  assert.deepEqual(px(20, 30), [224, 0, 0, 255], 'control: a same-origin redirect is followed and drawn');
  assert.equal(px(20, 10)[3], 0, 'the document redirected to another origin is not drawn');
});
