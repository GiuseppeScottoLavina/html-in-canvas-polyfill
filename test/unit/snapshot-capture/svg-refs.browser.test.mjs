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

test('a <use> inside an external document refers to that document: `#blue` there is its own element, not the page element of the same id; control: the page has a red #blue', async (t) => {
  const outside = document.createElement('div');
  outside.innerHTML = '<svg width="0" height="0"><defs><rect id="blue" width="40" height="20" fill="red"/></defs></svg>';
  document.body.appendChild(outside);
  t.cleanup(() => outside.remove());
  const m = mount('<svg drawable width="40" height="40" style="display:block"><use href="/test/unit/snapshot-capture/assets/sprite-chain.svg#chain"/><use y="20" href="#blue"/></svg>');
  const el = m.layerEl.firstElementChild;
  m.capture(m.request(el));
  await new Promise((ok) => setTimeout(ok, 400));
  const r = m.capture(m.request(el));
  assert.equal(r.complete, true);
  const got = await rasterize(r);
  const px = (x, y) => Array.from(got.getImageData(x, y, 1, 1).data);
  assert.deepEqual(px(20, 30), [255, 0, 0, 255], 'control: the page\'s own #blue is red');
  assert.deepEqual(px(20, 10), [0, 0, 255, 255], 'the external chain draws its own #blue');
});

// Expected pixels measured on the native oracle (Chrome Canary 158, --enable-blink-features=CanvasDrawElement) drawing the same markup with drawElementImage.
const REFS_SPRITE = '/test/unit/snapshot-capture/assets/sprite-refs.svg';
const REFS_CELLS = ['grad', 'grad-fallback', 'clip', 'mask', 'filter', 'cls', 'by-id', 'page-cls', 'mq', 'sym', 'chain'];
const REFS_PAGE = '<style>.cls-1{fill:rgb(250,0,250)} .page-cls{fill:rgb(255,0,0)}</style><svg width="0" height="0" style="position:absolute"><defs>'
  + '<clipPath id="out-clip"><rect width="10" height="20"/></clipPath><g id="out-grad"><linearGradient id="out-g"><stop stop-color="rgb(0,200,200)"/></linearGradient>'
  + '<rect width="20" height="20" fill="url(#out-g)"/></g></defs></svg>';
const refsDrawable = (attr) => `<svg ${attr} width="240" height="40" style="display:block"><defs><linearGradient id="g"><stop stop-color="rgb(255,0,0)"/></linearGradient></defs>`
  + REFS_CELLS.map((id, i) => `<use x="${i * 20}" href="${REFS_SPRITE}#${id}"/>`).join('')
  + '<rect y="20" width="20" height="20" fill="url(#g)"/><rect x="20" y="20" width="20" height="20" class="inner"/>'
  + '<g transform="translate(40,20)"><rect width="20" height="20" clip-path="url(#out-clip)"/></g><use x="60" y="20" href="#out-grad"/></svg>';
const REFS_EXPECT = {
  'grad: an external paint server is ignored, never the page\'s #g': [[5, 10], [0, 0, 0, 0]],
  'grad-fallback: its fallback colour': [[25, 10], [10, 20, 30, 255]],
  'clip: the external clip path applies (left half)': [[45, 10], [0, 0, 0, 255]],
  'clip: the external clip path applies (right half clipped)': [[55, 10], [0, 0, 0, 0]],
  'mask: an external mask masks its element away': [[65, 10], [0, 0, 0, 0]],
  'filter: the external filter applies': [[85, 10], [200, 100, 0, 255]],
  'cls: the document\'s own class rule, not the page\'s .cls-1': [[105, 10], [0, 0, 200, 255]],
  'by-id: the document\'s id rule': [[125, 10], [0, 100, 0, 255]],
  'page-cls: the page\'s class rule does not reach an external element': [[145, 10], [0, 0, 0, 255]],
  'mq: the document\'s @media rules do not apply': [[165, 10], [0, 0, 0, 255]],
  'sym: a <style> inside the target styles the target': [[185, 10], [0, 150, 150, 255]],
  'chain: a <use> inside the document reaches its clip path': [[205, 10], [0, 0, 0, 255]],
  'chain: clipped on the right': [[215, 10], [0, 0, 0, 0]],
  'control: the page\'s own #g inside the drawable draws': [[5, 30], [255, 0, 0, 255]],
  'the external <style> does not reach the page\'s .inner': [[25, 30], [0, 0, 0, 255]],
  'a clip path outside the drawable applies (left half)': [[45, 30], [0, 0, 0, 255]],
  'a clip path outside the drawable applies (right half clipped)': [[55, 30], [0, 0, 0, 0]],
  'the paint server inside an outside <use> target is ignored': [[65, 30], [0, 0, 0, 0]],
};

test('the references inside an external SVG document resolve against that document, under the read-back rules of the native oracle: paint servers ignored (fallback kept), masks mask away, clip paths, filters and the document\'s own <style> rules apply; no id, class or rule crosses between the page and the document', async (t) => {
  const outside = document.createElement('div');
  outside.innerHTML = REFS_PAGE;
  document.body.appendChild(outside);
  t.cleanup(() => outside.remove());
  const m = mount(refsDrawable('drawable'), { css: '.cls-1{fill:rgb(250,0,250)} .page-cls{fill:rgb(255,0,0)}' });
  const el = m.layerEl.firstElementChild;
  m.capture(m.request(el));
  await new Promise((ok) => setTimeout(ok, 400));
  const r = m.capture(m.request(el));
  assert.equal(r.complete, true);
  const got = await rasterize(r);
  const bad = [];
  for (const [name, [[x, y], want]] of Object.entries(REFS_EXPECT)) {
    const px = Array.from(got.getImageData(x, y, 1, 1).data);
    if (px.join() !== want.join()) bad.push(`${name}: got ${px} want ${want}`);
  }
  assert.deepEqual(bad, []);
});

test('an HTML box clipped by `clip-path: url(#id)` whose <clipPath> is outside the drawable is clipped, as on the native oracle (Chrome Canary 158)', async (t) => {
  const outside = document.createElement('div');
  outside.innerHTML = '<svg width="0" height="0" style="position:absolute"><defs><clipPath id="u-oc" clipPathUnits="objectBoundingBox"><rect width="0.5" height="1"/></clipPath></defs></svg>';
  document.body.appendChild(outside);
  t.cleanup(() => outside.remove());
  const m = mount('<div class="d" drawable style="width:40px;height:20px;background:rgb(0,0,255);clip-path:url(#u-oc)"></div>');
  const got = await rasterize(m.capture(m.request(m.layerEl.firstElementChild)));
  assert.deepEqual(Array.from(got.getImageData(10, 10, 1, 1).data), [0, 0, 255, 255], 'control: the left half is drawn');
  assert.equal(got.getImageData(30, 10, 1, 1).data[3], 0, 'the right half is clipped away');
});
