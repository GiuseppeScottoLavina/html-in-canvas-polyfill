// Found on real Chromium 158 for Android (G-mobile controls, 2026-10-16): the toggle zoom off the device scale, the 16 px indeterminate checkbox, its dark dash and the
// listbox thumb that Chrome for Android keeps visible. The markup is checked (a desktop browser cannot draw the Android theme), plus one pixel check of the dash colour.
import { test, assert } from '/test/unit/lib/t.js';
import { listboxThumb } from '/src/snapshot/capture/scroll-emulation.js';
import { mount, rasterize } from './_support.mjs';

const svgOf = (r) => decodeURIComponent(r.url.slice(r.url.indexOf(',') + 1));
const inputTag = (svg, id) => (new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(svg) ?? [''])[0];

test('a checkbox / radio gets a zoom that brings it back to devicePixelRatio when the raster scale is within 1 % of it, rounded down; not otherwise', async () => {
  const dpr = devicePixelRatio;
  const m = mount('<div class="s" drawable><input type="checkbox" id="c" checked><input type="radio" id="r"><input id="t" value="x"></div>', { css: '.s{width:120px;height:30px}' });
  const off = svgOf(m.capture(m.request(m.layerEl.firstElementChild, { scale: dpr * 1.004 })));
  const want = Math.floor((dpr / Number((dpr * 1.004).toPrecision(6))) * 1e5) / 1e5;
  for (const id of ['c', 'r']) {
    const z = /zoom:\s*([\d.]+)/.exec(inputTag(off, id))?.[1];
    assert.equal(Number(z), want, `${id}: ${inputTag(off, id)}`);
    assert.ok(Number(z) * Number((dpr * 1.004).toPrecision(6)) <= dpr, 'the product never lands above the page scale');
  }
  assert.ok(!/zoom/.test(inputTag(off, 't')), 'a text field is left alone');
  // controls: at the device scale itself and far from it nothing is added
  for (const scale of [dpr, dpr * 1.5]) assert.ok(!/zoom/.test(inputTag(svgOf(m.capture(m.request(m.layerEl.firstElementChild, { scale }))), 'c')), `scale ${scale}`);
});

test('an indeterminate checkbox takes the live box size (16 px on Android) and a dark dash on the default dark fill', async () => {
  const m = mount('<div class="s" drawable><input type="checkbox" id="a"><span class="d"><input type="checkbox" id="b"></span></div>',
    { css: '.s{width:120px;height:40px}#a{width:16px;height:16px;margin:4px}.d{color-scheme:dark}#b{margin:4px}' });
  for (const id of ['a', 'b']) m.layerEl.querySelector('#' + id).indeterminate = true;
  const svg = svgOf(m.capture(m.request(m.layerEl.firstElementChild)));
  const a = inputTag(svg, 'a'), b = inputTag(svg, 'b');
  assert.ok(/width:\s*16px/.test(a) && /height:\s*16px/.test(a), a);
  assert.ok(/background-size:\s*9\.846px 2\.462px/.test(a), `dash scaled 16/13: ${a}`);
  assert.ok(/width:\s*13px/.test(b) && /background-size:\s*8px 2px/.test(b), `13 px default unchanged: ${b}`);
  assert.ok(/rgb\(59, 59, 59\)|#3b3b3b/i.test(b) && !/rgb\(59, 59, 59\)|#3b3b3b/i.test(a), 'dark dash only on the dark fill');
  const x = await rasterize(m.capture(m.request(m.layerEl.firstElementChild)));
  const lb = m.layerEl.getBoundingClientRect(), rb = m.layerEl.querySelector('#b').getBoundingClientRect();
  // the darkest pixel of the box's middle column (the dash is 2 px tall at scale 1); control: the fill around it is the light accent
  const cx = Math.round(rb.left - lb.left + rb.width / 2), cy = Math.round(rb.top - lb.top + rb.height / 2);
  const col = [-3, -2, -1, 0, 1, 2, 3].map((dy) => [...x.getImageData(cx, cy + dy, 1, 1).data]);
  const darkest = col.reduce((a, b) => (b[0] + b[1] + b[2] < a[0] + a[1] + a[2] ? b : a));
  assert.ok(darkest.slice(0, 3).every((v) => Math.abs(v - 59) < 30), `dark dash pixel ${darkest} in ${JSON.stringify(col)}`);
  assert.ok(col.some((p) => p[2] > 230 && p[0] > 120), 'the light accent fill around it');
});

test('Chrome for Android: a scrollable listbox clone carries the overlay thumb in proportion; desktop, an unscrollable list and a background image do not', () => {
  const m = mount('<div class="s" drawable><select size="3" id="l"><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option><option>6</option></select><select size="6" id="u"><option>1</option></select></div>',
    { css: '.s{width:200px;height:120px}' });
  const l = m.layerEl.querySelector('#l'), u = m.layerEl.querySelector('#u');
  l.scrollTop = 20;
  const android = { engine: 'chromium', os: 'android' };
  const run = (el, info, extra = '') => { const c = document.createElement('select'); if (extra) c.style.cssText = extra; listboxThumb(el, c, getComputedStyle(el), el.scrollTop, info); return c.getAttribute('style') ?? ''; };
  const s = run(l, android);
  const ch = l.clientHeight, sh = l.scrollHeight;
  assert.ok(/linear-gradient\(rgba\(128, 128, 128, 0\.5\)/.test(s), s);
  assert.ok(s.includes(`4px ${(ch * ch) / sh}px`), `length ${(ch * ch) / sh}: ${s}`);
  assert.ok(s.includes(`top ${(l.scrollTop * ch) / sh}px`), `offset: ${s}`);
  assert.equal(run(l, { engine: 'chromium', os: 'desktop' }), '', 'desktop: overlay bars fade, nothing drawn');
  assert.equal(run(u, android), '', 'not scrollable');
  l.style.backgroundImage = 'linear-gradient(red, red)';
  assert.equal(run(l, android), '', 'an author background image is kept');
});
