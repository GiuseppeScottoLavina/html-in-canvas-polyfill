// Loud failure: unsupported content becomes a hatched placeholder plus an entry for the reporter; capture never throws. Shadow trees and top-layer content are NOT refusals (X-13).
// Content the platform itself leaves out of a canvas (a cross-origin image, a frame's document) is drawn as the platform draws it, its own box without the content, and is still reported.
import { test, assert } from '/test/unit/lib/t.js';
import { mount, rasterize } from './_support.mjs';

const svgOf = (r) => decodeURIComponent(r.url.slice(r.url.indexOf(',') + 1));

test('a cross-origin iframe draws its own box (border, background) without its document and is reported with a path, never a hatched box; an open shadow root is drawn; a modal dialog and an open popover are left out silently (X-13)', async () => {
  const css = '.d{width:300px;height:200px}.d>*{display:block;width:80px;height:40px}.d>iframe{box-sizing:border-box;border:5px solid rgb(255,255,0);background:rgb(0,255,255)}';
  const m = mount('<div class="d" drawable><iframe src="http://127.0.0.1:9/frame.html"></iframe><div id="host"></div><dialog id="dlg">modal</dialog><div id="pop" popover="manual">pop</div><p>kept text</p></div>', { css });
  m.layerEl.querySelector('#host').attachShadow({ mode: 'open' }).innerHTML = '<b>inside</b>';
  const dlg = m.layerEl.querySelector('#dlg');
  dlg.showModal();
  m.layerEl.querySelector('#pop').showPopover();
  const r = m.capture(m.request(m.layerEl.firstElementChild));
  dlg.close();
  m.layerEl.querySelector('#pop').hidePopover();
  assert.deepEqual(r.unsupported.map((e) => e.feature), ['iframe']);
  assert.ok(r.unsupported.every((e) => e.path && e.message && e.t >= 0 && e.count === 1));
  assert.ok(r.unsupported[0].path.endsWith('iframe'));
  const svg = svgOf(r);
  assert.ok(!svg.includes('data-hic-node') && !svg.includes('<iframe') && !svg.includes('127.0.0.1:9'), 'no hatched box, no frame element, never the frame URL');
  assert.ok(svg.includes('inside'), 'the shadow tree of the host is drawn');
  assert.ok(!svg.includes('>modal<') && !svg.includes('>pop<'), 'top-layer content is painted in the page top layer, never into the canvas');
  assert.ok(svg.includes('kept text'), 'the rest of the drawable is still captured');
  assert.equal(m.reported.length, 1);
  const got = await rasterize(r);
  const px = (x, y) => Array.from(got.getImageData(x, y, 1, 1).data);
  assert.deepEqual(px(2, 20), [255, 255, 0, 255], 'the border of the frame');
  assert.deepEqual(px(40, 20), [0, 255, 255, 255], 'the background of the frame, where the document would be');
});

test('shadow DOM inside a drawable: flat-tree order, slotted light DOM, shadow-scoped styles and :host are drawn (X-13)', async () => {
  const m = mount('<div class="d" drawable style="width:60px;height:60px"><div id="host"><span slot="s" id="light">L</span></div></div>');
  const sr = m.layerEl.querySelector('#host').attachShadow({ mode: 'open' });
  sr.innerHTML = '<style>:host{display:block;width:60px;height:60px} .top{height:30px;background:rgb(0,0,255)} ::slotted(span){display:block;height:30px;background:rgb(0,128,0)}</style><div class="top"></div><slot name="s"></slot><slot>fallback</slot>';
  const r = m.capture(m.request(m.layerEl.firstElementChild));
  assert.deepEqual(r.unsupported, []);
  const svg = svgOf(r);
  assert.ok(svg.indexOf('class="top"') < svg.indexOf('id="light"') && svg.indexOf('id="light"') < svg.indexOf('fallback'), 'shadow children, then the slotted span, then the default slot fallback');
  const got = await rasterize(r);
  const px = (x, y) => Array.from(got.getImageData(x, y, 1, 1).data.slice(0, 3));
  assert.deepEqual(px(10, 10), [0, 0, 255], 'shadow-scoped rule');
  assert.deepEqual(px(10, 40), [0, 128, 0], '::slotted rule');
});

test('the same refusal repeated by every capture is one console.error per (feature, path)', () => {
  const m = mount('<div class="d" drawable style="width:50px;height:50px"><iframe src="http://127.0.0.1:9/frame.html" width="30" height="30"></iframe></div>');
  for (let i = 0; i < 5; i++) m.capture(m.request(m.layerEl.firstElementChild));
  assert.equal(m.reported.length, 5);
  assert.equal(m.consoleOnce.size, 1);
});

