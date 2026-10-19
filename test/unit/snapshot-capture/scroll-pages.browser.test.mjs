// Scroll compositor, capture side (scroll-pages.js + CaptureRequest.scroll): a scrollport composed from PAGES rendered at other offsets (sticky header hidden) plus the
// header's own tile must equal a capture at the live offset; every scroller the composition cannot reproduce must get no plan.
import { test, assert, frames } from '/test/unit/lib/t.js';
import { mount, rasterize, diffFraction, inkFraction } from './_support.mjs';
import { planScrollPages, planSteps } from '/src/snapshot/capture/scroll-pages.js';
import { cornerSquares, covers, snapPx } from '/src/snapshot/store/scroll-compose.js';

const S = 2;
const rows = Array.from({ length: 120 }, (_, i) => `<div class="row" style="${i % 2 ? 'background:#19263d' : ''}"><span class="b" style="background:hsl(${(i * 37) % 360} 70% 45%)">${i}</span><span>Row ${i} amber fjord kelp ${i * 7}</span></div>`).join('');
const css = '.d{width:420px;height:300px;background:#162033;color:#e8eef7;font:14px/1.35 Arial,sans-serif;display:grid;grid-template-rows:40px 1fr}'
  + '.bar{background:#22324f}.list{overflow:auto;position:relative;min-height:0;background:#162033;scrollbar-width:none}'
  + '.head{position:sticky;top:0;z-index:2;display:flex;gap:12px;padding:8px 12px;background:#2d4470;font-weight:700;border-bottom:1px solid #5a7bb5}'
  + '.row{display:flex;align-items:center;gap:10px;height:34px;padding:0 12px;border-bottom:1px solid #243350}.b{min-width:34px;text-align:center;border-radius:6px;color:#fff}';
const html = `<div class="d" drawable><div class="bar">bar</div><div class="list"><div class="head"><span>#</span><span>Row text</span></div>${rows}</div></div>`;

/** capture of the whole drawable at the LIVE offsets */
const tileOf = async (m) => rasterize(m.capture(m.request(m.layerEl.firstElementChild, { scale: S, prune: true })));

function geoOf(m, tile) {
  const size = m.layer.borderBoxSize(m.layerEl.firstElementChild);
  return { bw: size.width, bh: size.height, scale: S, reduced: false, ink: { left: 0, top: 0, right: 0, bottom: 0 }, widthPx: tile.canvas.width, heightPx: tile.canvas.height };
}

async function crop(m, px, scroll) {
  const rect = { x: px.x / S, y: px.y / S, width: px.width / S, height: px.height / S };
  return rasterize(m.capture({ ...m.request(m.layerEl.firstElementChild, { scale: S, rect, prune: true }), ...(scroll ? { scroll } : {}) }));
}

/** compose the port of `dest` (a tile context) at `top` from pages at `tops` and the pinned tiles */
async function composeAt(m, plan, dest, tops, top) {
  const list = m.layerEl.querySelector('.list');
  const geo = geoOf(m, dest);
  const R = snapPx(plan.port, geo);
  const live = list.scrollTop;
  const pages = [];
  for (const t of tops) pages.push({ t, img: await crop(m, R, { el: list, top: t, hide: plan.pinned }) });
  assert.equal(list.scrollTop, live, 'rendering pages never moves the live scroller');
  const pins = [];
  for (const p of plan.pinned) { const px = snapPx(m.layer.frameRect(p), geo); pins.push({ px, img: await crop(m, px, null) }); }
  const ctx = dest;
  const base = Math.round(top * S);
  ctx.save();
  ctx.globalCompositeOperation = 'copy';
  for (const p of pages) {
    const off = Math.round(p.t * S) - base;
    const y0 = Math.max(0, off), y1 = Math.min(R.height, off + R.height);
    if (y1 <= y0) continue;
    ctx.save(); ctx.beginPath(); ctx.rect(R.x, R.y + y0, R.width, y1 - y0); ctx.clip(); ctx.drawImage(p.img.canvas, R.x, R.y + off); ctx.restore();
  }
  for (const p of pins) { ctx.save(); ctx.beginPath(); ctx.rect(p.px.x, p.px.y, p.px.width, p.px.height); ctx.clip(); ctx.drawImage(p.img.canvas, p.px.x, p.px.y); ctx.restore(); }
  ctx.restore();
  return R;
}

