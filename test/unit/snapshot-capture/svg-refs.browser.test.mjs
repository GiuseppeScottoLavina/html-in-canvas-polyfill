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

// Expected pixels measured on the native oracle (Chrome Canary 158, --enable-blink-features=CanvasDrawElement) drawing the same markup with drawElementImage; the filter cell
// re-measured on Canary 159.0.8128.2 ("Disallow canvas-external SVG filters": a filter of an external document is not applied, the rect is drawn unfiltered).
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
  'filter: the external filter is ignored (drawn unfiltered)': [[85, 10], [0, 0, 0, 255]],
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

test('the references inside an external SVG document resolve against that document, under the read-back rules of the native oracle: paint servers and filters ignored (fallback kept, drawn unfiltered), masks mask away, clip paths and the document\'s own <style> rules apply; no id, class or rule crosses between the page and the document', async (t) => {
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

test('a <use> of a page target outside the drawable draws it under the read-back rules of the native oracle (Chrome Canary 158, same pixels on 159): its own mask masks it away, its clip path applies, its filter does not, its marker and pattern are ignored (fallback kept)', async (t) => {
  const outside = document.createElement('div');
  outside.innerHTML = '<svg width="0" height="0" style="position:absolute"><defs>'
    + '<g id="in-m"><mask id="in-mi"><rect width="10" height="20" fill="white"/></mask><rect width="20" height="20" mask="url(#in-mi)"/></g>'
    + '<g id="in-c"><clipPath id="in-ci"><rect width="10" height="20"/></clipPath><rect width="20" height="20" clip-path="url(#in-ci)"/></g>'
    + '<g id="in-f"><filter id="in-fi" x="0" y="0" width="1" height="1"><feFlood flood-color="rgb(200,100,0)"/></filter><rect width="20" height="20" filter="url(#in-fi)"/></g>'
    + '<g id="in-k"><marker id="in-ki" markerWidth="20" markerHeight="20" markerUnits="userSpaceOnUse"><rect width="20" height="20" fill="rgb(150,0,150)"/></marker><path d="M0,0 L1,0" marker-start="url(#in-ki)"/></g>'
    + '<g id="in-p"><pattern id="in-pi" width="20" height="20" patternUnits="userSpaceOnUse"><rect width="20" height="20" fill="rgb(0,160,0)"/></pattern><rect width="20" height="20" fill="url(#in-pi) rgb(1,2,3)"/></g>'
    + '</defs></svg>';
  document.body.appendChild(outside);
  t.cleanup(() => outside.remove());
  const ids = ['in-m', 'in-c', 'in-f', 'in-k', 'in-p'];
  const m = mount(`<svg drawable width="100" height="20" style="display:block">${ids.map((id, i) => `<use x="${i * 20}" href="#${id}"/>`).join('')}</svg>`);
  const got = await rasterize(m.capture(m.request(m.layerEl.firstElementChild)));
  const px = (x) => Array.from(got.getImageData(x, 10, 1, 1).data).join();
  // measured on the native oracle with the same markup (canvas pixels at x = 5, 15, ... 95)
  const want = ['0,0,0,0', '0,0,0,0', '0,0,0,255', '0,0,0,0', '0,0,0,255', '0,0,0,255', '0,0,0,0', '0,0,0,0', '1,2,3,255', '1,2,3,255'];
  assert.deepEqual(Array.from({ length: 10 }, (_, i) => px(i * 10 + 5)), want);
});

// Measured on the native oracle (Chrome Canary 159.0.8128.2, --enable-blink-features=CanvasDrawElement) with the same markup: what decides is where the RESOURCE lies. Inside any
// canvas with content=drawable (also outside the drawable, also another canvas) it applies; outside every one a clip path applies, a mask masks away, a filter, a paint server and a
// marker are ignored (WPT privacy/filtered-outside-subtree-ignored, privacy/svg/svg-mask-filter, privacy/svg/svg-pattern-filter-transformed-text).
const SCOPE_DEFS = (p) => `<svg width="0" height="0" style="position:absolute"><defs>
  <clipPath id="${p}-clip" clipPathUnits="objectBoundingBox"><rect width="0.5" height="1"/></clipPath>
  <mask id="${p}-mask" maskContentUnits="objectBoundingBox"><rect width="0.5" height="1" fill="white"/></mask>
  <linearGradient id="${p}-grad"><stop stop-color="rgb(0,255,0)"/></linearGradient>
  <pattern id="${p}-pat" width="20" height="20" patternUnits="userSpaceOnUse"><g filter="url(#${p}-pflood)"><rect width="1" height="1"/></g></pattern>
  <filter id="${p}-pflood" filterUnits="userSpaceOnUse" x="0" y="0" width="20" height="20"><feFlood flood-color="rgb(0,100,200)"/></filter>
  <marker id="${p}-mark" markerWidth="20" markerHeight="20" markerUnits="userSpaceOnUse"><rect width="20" height="20" fill="rgb(150,0,150)"/></marker>
  <filter id="${p}-flood" x="0" y="0" width="1" height="1"><feFlood flood-color="rgb(200,100,0)"/></filter>
  <g id="${p}-use"><rect width="20" height="20" fill="url(#sc-in-grad) rgb(1,2,3)" filter="url(#${p}-flood)"/></g>
</defs></svg>`;
/** one row of cells 20x20 that refer to the resources of prefix `p` */
const scopeRow = (p, y) => `<rect y="${y}" width="20" height="20" clip-path="url(#${p}-clip)"/><rect x="20" y="${y}" width="20" height="20" mask="url(#${p}-mask)"/>`
  + `<rect x="40" y="${y}" width="20" height="20" fill="url(#${p}-grad) rgb(0,0,128)"/><rect x="60" y="${y}" width="20" height="20" fill="url(#${p}-pat) rgb(1,2,3)"/>`
  + `<path d="M80,${y} L81,${y}" marker-start="url(#${p}-mark)"/><rect x="100" y="${y}" width="20" height="20" filter="url(#${p}-flood)"/><use x="120" y="${y}" href="#${p}-use"/>`;
const SCOPE_WANT = {
  // clip (left, right), mask (left, right), gradient, pattern (its content filtered), marker, filter, use (a gradient INSIDE the canvas, the target's filter)
  'sc-in': ['0,0,0,255', '0,0,0,0', '0,0,0,255', '0,0,0,0', '0,255,0,255', '0,100,200,255', '150,0,150,255', '200,100,0,255', '200,100,0,255'],
  'sc-out': ['0,0,0,255', '0,0,0,0', '0,0,0,0', '0,0,0,0', '0,0,128,255', '1,2,3,255', '0,0,0,0', '0,0,0,255', '0,255,0,255'],
  'sc-other': ['0,0,0,255', '0,0,0,0', '0,0,0,255', '0,0,0,0', '0,255,0,255', '0,100,200,255', '150,0,150,255', '200,100,0,255', '200,100,0,255'],
};

test('a resource outside the drawable applies when it lies inside a drawable canvas (this one or another) and follows the read-back rules outside every one: clip applies, mask masks away, filter, paint server and marker are ignored (native oracle, Canary 159)', async (t) => {
  const outside = document.createElement('div');
  outside.innerHTML = SCOPE_DEFS('sc-out') + `<canvas content="drawable" width="1" height="1">${SCOPE_DEFS('sc-other')}</canvas>`;
  document.body.appendChild(outside);
  t.cleanup(() => outside.remove());
  const m = mount(`${SCOPE_DEFS('sc-in')}<svg drawable width="140" height="60" style="display:block">${scopeRow('sc-in', 0)}${scopeRow('sc-out', 20)}${scopeRow('sc-other', 40)}</svg>`);
  const r = m.capture(m.request(m.layerEl.querySelector('[drawable]')));
  const svg = decodeURIComponent(r.url.slice(r.url.indexOf(',') + 1));
  assert.ok(!svg.includes('id="sc-out-flood"') && !svg.includes('id="sc-out-grad"') && !svg.includes('id="sc-out-mark"'), 'no filter, paint server or marker outside every drawable canvas is copied');
  const got = await rasterize(r);
  const px = (x, y) => Array.from(got.getImageData(x, y, 1, 1).data).join();
  const row = (y) => [px(5, y), px(15, y), px(25, y), px(35, y), px(45, y), px(65, y), px(85, y), px(105, y), px(125, y)];
  assert.deepEqual({ 'sc-in': row(10), 'sc-out': row(30), 'sc-other': row(50) }, SCOPE_WANT);
});

// The same markup on the native oracle (Canary 159): [0, 255, 0, 255] and [0, 0, 255, 255].
test('a resource copied from outside the drawable keeps the computed style of its place in the page: a rule that selects it through a link ancestor applies, and never the :visited one (WPT privacy/filtered-outside-subtree-ignored); control: the copy is drawn', async () => {
  const css = 'a:link feFlood{flood-color:rgb(0,255,0)} a:visited feFlood{flood-color:rgb(255,0,0)} .stops stop{stop-color:rgb(0,0,255)}';
  const m = mount('<a href=""><svg width="0" height="0"><filter id="sv-f" x="0" y="0" width="1" height="1"><feFlood/></filter></svg></a>'
    + '<svg class="stops" width="0" height="0"><linearGradient id="sv-g"><stop/></linearGradient></svg>'
    + '<div drawable style="width:40px;height:20px;display:flex"><div style="width:20px;height:20px;background:rgb(0,0,0);filter:url(#sv-f)"></div>'
    + '<svg width="20" height="20"><rect width="20" height="20" fill="url(#sv-g) rgb(9,9,9)"/></svg></div>', { css });
  const got = await rasterize(m.capture(m.request(m.layerEl.querySelector('[drawable]'))));
  assert.deepEqual(Array.from(got.getImageData(10, 10, 1, 1).data), [0, 255, 0, 255], 'the unvisited flood colour of a filter inside a link');
  assert.deepEqual(Array.from(got.getImageData(30, 10, 1, 1).data), [0, 0, 255, 255], 'the stop colour of a rule that selects the gradient by its ancestor');
});

// Measured on the native oracle (Canary 159): in a mask copied from outside the drawable, `g[filter=cross-origin] > rect black[filter=flood white]` masks its element away
// (the inner filter is stripped with the outer one), the same mask inside the drawable draws it (the inner flood applies), and a sibling of the tainted group keeps its filter.
test('in a mask copied from outside the drawable, an element whose filter is ignored for a cross-origin feImage also loses the filters of its descendants (WPT privacy/svg/svg-mask-nested-filter); controls: the same mask inside the drawable, and a sibling of the group', async () => {
  const flood = (id) => `<filter id="${id}" filterUnits="userSpaceOnUse" x="0" y="0" width="20" height="20"><feFlood flood-color="white"/></filter>`;
  const cross = (id) => `<filter id="${id}" filterUnits="userSpaceOnUse" x="0" y="0" width="20" height="20"><feImage href="http://127.0.0.1:9/x.png"/></filter>`;
  const mask = (id, f, w) => `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="20" height="20"><g filter="url(#${f})"><rect width="20" height="20" fill="black" filter="url(#${w})"/></g></mask>`;
  const sib = (id, f, w) => `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="20" height="20"><g filter="url(#${f})"><rect width="20" height="10" fill="white"/></g><rect y="10" width="20" height="10" fill="black" filter="url(#${w})"/></mask>`;
  const m = mount(`<svg width="0" height="0">${flood('tn-w')}${cross('tn-c')}${mask('tn-m', 'tn-c', 'tn-w')}${sib('tn-s', 'tn-c', 'tn-w')}</svg>`
    + `<svg drawable width="60" height="20" style="display:block"><defs>${flood('tn-iw')}${cross('tn-ic')}${mask('tn-im', 'tn-ic', 'tn-iw')}</defs>`
    + '<rect width="20" height="20" fill="rgb(0,0,255)" mask="url(#tn-m)"/><svg x="20" width="20" height="20"><rect width="20" height="20" fill="rgb(0,0,255)" mask="url(#tn-im)"/></svg>'
    + '<svg x="40" width="20" height="20"><rect width="20" height="20" fill="rgb(0,0,255)" mask="url(#tn-s)"/></svg></svg>');
  const el = m.layerEl.querySelector('[drawable]');
  m.capture(m.request(el));
  await new Promise((ok) => setTimeout(ok, 400));
  const got = await rasterize(m.capture(m.request(el)));
  const px = (x, y) => Array.from(got.getImageData(x, y, 1, 1).data).join();
  assert.equal(px(10, 10), '0,0,0,0', 'the copied mask: the inner flood is stripped with the cross-origin filter, the element is masked away');
  assert.equal(px(30, 10), '0,0,255,255', 'control: the same mask inside the drawable keeps the inner flood');
  assert.deepEqual([px(50, 5), px(50, 15)], ['0,0,255,255', '0,0,255,255'], 'control: the tainted group draws unfiltered, its sibling keeps its flood');
});
