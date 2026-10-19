// CSS collection: media flattening, viewport units, own sheets skipped, shadow roots, per-tile shaking, caching.
import { test, assert } from '/test/unit/lib/t.js';
import { createCssCollector } from '/src/snapshot/capture/css-collector.js';
import { mount, rasterize, reference, diffFraction } from './_support.mjs';

const svgOf = (r) => decodeURIComponent(r.url.slice(r.url.indexOf(',') + 1));

test('collector flattens matching @media, drops the others, handles nested @media and viewport units', () => {
  const m = mount('<div class="d" drawable>x</div>', {
    css: `@media (min-width:100px){.yes{--m:1}}@media (max-width:100px){.no{--m:2}}.n{color:red;@media (min-width:100px){background:blue}@media (max-width:100px){background:green}}.v{width:50vw;height:10vh}`,
  });
  const b = createCssCollector(m.env).bundle(m.record, m.resources);
  assert.ok(/\.yes\s*\{/.test(b.css) && !b.css.includes('@media'));
  assert.ok(!/\.no\s*\{/.test(b.css));
  assert.ok(/background:\s*blue/.test(b.css) && !/green/.test(b.css), 'nested @media evaluated');
  assert.ok(b.css.includes(`${innerWidth / 2}px`) && b.css.includes(`${innerHeight / 10}px`), 'viewport units in px of the live window');
});

test('collector rewrites pseudo-classes and root selectors, reports which exist, drops :visited and scrollbar rules', () => {
  const m = mount('<div class="d" drawable>x</div>', { css: 'a:hover{color:red}html.x body p:focus-visible{color:blue}a:visited{color:pink}.s::-webkit-scrollbar{width:9px}:root{--q:1}' });
  const b = createCssCollector(m.env).bundle(m.record, m.resources);
  assert.ok(b.css.includes('a.hic-hover') && b.css.includes('.hic-root.x p.hic-focus-visible') && b.css.includes('.hic-root{'));
  assert.ok(!b.css.includes('pink') && !b.css.includes('width: 9px'));
  assert.deepEqual(b.pseudo, { hover: true, active: false, focus: false, focusVisible: true, focusWithin: false, hoverLayout: false });
  assert.deepEqual(b.pendingUrls, []);
});

test('the polyfill own sheets and adopted sheets are handled: own skipped, author adopted included', () => {
  const m = mount('<div class="d" drawable>x</div>', { css: '.author{color:#010203}' });
  m.host.insertAdjacentHTML('beforeend', '<style data-hic-node>.polyfill{color:#a1a2a3}</style>');
  const adopted = new CSSStyleSheet();
  adopted.replaceSync('.adopted{color:#040506}');
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, adopted];
  try {
    const css = createCssCollector(m.env).bundle(m.record, m.resources).css;
    assert.ok(css.includes('author') && css.includes('adopted'));
    assert.ok(!css.includes('polyfill'));
  } finally { document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== adopted); }
});

test('bundles are cached per key; invalidate() rebuilds; a resource arriving rebuilds', async () => {
  const m = mount('<div class="d" drawable>x</div>', { css: '.a{background:url(/test/unit/snapshot-capture/assets/red.svg)}' });
  const c = createCssCollector(m.env);
  const first = c.bundle(m.record, m.resources);
  assert.equal(c.bundle(m.record, m.resources), first);
  assert.equal(first.pendingUrls.length, 1);
  assert.ok(first.css.includes('url("data:,")'));
  c.invalidate();
  assert.notEqual(c.bundle(m.record, m.resources), first);
  await m.resources.load(first.pendingUrls[0], 'svg');
  const ready = c.bundle(m.record, m.resources);
  assert.deepEqual(ready.pendingUrls, []);
  assert.ok(ready.css.includes('data:image/svg+xml;base64,'));
});

test('a canvas inside a shadow root: :host rules style the canvas shell, root sheets are included', () => {
  const m = mount('<div class="d" drawable>x</div>');
  const host = document.createElement('div');
  m.host.append(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<style>:host{--k:1}:host(.on) .in{color:red}.in{color:blue}</style>';
  const b = createCssCollector(m.env).bundle({ ...m.record, root }, m.resources);
  assert.ok(b.css.includes('[data-hic-root]{') && b.css.includes('[data-hic-root].on .in'));
});

test('tree shaking: 400 KB of unused rules and fonts cost the tile no more than 25 % over the empty sheet', async () => {
  let big = '';
  for (let i = 0; i < 6000; i++) big += `.unused${i}{color:#${(i % 4096).toString(16).padStart(3, '0')};margin:${i}px;padding:1px 2px 3px 4px}`;
  big += '@font-face{font-family:Big;src:url(data:font/woff2;base64,' + 'A'.repeat(100_000) + ')}';
  const html = '<div class="d" drawable style="width:120px;height:40px;font:14px sans-serif">hello <span class="used">word</span></div>';
  const small = mount(html, { css: '.used{color:#a00}' });
  const smallBytes = small.capture(small.request(small.layerEl.firstElementChild)).timings.bytes;
  const large = mount(html, { css: '.used{color:#a00}' + big });
  const r = large.capture(large.request(large.layerEl.firstElementChild));
  assert.ok(r.timings.bytes <= smallBytes * 1.25, `bytes ${r.timings.bytes} vs ${smallBytes}`);
  assert.ok(!svgOf(r).includes('unused') && !svgOf(r).includes('AAAAAAAA'));
  assert.ok(r.timings.shakeMs >= 0);
  const again = large.capture(large.request(large.layerEl.firstElementChild));
  assert.equal(again.timings.shakeMs < r.timings.shakeMs + 1, true);
  const ref = await reference('<div style="width:120px;height:40px;font:14px sans-serif">hello <span style="color:#a00">word</span></div>', '', 120, 40);
  assert.ok(diffFraction(await rasterize(r), ref) <= 0.03);
});

test('@container rules whose container is outside the canvas are reported once', () => {
  const m = mount('<div class="d" drawable>x</div>', { css: '.out{container-type:inline-size}@container (min-width:10px){.d{color:red}}' });
  m.host.classList.add('out');
  m.capture(m.request(m.layerEl.firstElementChild));
  m.capture(m.request(m.layerEl.firstElementChild));
  assert.deepEqual(m.reported.filter((e) => e.feature === 'container-queries').length, 1);
});