test('a plain list with an opaque sticky header has a plan; the header is pinned', async () => {
  const m = mount(html, { css, width: 440, height: 320 });
  await frames(2);
  const list = m.layerEl.querySelector('.list');
  const plan = planScrollPages(document, m.layer, list, m.layerEl.firstElementChild);
  assert.ok(plan, 'planned');
  assert.deepEqual(plan.pinned, [list.querySelector('.head')]);
  assert.equal(plan.port.height, list.clientHeight);
});

for (const [from, to, tops] of [[0, 137, [0, 260]], [500, 380, [260, 500]], [900, 1013, [900, 1160]], [0, 0.5, [0, 260]]]) {
  test(`composition from pages ${tops.join('+')} at offset ${to} equals the live capture (stale view at ${from})`, async () => {
    const m = mount(html, { css, width: 440, height: 320 });
    const list = m.layerEl.querySelector('.list');
    list.scrollTop = from;
    await frames(2);
    const stale = await tileOf(m);
    const plan = planScrollPages(document, m.layer, list, m.layerEl.firstElementChild);
    assert.ok(plan, 'planned');
    list.scrollTop = to;
    await frames(2);
    const top = list.scrollTop;
    const want = await tileOf(m);
    const before = diffFraction(stale, want);
    const R = await composeAt(m, plan, stale, tops, top);
    assert.ok(covers(tops, top, R.height, S), 'the pages cover the port');
    const got = diffFraction(stale, want);
    if (Math.abs(top - from) > 1) assert.ok(before > 0.05, `control: the stale view differs (${(before * 100).toFixed(2)} %)`);
    assert.ok(got <= 0.001, `composed vs live capture at ${top}: ${(got * 100).toFixed(3)} % differ (stale ${(before * 100).toFixed(2)} %)`);
  });
}

// A rounded scroller: the pages and the pinned header are rendered with square corners, the backdrop (the scroller without its content) fills the corners, and the
// pages are drawn inside the rounded port with the antialiased clip, as the store does (scroll-compose.js compose()).
for (const [radius, border] of [['14px', '1px solid #5a7bb5'], ['30px 12px', '3px solid #a0b4d8']]) {
  test(`rounded scrollport (${radius}, border ${border}): square pages + backdrop + rounded clip equal the live capture`, async () => {
    const rcss = css + `.list{border-radius:${radius};border:${border}}`;
    const m = mount(html, { css: rcss, width: 440, height: 320 });
    const list = m.layerEl.querySelector('.list');
    await frames(2);
    const stale = await tileOf(m);
    const plan = planScrollPages(document, m.layer, list, m.layerEl.firstElementChild);
    assert.ok(plan?.round, 'planned, with the inner radii');
    const geo = geoOf(m, stale);
    const R = snapPx(plan.port, geo);
    const backdrop = await crop(m, R, { el: list, top: list.scrollTop, hide: [], shape: 'backdrop' });
    const pins = [];
    for (const p of plan.pinned) { const px = snapPx(m.layer.frameRect(p), geo); pins.push({ px, img: await crop(m, px, { el: list, top: list.scrollTop, hide: [], shape: 'square' }) }); }
    const tops = [250, 480];
    const pages = [];
    for (const t of tops) pages.push({ t, img: await crop(m, R, { el: list, top: t, hide: plan.pinned, shape: 'square' }) });
    list.scrollTop = 391;
    await frames(2);
    const top = list.scrollTop;
    const want = await tileOf(m);
    const before = diffFraction(stale, want);
    const ctx = stale;
    const base = Math.round(top * S);
    const shape = () => {
      const r = plan.round;
      const sc = (q) => ({ x: q.x * S, y: q.y * S });
      ctx.beginPath(); ctx.roundRect(plan.port.x * S, plan.port.y * S, plan.port.width * S, plan.port.height * S, [sc(r.tl), sc(r.tr), sc(r.br), sc(r.bl)]); ctx.clip();
    };
    ctx.save();
    ctx.globalCompositeOperation = 'copy';
    for (const q of cornerSquares(R, plan.round, S)) { ctx.save(); ctx.beginPath(); ctx.rect(q.x, q.y, q.width, q.height); ctx.clip(); ctx.drawImage(backdrop.canvas, R.x, R.y); ctx.restore(); }
    for (const p of pages) {
      const off = Math.round(p.t * S) - base;
      const y0 = Math.max(0, off), y1 = Math.min(R.height, off + R.height);
      if (y1 <= y0) continue;
      ctx.save(); shape(); ctx.beginPath(); ctx.rect(R.x, R.y + y0, R.width, y1 - y0); ctx.clip(); ctx.drawImage(p.img.canvas, R.x, R.y + off); ctx.restore();
    }
    for (const p of pins) { ctx.save(); shape(); ctx.beginPath(); ctx.rect(p.px.x, p.px.y, p.px.width, p.px.height); ctx.clip(); ctx.drawImage(p.img.canvas, p.px.x, p.px.y); ctx.restore(); }
    ctx.restore();
    const got = diffFraction(stale, want);
    assert.ok(before > 0.05, `control: the stale view differs (${(before * 100).toFixed(2)} %)`);
    assert.ok(covers(tops, top, R.height, S), 'the pages cover the port');
    assert.ok(got <= 0.001, `composed vs live capture at ${top}: ${(got * 100).toFixed(3)} % differ (the corners antialiased by the canvas clip)`);
  });
}

