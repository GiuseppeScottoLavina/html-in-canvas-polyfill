// CSS collection: media flattening, viewport units, own sheets skipped, shadow roots, per-tile shaking, caching.
import { test, assert } from '/test/unit/lib/t.js';
import { createCssCollector } from '/src/snapshot/capture/css-collector.js';
import { BUS } from '/src/contracts/events.js';
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
  assert.deepEqual(b.pseudo, { hover: true, active: false, focus: false, focusVisible: true, focusWithin: false, hoverLayout: false, hoverScope: [{ sel: 'a:is(*)', subject: ['t:a'], context: [] }] }, 'and the :hover rules made neutral, with the tokens they need');
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

test('a canvas record that is disposed or detached lets its bundle go: 40 canvases created and removed leave the cache bounded; a live canvas keeps its bundle', () => {
  const N = 40;
  // per-canvas rules (rewritten for each canvas's identity) and an inlined image, as a bundle of a real page holds
  const rules = Array.from({ length: N }, (_, i) => `#churn-${i} .d{color:rgb(${i},0,0);background:url("data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" id="s${i}"/>`)}")}`).join('');
  const m = mount('<div class="d" drawable>x</div>', { css: rules });
  const c = createCssCollector(m.env);
  const live = c.bundle(m.record, m.resources);
  const suspended = { ...m.record, id: 2, canvas: document.createElement('canvas'), state: 'active' };
  c.bundle(suspended, m.resources);
  m.env.bus.emit(BUS.CANVAS_STATE, { record: suspended, state: 'suspended', previous: 'active' });
  let peak = 0;
  for (let i = 0; i < N; i++) {
    const canvas = document.createElement('canvas');
    canvas.id = `churn-${i}`;
    m.host.append(canvas);
    const record = { ...m.record, id: 100 + i, canvas, state: 'active' };
    assert.ok(c.bundle(record, m.resources).css.includes(`rgb(${i}, 0, 0)`), 'the bundle of this canvas');
    peak = Math.max(peak, c.size());
    canvas.remove();
    const state = i % 2 ? 'disposed' : 'detached';
    record.state = state;
    m.env.bus.emit(BUS.CANVAS_STATE, { record, state, previous: 'active' });
    // a late caller (the tracker asking for pseudo-classes) does not bring a disposed record back
    if (state === 'disposed') c.bundle(record, m.resources);
  }
  assert.equal(peak, 3, 'the live, the suspended and the one being built');
  assert.equal(c.size(), 2, `only the live and the suspended canvas keep a bundle (${c.size()})`);
  // positive control: the live canvas's bundle was not rebuilt (same object on its next snapshot), nor the suspended one's
  assert.equal(c.bundle(m.record, m.resources), live);
  assert.equal(c.size(), 2);
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

// A shorthand with var() that a later longhand of the same rule partly overrides: the CSSOM serialises its other longhands empty (Chrome 157: `border-top-style: ;`),
// and a rule copied from cssText lost the whole shorthand. Found by a library built on the polyfill: a summary::before chevron drawn with
// `border: solid var(--loom-holo); border-width: 0 1.5px 1.5px 0` was not drawn at all (1.5 px or 2 px alike; the same with margin, background, font).
test('a var() shorthand partly overridden by a longhand is copied as written (border, margin, font), not as the CSSOM serialises it', () => {
  const m = mount('<div class="d" drawable>x</div>', { css: '.a{border:solid var(--c);border-width:0 1.5px 1.5px 0}.b{margin:var(--m);margin-left:3px;color:red}.c{font:var(--f);font-size:12px}.d{border:solid var(--c)}' });
  const sheet = /** @type {CSSStyleSheet} */ ([...document.styleSheets].find((s) => s.ownerNode && m.host.contains(s.ownerNode)));
  assert.ok(/border-top-style:\s*;/.test(sheet.cssRules[0].cssText), `the browser serialises the rule with empty declarations (the premise): ${sheet.cssRules[0].cssText}`);
  const css = createCssCollector(m.env).bundle(m.record, m.resources).css;
  assert.ok(css.includes('.a{border:solid var(--c);border-width:0 1.5px 1.5px 0}'), css.slice(-400));
  assert.ok(css.includes('.b{margin:var(--m);margin-left:3px;color:red}') && css.includes('.c{font:var(--f);font-size:12px}'));
  assert.ok(!/:\s*;/.test(css), 'no empty declaration left');
  assert.ok(/\.d\s*\{\s*border:\s*solid var\(--c\);?\s*\}/.test(css), 'a rule the CSSOM serialises whole keeps its own text');
});

test('a lossy rule takes only its own text: one changed through the CSSOM, or inserted, keeps what the CSSOM gives; a constructed sheet (no text) is copied as before', () => {
  const m = mount('<div class="d" drawable>x</div>', { css: '.a{border:solid var(--c);border-width:0 1.5px 1.5px 0}.e{border:solid var(--c);border-width:1px}' });
  const sheet = /** @type {CSSStyleSheet} */ ([...document.styleSheets].find((s) => s.ownerNode && m.host.contains(s.ownerNode)));
  /** @type {CSSStyleRule} */ (sheet.cssRules[1]).style.setProperty('border-left-width', '4px');
  sheet.insertRule('.a{border:solid var(--c);border-width:9px}', 2);
  const adopted = new CSSStyleSheet();
  adopted.replaceSync('.k{border:solid var(--c);border-width:0 3px}');
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, adopted];
  try {
    const b = createCssCollector(m.env).bundle(m.record, m.resources);
    assert.ok(b.css.includes('.a{border:solid var(--c);border-width:0 1.5px 1.5px 0}'), 'the first rule as written');
    assert.ok(!b.css.includes('.e{border:solid var(--c);border-width:1px}'), 'the changed rule does not take its stale text');
    assert.ok(/\.e\s*\{[^}]*border-width:\s*1px 1px 1px 4px/.test(b.css), `the changed rule as the CSSOM gives it: ${b.css.slice(b.css.indexOf('.e'), b.css.indexOf('.e') + 300)}`);
    assert.ok(/border-width:\s*9px/.test(b.css) && !b.css.includes('.a{border:solid var(--c);border-width:9px}'), 'the inserted rule is not in the text: as the CSSOM gives it');
    assert.ok(/\.k\s*\{/.test(b.css) && /border-width:\s*0px 3px/.test(b.css), 'the constructed sheet is copied');
    assert.deepEqual(b.pendingUrls, []);
  } finally { document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== adopted); }
});