test('a tainted canvas child is refused, not read', () => {
  const m = mount('<div class="d" drawable style="width:80px;height:40px"><canvas id="t" width="40" height="20"></canvas></div>');
  const t = m.layerEl.querySelector('#t');
  const taint = t.getContext('2d');
  Object.defineProperty(t, 'toDataURL', { value() { throw new DOMException('tainted', 'SecurityError'); } });
  taint.fillRect(0, 0, 4, 4);
  const r = m.capture(m.request(m.layerEl.firstElementChild));
  assert.equal(r.unsupported[0].feature, 'canvas-child');
});

test('cross-origin image without CORS: first pending, then reported with cross-origin-resource and drawn as the platform draws it (its box without the picture), never a silent blank', async () => {
  const src = 'http://127.0.0.1:9/never.png';
  const m = mount(`<div class="d" drawable style="width:80px;height:40px;background:rgb(0,128,0)"><img src="${src}" width="40" height="20" style="display:block;border:5px solid rgb(255,255,0)"></div>`);
  const el = m.layerEl.firstElementChild;
  const first = m.capture(m.request(el));
  assert.equal(first.complete, false);
  await new Promise((ok) => setTimeout(ok, 300));
  const second = m.capture(m.request(el));
  assert.deepEqual(second.unsupported.map((e) => e.feature), ['cross-origin-resource']);
  assert.ok(second.unsupported[0].message.includes('127.0.0.1:9'));
  assert.ok(!svgOf(second).includes('data-hic-node'), 'no hatched box');
  assert.ok(!/<img[^>]*\ssrc=/.test(svgOf(second)), 'the <img> has no source at all');
  assert.ok(!/(src|href)="http/.test(svgOf(second)) && !/url\(["']?http/.test(svgOf(second)), 'the SVG image never loads the external url');
  const px = (await rasterize(second)).getImageData(0, 0, 80, 40);
  const at = (x, y) => Array.from(px.data.slice((y * 80 + x) * 4, (y * 80 + x) * 4 + 4));
  assert.deepEqual(at(2, 10), [255, 255, 0, 255], 'the border of the <img> is drawn');
  assert.deepEqual(at(20, 15), [0, 128, 0, 255], 'no picture where the image would be: the background of the drawable shows through');
});

test('<picture> whose selected source is cross-origin: the <img> box without the picture, reported (WPT privacy/picture-images-ignored)', async () => {
  // another origin of the test server (no CORS headers): the source is selected, its URL is the image's currentSrc
  const other = `http://localhost:${location.port}/test/unit/snapshot-capture/assets/red.svg?iso=0`;
  const m = mount(`<div class="d" drawable style="width:40px;height:40px;background:rgb(0,128,0)"><picture><source srcset="${other}"><img width="40" height="40" style="display:block"></picture></div>`);
  const el = m.layerEl.firstElementChild;
  const img = el.querySelector('img');
  for (let i = 0; i < 50 && !img.currentSrc; i++) await new Promise((ok) => setTimeout(ok, 20));
  assert.equal(img.currentSrc, other, 'the source is selected');
  m.capture(m.request(el));
  await new Promise((ok) => setTimeout(ok, 300));
  const r = m.capture(m.request(el));
  assert.deepEqual(r.unsupported.map((e) => e.feature), ['cross-origin-resource']);
  assert.ok(!svgOf(r).includes('data-hic-node') && !svgOf(r).includes('localhost'));
  const px = (await rasterize(r)).getImageData(20, 20, 1, 1).data;
  assert.deepEqual(Array.from(px), [0, 128, 0, 255]);
});

test('<embed> / <object> of a same-origin image draw it (natural size, top left of the content box); a cross-origin one draws its own box only and is reported (WPT privacy/embed-image-ignored, object-image-ignored)', async () => {
  const box = 'style="display:block;width:40px;height:20px;border:5px solid rgb(255,255,0);background:rgb(0,255,255)"';
  const m = mount(`<div class="d" drawable style="width:50px;height:90px"><embed id="e1" type="image/svg+xml" src="/test/unit/snapshot-capture/assets/red.svg" ${box}><object id="o1" data="/test/unit/snapshot-capture/assets/red.svg" ${box}></object><embed id="e2" type="image/png" src="http://127.0.0.1:9/x.png" ${box}></div>`);
  const el = m.layerEl.firstElementChild;
  m.capture(m.request(el));
  await new Promise((ok) => setTimeout(ok, 400));
  const r = m.capture(m.request(el));
  assert.deepEqual(r.unsupported.map((e) => e.feature), ['cross-origin-resource']);
  const svg = svgOf(r);
  assert.ok(!svg.includes('data-hic-node') && !svg.includes('<embed') && !svg.includes('<object') && !svg.includes('127.0.0.1:9'));
  const x = await rasterize(r);
  const px = (a, b) => Array.from(x.getImageData(a, b, 1, 1).data);
  assert.deepEqual(px(20, 15), [224, 0, 0, 255], 'the embedded image (red.svg) is drawn');
  assert.deepEqual(px(20, 45), [224, 0, 0, 255], 'the object image is drawn');
  assert.deepEqual(px(2, 75), [255, 255, 0, 255], 'the cross-origin embed keeps its border');
  assert.deepEqual(px(20, 75), [0, 255, 255, 255], 'and its background, without the image');
});

test('node budget: absolute refuses with a placeholder tile, hard reports and still renders', async () => {
  const items = Array.from({ length: 30 }, (_, i) => `<i>${i}</i>`).join('');
  const refuse = mount(`<div class="d" drawable style="width:100px;height:60px">${items}</div>`, { envOpts: { nodeBudget: { soft: 5, hard: 10, absolute: 20 } } });
  const r = refuse.capture(refuse.request(refuse.layerEl.firstElementChild));
  assert.deepEqual(r.unsupported.map((e) => e.feature), ['node-budget']);
  assert.ok(svgOf(r).includes('data-hic-node') && !svgOf(r).includes('<i>'));
  assert.deepEqual([r.widthPx, r.heightPx], [100, 60]);
  const degrade = mount(`<div class="d" drawable style="width:100px;height:60px">${items}</div>`, { envOpts: { nodeBudget: { soft: 5, hard: 10, absolute: 1000 } } });
  const d = degrade.capture(degrade.request(degrade.layerEl.firstElementChild));
  assert.deepEqual(d.unsupported.map((e) => e.feature), ['node-budget']);
  assert.ok(svgOf(d).includes('<i>29</i>') || svgOf(d).includes('29'), 'the content is still captured');
  assert.ok(d.nodes >= 30);
});

test('capture never throws: a detached or hidden drawable yields a placeholder tile and an internal-error report', async () => {
  const m = mount('<div class="d" drawable style="width:50px;height:20px">x</div>');
  const el = m.layerEl.firstElementChild;
  const req = m.request(el);
  el.style.display = 'none';
  const r = m.capture(req);
  assert.ok(r.url.startsWith('data:image/svg+xml'));
  assert.equal(r.unsupported[0].feature, 'capture-error');
  assert.equal(m.caught.length, 1);
  assert.ok((await rasterize(r)).canvas.width > 0);
});

test('weird author markup survives serialisation: framework attributes, control characters, lone surrogates', async () => {
  const m = mount('<div class="d" drawable style="width:100px;height:30px" @click="go()" :class="x" x-on:click="y" onclick="alert(1)">a\u0001b\ud800c &amp; &lt;tag&gt;</div>');
  const r = m.capture(m.request(m.layerEl.firstElementChild));
  assert.deepEqual(r.unsupported, []);
  const s = svgOf(r);
  assert.ok(!s.includes('@click') && !s.includes('onclick') && !s.includes('x-on'));
  assert.ok((await rasterize(r)).canvas.width === 100);
});

test('a 404 image stays an <img> (the platform draws the broken-image icon, WPT broken-image) and is reported as resource-fetch-failed, not hidden behind a hatched box', async () => {
  const m = mount('<div class="d" drawable style="width:60px;height:60px;background:green"><img id="b" src="/test/unit/snapshot-capture/assets/does-not-exist.png" width="60" height="60"></div>');
  m.capture(m.request(m.layerEl.firstElementChild));
  await new Promise((ok) => setTimeout(ok, 400));
  const r = m.capture(m.request(m.layerEl.firstElementChild));
  assert.ok(r.unsupported.some((e) => e.feature === 'resource-fetch-failed'), 'reported loudly');
  assert.ok(!svgOf(r).includes('data-hic-node'), 'no hatched placeholder');
  assert.ok(/<img[^>]*src="data:image\/png;base64,AAAA"/.test(svgOf(r)), 'an undecodable image keeps its box and draws as a broken image');
});