test('a large scroller (9000 elements) is planned in steps; a change of its subtree between two steps ends the plan', async () => {
  const many = Array.from({ length: 3000 }, (_, i) => `<div class="row"><span class="b">${i}</span><span>Row ${i}</span></div>`).join('');
  const m = mount(`<div class="d" drawable><div class="bar">bar</div><div class="list"><div class="head"><span>#</span></div>${many}</div></div>`, { css, width: 440, height: 320 });
  const list = m.layerEl.querySelector('.list');
  await frames(1);
  const it = planSteps(document, m.layer, list, m.layerEl.firstElementChild);
  let steps = 0, r;
  while (!(r = it.next()).done) steps++;
  assert.ok(steps >= 3, `yielded between chunks (${steps})`);
  assert.ok(r.value?.pinned.length === 1, 'and planned');
  const again = planSteps(document, m.layer, list, m.layerEl.firstElementChild);
  again.next();
  list.append(document.createElement('div'));
  let last;
  while (!(last = again.next()).done);
  assert.equal(last.value, null, 'the subtree changed between steps: no plan');
});

test('covers(): gaps, edges and pixel rounding', () => {
  assert.equal(covers([0], 0, 100, 2), true);
  assert.equal(covers([0], 10, 100, 2), false);
  assert.equal(covers([0, 50], 10, 100, 2), true);
  assert.equal(covers([0, 60], 10, 100, 2), false, 'a 10 css px gap at the bottom');
  assert.equal(covers([], 0, 100, 2), false);
  assert.equal(covers([40], 0, 100, 2), false);
});