test('a linked sheet: its lossy rule waits for the sheet file (pending), then is copied as written', async () => {
  const m = mount('<div class="d" drawable>x</div>');
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/test/unit/snapshot-capture/assets/var-shorthand.css';
  await new Promise((ok, ko) => { link.onload = ok; link.onerror = ko; m.host.append(link); });
  const c = createCssCollector(m.env);
  const first = c.bundle(m.record, m.resources);
  assert.ok(first.pendingUrls.includes(link.href), JSON.stringify(first.pendingUrls));
  await m.resources.load(link.href, 'css');
  c.invalidate();
  const ready = c.bundle(m.record, m.resources);
  assert.ok(ready.css.includes('.linked{border:solid var(--c);border-width:0 2px 2px 0}'), ready.css.slice(-300));
  assert.ok(!ready.pendingUrls.includes(link.href));
});

test('pixels: the chevron of the report (summary::before, a var() border of 1.5 px, rotated) is drawn as its reference', async () => {
  const css = ':root{--loom-holo:#e0218a}summary{list-style:none;padding:20px}summary::before{content:"";width:7px;height:7px;border:solid var(--loom-holo);border-width:0 1.5px 1.5px 0;transform:rotate(-45deg)}'
    + '.ib::before{display:inline-block}';
  const html = '<div class="d" drawable style="width:120px;height:60px;background:#fff"><details><summary>a</summary></details><details class="ib"><summary>b</summary></details></div>';
  const m = mount(html, { css });
  const r = m.capture(m.request(/** @type {Element} */ (m.layerEl.firstElementChild)));
  const got = await rasterize(r);
  const ref = await reference(html.replace(' drawable', ''), css, 120, 60);
  const pink = (/** @type {CanvasRenderingContext2D} */ x) => { const d = x.getImageData(0, 0, 120, 60).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i + 1] < 120 && d[i + 2] > 80) n++; return n; };
  assert.ok(pink(ref) >= 10, `the reference draws the chevrons (${pink(ref)} pink pixels)`);
  assert.ok(pink(got) >= pink(ref) * 0.8, `the tile draws them too: ${pink(got)} pink pixels, reference ${pink(ref)}`);
  assert.ok(diffFraction(got, ref) <= 0.01, `diff ${diffFraction(got, ref)}`);
});
