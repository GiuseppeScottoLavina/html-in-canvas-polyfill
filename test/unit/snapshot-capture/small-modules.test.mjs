import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBudget } from '../../../src/snapshot/capture/budget.js';
import { shellNeedsBox } from '../../../src/snapshot/capture/shells.js';
import { buildSvgMarkup, cropPixels, encodeSvgDataUrl, rootTransform, scaleMode } from '../../../src/snapshot/capture/svg-builder.js';
import { inlineCssUrls, resolveResource, createResourceCache, kindOfUrl } from '../../../src/snapshot/capture/inline-resources.js';
import { HicUnsupportedError } from '../../../src/contracts/errors.js';

const budget = { soft: 350, hard: 3000, absolute: 20000 };

test('budget ladder: boundaries are inclusive on the lower step', () => {
  assert.equal(evaluateBudget(0, budget), 'ok');
  assert.equal(evaluateBudget(350, budget), 'ok');
  assert.equal(evaluateBudget(351, budget), 'prune');
  assert.equal(evaluateBudget(3000, budget), 'prune');
  assert.equal(evaluateBudget(3001, budget), 'degrade');
  assert.equal(evaluateBudget(20000, budget), 'degrade');
  assert.equal(evaluateBudget(20001, budget), 'refuse');
});

const plain = { containerType: 'normal', contain: 'none', overflow: 'visible visible', transform: 'none', filter: 'none', display: 'block' };

test('shellNeedsBox: only things that change the descendants need a real box', () => {
  assert.equal(shellNeedsBox(plain), false);
  assert.equal(shellNeedsBox({ ...plain, containerType: 'inline-size' }), true);
  assert.equal(shellNeedsBox({ ...plain, containerType: 'size' }), true);
  assert.equal(shellNeedsBox({ ...plain, contain: 'layout paint' }), true);
  assert.equal(shellNeedsBox({ ...plain, contain: 'strict' }), true);
  assert.equal(shellNeedsBox({ ...plain, contain: 'inline-size' }), true);
  assert.equal(shellNeedsBox({ ...plain, overflow: 'hidden visible' }), true);
  assert.equal(shellNeedsBox({ ...plain, overflow: 'auto auto' }), true);
  assert.equal(shellNeedsBox({ ...plain, transform: 'matrix(1, 0, 0, 1, 5, 0)' }), true);
  assert.equal(shellNeedsBox({ ...plain, filter: 'blur(2px)' }), true);
  assert.equal(shellNeedsBox({ ...plain, display: 'contents', containerType: 'size' }), false);
});

test('svg markup: viewBox crops at physical-pixel scale, foreignObject covers the frame', () => {
  const svg = buildSvgMarkup('<div>x</div>', '.a{color:red}', { x: 10, y: 20, width: 100, height: 50 }, { width: 300, height: 200 }, 2);
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="20 40 200 100">'));
  assert.ok(svg.includes('<foreignObject x="0" y="0" width="600" height="400">'));
  // the sheet is an SVG <style> before the foreignObject (an XHTML one inside it delays Chromium's image load to a later task)
  assert.ok(svg.includes('<style>.a{color:red}</style><foreignObject x="0" y="0" width="600" height="400"><div>x</div></foreignObject>'));
  assert.deepEqual(cropPixels({ x: 0, y: 0, width: 10.4, height: 3.2 }, 1.5), { widthPx: 16, heightPx: 5 });
  assert.deepEqual(cropPixels({ x: 0, y: 0, width: 10.2, height: 3 }, 1.5), { widthPx: 16, heightPx: 5 }, 'rounded UP like the surface: 15.3 px was 15, and the whole-frame tile was stretched into the 16 px surface');
});

test('svg markup, Gecko viewBox mode: layout at css scale, the viewBox maps the crop onto the device-pixel raster', () => {
  const svg = buildSvgMarkup('<div>x</div>', '', { x: 10, y: 20, width: 100, height: 50 }, { width: 300, height: 200 }, 2, 'viewBox');
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="10 20 100 50">'), svg.slice(0, 120));
  assert.ok(svg.includes('<foreignObject x="0" y="0" width="300" height="200">'));
});

test('svg markup, WebKit transform mode: the crop offset is in the root transform, the viewBox starts at 0 0 (WebKit ignores the viewBox origin for layered HTML)', () => {
  const crop = { x: 10, y: 20, width: 100, height: 50 };
  const svg = buildSvgMarkup('<div>x</div>', '', crop, { width: 300, height: 200 }, 2, 'transform');
  // regression (Safari 27, water-form): viewBox "20 40 ..." made a damage-cropped tile show the frame's top-left, pasted at the crop position
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">'), svg.slice(0, 120));
  assert.equal(rootTransform(crop, 2), 'translate(-20px, -40px) scale(2)');
  assert.equal(rootTransform({ x: 0, y: 0, width: 5, height: 5 }, 1), null);
  assert.equal(rootTransform({ x: 3.5, y: 0, width: 5, height: 5 }, 1), 'translate(-3.5px, 0px) scale(1)');
  assert.ok(svg.includes('<foreignObject x="0" y="0" width="600" height="400">'));
  assert.equal(scaleMode(), 'zoom', 'outside a browser (and on Chromium) the zoom path is kept');
});