const refusals = [
  ['horizontal overflow (a horizontal bar is not composed)', (l) => { const w = l.clientWidth; Object.defineProperty(l, 'scrollWidth', { configurable: true, get: () => w + 40 }); }],
  ['an ancestor whose rounded clip reaches over the port', (l) => { const d = l.closest('[drawable]'); d.style.borderRadius = '30px'; d.style.overflow = 'hidden'; }],
  ['a fixed-attachment background image', (l) => { l.style.backgroundImage = 'linear-gradient(red, blue)'; }],
  ['a translucent sticky header', (l) => { l.querySelector('.head').style.background = 'rgba(45,68,112,.8)'; }],
  ['a sticky header with a shadow', (l) => { l.querySelector('.head').style.boxShadow = '0 2px 4px black'; }],
  ['a positioned row painted above the header', (l) => { const r = l.querySelectorAll('.row')[3]; r.style.position = 'relative'; r.style.zIndex = '5'; }],
  ['a fixed descendant', (l) => { l.querySelectorAll('.row')[2].style.position = 'fixed'; }],
  ['a focused field inside', (l) => { const i = document.createElement('input'); l.querySelectorAll('.row')[1].append(i); i.focus(); }],
  ['something painted over the port', (l) => { const d = document.createElement('div'); d.style.cssText = 'position:absolute;left:100px;top:120px;width:60px;height:40px;background:red;z-index:9'; l.closest('[drawable]').append(d); }],
  ['a filter on the scroller', (l) => { l.style.filter = 'blur(1px)'; }],
  ['a canvas inside', (l) => { l.querySelectorAll('.row')[4].append(document.createElement('canvas')); }],
];
for (const [what, change] of refusals) {
  test(`no plan for ${what}`, async () => {
    const m = mount(html, { css, width: 440, height: 320 });
    const list = m.layerEl.querySelector('.list');
    await frames(1);
    assert.ok(planScrollPages(document, m.layer, list, m.layerEl.firstElementChild), 'control: planned before the change');
    change(list);
    await frames(1);
    assert.equal(planScrollPages(document, m.layer, list, m.layerEl.firstElementChild), null);
  });
}

// Classic (non-overlay) scrollbars: headless Chrome hides scrollbars, so this test only measures something in a headed run on a system with classic bars
// (`node test/unit/run.mjs --headed test/unit/snapshot-capture/scroll-pages.browser.test.mjs` with a mouse attached on macOS, or on Windows); otherwise it checks the plan only.
// The bound (0.1 %) is below what a missing thumb sprite costs (0.17 %: the thumb-only capture once hid the whole SVG and these tests still passed at 0.2 %).
test('classic scrollbar: the port from pages + the track tile + the thumb sprite at the live offset equals the live capture', async () => {
  const classic = css.replace('scrollbar-width:none', 'scrollbar-width:auto');
  const m = mount(html, { css: classic, width: 440, height: 320 });
  const list = m.layerEl.querySelector('.list');
  await frames(2);
  const plan = planScrollPages(document, m.layer, list, m.layerEl.firstElementChild);
  assert.ok(plan, 'planned');
  if (!plan.bar) { assert.equal(list.offsetWidth - list.clientWidth, 0, 'no gutter in this run (headless or overlay bars): nothing more to check'); return; }
  list.scrollTop = 120;
  await frames(2);
  const stale = await tileOf(m);
  const geo = geoOf(m, stale);
  const b = plan.bar;
  const trackPx = snapPx(b.gutter, geo);
  const live0 = list.scrollTop;
  const thumbPx = snapPx({ x: b.gutter.x + b.thumbX, y: b.gutter.y + b.thumbY(live0), width: b.thumbW, height: b.thumbH }, geo);
  const track = await crop(m, trackPx, { el: list, top: live0, hide: [], bars: 'track' });
  const thumb = await crop(m, thumbPx, { el: list, top: live0, hide: [], bars: 'thumb' });
  list.scrollTop = 700;
  await frames(2);
  const top = list.scrollTop;
  const want = await tileOf(m);
  await composeAt(m, plan, stale, [520, 780], top);
  const ctx = stale;
  ctx.save(); ctx.beginPath(); ctx.rect(trackPx.x, trackPx.y, trackPx.width, trackPx.height); ctx.clip();
  ctx.globalCompositeOperation = 'copy'; ctx.drawImage(track.canvas, trackPx.x, trackPx.y);
  ctx.globalCompositeOperation = 'source-over'; ctx.drawImage(thumb.canvas, thumbPx.x, thumbPx.y + Math.round((b.thumbY(top) - b.thumbY(live0)) * S));
  ctx.restore();
  const got = diffFraction(stale, want);
  assert.ok(got <= 0.001, `composed with the classic bar vs live capture: ${(got * 100).toFixed(3)} %`);
});

// The thumb tile in every mode: headless Chrome draws no scrollbar gutter (the classic-bar tests above then stop early), so the bar box the clone would paint is put
// into the captured image by hand. With the thumb rule written for every element (`*`), the SVG root and its foreignObject were hidden too and the tile came out empty.
test('the thumb tile shows the thumb box and nothing else of the drawable', async () => {
  const m = mount(html, { css, width: 440, height: 320 });
  const list = m.layerEl.querySelector('.list');
  list.scrollTop = 200;
  await frames(2);
  const el = m.layerEl.firstElementChild;
  const withThumb = (r) => {
    const comma = r.url.indexOf(',');
    const svg = decodeURIComponent(r.url.slice(comma + 1));
    const at = svg.indexOf('>', svg.indexOf('class="hic-root"')) + 1;
    assert.ok(at > 0, 'the tile has its clone root');
    const box = '<div xmlns="http://www.w3.org/1999/xhtml" data-hic-bar="thumb" style="position:absolute;left:30px;top:50px;width:12px;height:40px;background:#f00"></div>';
    return { ...r, url: r.url.slice(0, comma + 1) + encodeURIComponent(svg.slice(0, at) + box + svg.slice(at)) };
  };
  const count = (x, pred) => { const d = x.getImageData(0, 0, x.canvas.width, x.canvas.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (pred(d[i], d[i + 1], d[i + 2], d[i + 3])) n++; return n; };
  const red = (r, g, b, a) => a > 200 && r > 200 && g < 60 && b < 60;
  const thumb = await rasterize(withThumb(m.capture({ ...m.request(el), scroll: { el: list, top: list.scrollTop, hide: [], bars: 'thumb' } })));
  assert.ok(count(thumb, red) >= 12 * 40 * 0.9, `the thumb tile shows the thumb (${count(thumb, red)} red pixels)`);
  assert.equal(count(thumb, (r, g, b, a) => a > 0 && !red(r, g, b, a)), 0, 'nothing else of the drawable is painted in the thumb tile');
  const track = await rasterize(withThumb(m.capture({ ...m.request(el), scroll: { el: list, top: list.scrollTop, hide: [], bars: 'track' } })));
  assert.equal(count(track, red), 0, 'the track tile hides the thumb');
  assert.ok(inkFraction(track) > 0.5, 'the track tile shows the drawable');
});

test('classic scrollbar in a rounded scroller: square pages, track and thumb inside the rounded padding box over the backdrop equal the live capture', async () => {
  const classic = css.replace('scrollbar-width:none', 'scrollbar-width:auto') + '.list{border-radius:16px;border:2px solid #a0b4d8}';
  const m = mount(html, { css: classic, width: 440, height: 320 });
  const list = m.layerEl.querySelector('.list');
  await frames(2);
  const plan = planScrollPages(document, m.layer, list, m.layerEl.firstElementChild);
  assert.ok(plan?.round, 'planned, rounded');
  if (!plan.bar) { assert.equal(list.offsetWidth - list.clientWidth - 4, 0, 'no gutter in this run (headless or overlay bars): nothing more to check'); return; }
  list.scrollTop = 120;
  await frames(2);
  const stale = await tileOf(m);
  const geo = geoOf(m, stale);
  const b = plan.bar;
  const pad = { ...plan.port, width: plan.port.width + b.gutter.width };
  const padPx = snapPx(pad, geo);
  const trackPx = snapPx(b.gutter, geo);
  const live0 = list.scrollTop;
  const thumbPx = snapPx({ x: b.gutter.x + b.thumbX, y: b.gutter.y + b.thumbY(live0), width: b.thumbW, height: b.thumbH }, geo);
  const track = await crop(m, trackPx, { el: list, top: live0, hide: [], bars: 'track', shape: 'square' });
  const thumb = await crop(m, thumbPx, { el: list, top: live0, hide: [], bars: 'thumb', shape: 'square' });
  const backdrop = await crop(m, padPx, { el: list, top: live0, hide: [], shape: 'backdrop' });
  const R = snapPx(plan.port, geo);
  const pins = [];
  for (const p of plan.pinned) { const px = snapPx(m.layer.frameRect(p), geo); pins.push({ px, img: await crop(m, px, { el: list, top: live0, hide: [], shape: 'square' }) }); }
  const tops = [520, 760];
  const pages = [];
  for (const t of tops) pages.push({ t, img: await crop(m, R, { el: list, top: t, hide: plan.pinned, shape: 'square' }) });
  list.scrollTop = 700;
  await frames(2);
  const top = list.scrollTop;
  const want = await tileOf(m);
  const ctx = stale;
  const shape = () => { const r = plan.round; const sc = (q) => ({ x: q.x * S, y: q.y * S }); ctx.beginPath(); ctx.roundRect(pad.x * S, pad.y * S, pad.width * S, pad.height * S, [sc(r.tl), sc(r.tr), sc(r.br), sc(r.bl)]); ctx.clip(); };
  const base = Math.round(top * S);
  ctx.save();
  ctx.globalCompositeOperation = 'copy';
  for (const q of cornerSquares(padPx, plan.round, S)) { ctx.save(); ctx.beginPath(); ctx.rect(q.x, q.y, q.width, q.height); ctx.clip(); ctx.drawImage(backdrop.canvas, padPx.x, padPx.y); ctx.restore(); }
  for (const p of pages) {
    const off = Math.round(p.t * S) - base;
    const y0 = Math.max(0, off), y1 = Math.min(R.height, off + R.height);
    if (y1 <= y0) continue;
    ctx.save(); shape(); ctx.beginPath(); ctx.rect(R.x, R.y + y0, R.width, y1 - y0); ctx.clip(); ctx.drawImage(p.img.canvas, R.x, R.y + off); ctx.restore();
  }
  ctx.save(); shape(); ctx.beginPath(); ctx.rect(trackPx.x, trackPx.y, trackPx.width, trackPx.height); ctx.clip(); ctx.drawImage(track.canvas, trackPx.x, trackPx.y);
  ctx.globalCompositeOperation = 'source-over'; ctx.drawImage(thumb.canvas, thumbPx.x, thumbPx.y + Math.round((b.thumbY(top) - b.thumbY(live0)) * S)); ctx.restore();
  for (const p of pins) { ctx.save(); shape(); ctx.beginPath(); ctx.rect(p.px.x, p.px.y, p.px.width, p.px.height); ctx.clip(); ctx.drawImage(p.img.canvas, p.px.x, p.px.y); ctx.restore(); }
  ctx.restore();
  assert.ok(covers(tops, top, R.height, S), 'the pages cover the port');
  const got = diffFraction(stale, want);
  assert.ok(got <= 0.001, `composed rounded port with the classic bar vs live capture: ${(got * 100).toFixed(3)} %`);
});

test('a vertical classic gutter is planned WITH its bar (track column, thumb geometry of the clone); headless has no gutter, so its layout is stubbed', async () => {
  const m = mount(html, { css, width: 440, height: 320 });
  const list = m.layerEl.querySelector('.list');
  await frames(1);
  const w = list.clientWidth;
  Object.defineProperty(list, 'clientWidth', { configurable: true, get: () => w - 12 });
  Object.defineProperty(list, 'scrollWidth', { configurable: true, get: () => w - 12 });
  const plan = planScrollPages(document, m.layer, list, m.layerEl.firstElementChild);
  assert.ok(plan?.bar, 'planned with a bar');
  assert.equal(plan.bar.gutter.width, 12);
  assert.equal(plan.bar.gutter.x, plan.port.x + plan.port.width);
  assert.equal(plan.bar.thumbY(0), 0);
  assert.ok(plan.bar.thumbY(plan.maxTop) > 0 && plan.bar.thumbY(plan.maxTop) + plan.bar.thumbH <= plan.port.height + 0.01, 'the thumb ends at the bottom of the track');
});