test('svg markup escapes css, strips characters XML cannot carry', () => {
  const svg = buildSvgMarkup('<div>a\u0001b</div>', 'a>b&c<d', { x: 0, y: 0, width: 1, height: 1 }, { width: 1, height: 1 }, 1);
  assert.ok(svg.includes('a&gt;b&amp;c&lt;d'));
  assert.ok(svg.includes('<div>ab</div>'));
});

test('data url is percent-encoded svg, never blob: and survives lone surrogates', () => {
  const url = encodeSvgDataUrl('<svg>é #</svg>');
  assert.ok(url.startsWith('data:image/svg+xml;charset=utf-8,'));
  assert.ok(!url.includes('#') && !url.includes('<'));
  assert.equal(decodeURIComponent(url.slice(url.indexOf(',') + 1)), '<svg>é #</svg>');
  assert.ok(encodeSvgDataUrl('a\ud800b').startsWith('data:image/svg+xml'));
  assert.ok(!url.startsWith('blob:'));
});

/** a cache whose loads we control */
function fakeCache() {
  const store = new Map();
  const loads = [];
  return {
    loads,
    store,
    peek: (u) => store.get(u) ?? null,
    load: (u, kind) => { loads.push([u, kind]); return new Promise((ok, bad) => { store.pending ??= new Map(); store.pending.set(u, { ok, bad }); }); },
    onReady: () => () => {},
    stats: () => ({ entries: store.size, bytes: 0 }),
    clear() { store.clear(); },
  };
}

test('inlineCssUrls: cached urls become data urls, missing ones start a load and are blanked', () => {
  const cache = fakeCache();
  cache.store.set('https://x.test/a/img.png', 'data:image/png;base64,AAAA');
  const r = inlineCssUrls('.a{background:url(img.png)}.b{background:url("/f.woff2")}.c{background:url(\'data:image/png;base64,ZZ\')}.d{fill:url(#clip)}', 'https://x.test/a/s.css', cache);
  assert.equal(r.css, '.a{background:url("data:image/png;base64,AAAA")}.b{background:url("data:,")}.c{background:url(\'data:image/png;base64,ZZ\')}.d{fill:url(#clip)}');
  assert.deepEqual(r.pending, ['https://x.test/f.woff2']);
  assert.deepEqual(cache.loads, [['https://x.test/f.woff2', 'font']]);
  inlineCssUrls('.b{background:url("/f.woff2")}', 'https://x.test/a/s.css', cache);
  assert.equal(cache.loads.length, 1, 'a pending load is not started twice by the capture');
});

test('resolveResource remembers a failure and reports it as failed, not pending', async () => {
  const cache = fakeCache();
  assert.equal(resolveResource(cache, 'https://x.test/i.png').state, 'pending');
  cache.store.pending.get('https://x.test/i.png').bad(new HicUnsupportedError('cross-origin-resource', 'no cors', { path: 'https://x.test/i.png' }));
  await new Promise((r) => setTimeout(r, 0));
  const r = resolveResource(cache, 'https://x.test/i.png');
  assert.equal(r.state, 'failed');
  assert.equal(r.error.feature, 'cross-origin-resource');
  const css = inlineCssUrls('.a{background:url(https://x.test/i.png)}', 'https://x.test/', cache);
  assert.equal(css.failed.length, 1);
  assert.equal(css.css, '.a{background:url("data:,")}');
});

test('resource kinds follow the extension', () => {
  assert.equal(kindOfUrl('https://x/a.woff2?v=1'), 'font');
  assert.equal(kindOfUrl('https://x/a.svg#x'), 'svg');
  assert.equal(kindOfUrl('https://x/a.png'), 'image');
});

test('resource cache: fetches as data url, LRU budget evicts oldest, failures are typed', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const responses = {
    '/ok.png': () => new Response(bytes, { headers: { 'content-type': 'image/png' } }),
    '/big.png': () => new Response(new Uint8Array(200), { headers: { 'content-type': 'image/png' } }),
    '/missing.png': () => new Response('', { status: 404 }),
  };
  const env = {
    document: { baseURI: 'http://p.test/' },
    window: {
      location: { origin: 'http://p.test' },
      fetch: async (u, init) => {
        const url = new URL(u);
        if (url.origin !== 'http://p.test') { if (init.mode !== 'cors' || init.credentials !== 'omit') throw new Error('cors expected'); throw new TypeError('Failed to fetch'); }
        return responses[url.pathname]();
      },
    },
    reporter: { caught() {} },
  };
  const cache = createResourceCache(/** @type {any} */ (env), 160);
  let ready = 0;
  cache.onReady(() => ready++);
  assert.equal(cache.peek('http://p.test/ok.png'), null);
  const url = await cache.load('http://p.test/ok.png', 'image');
  assert.equal(url, 'data:image/png;base64,AQIDBA==');
  assert.equal(cache.peek('http://p.test/ok.png'), url);
  assert.equal(ready, 1);
  await assert.rejects(cache.load('http://p.test/missing.png', 'image'), (e) => e instanceof HicUnsupportedError && e.feature === 'resource-fetch-failed');
  await assert.rejects(cache.load('http://other.test/x.png', 'image'), (e) => e.feature === 'cross-origin-resource' && /CORS/.test(e.message));
  await cache.load('http://p.test/big.png', 'image').then(() => assert.fail('over budget'), (e) => assert.equal(e.feature, 'resource-fetch-failed'));
  assert.equal(cache.stats().entries, 1);
  assert.equal(cache.peek('data:x'), 'data:x');
  cache.clear();
  assert.equal(cache.peek('http://p.test/ok.png'), null);
});
