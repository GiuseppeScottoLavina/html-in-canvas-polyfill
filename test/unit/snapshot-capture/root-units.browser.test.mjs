// Root-relative units in a snapshot: rem, rlh and rch resolve against the root element of the document they are in, which for a snapshot is the <svg> of the
// image (16 px, line-height normal), not the page's html. Reported by a library built on the polyfill: with `:root { font-size: 24px }` set by a media query,
// a 1rem line was drawn at 16 px (rem-based pages, as with Pico, Tailwind or Bootstrap, moved away from their hit areas). The snapshot's <svg> root now carries
// the page root's font (svg-builder.js rootFontStyle). Measured on Chrome 157: native draws the 1rem line as the 24px one.
import { test, assert } from '/test/unit/lib/t.js';
import { mount, rasterize } from './_support.mjs';

const CSS = '@media (min-width: 1px) { :root { font-size: 24px; line-height: 30px } }'
  + '.d{position:relative;width:400px;height:200px;background:#fff;font:12px Arial;color:#000}.d>div{position:absolute;left:0;white-space:nowrap}'
  + '.rem{top:0;font-size:1rem}.px{top:50px;font-size:24px}.rlh{top:100px;width:20px;line-height:1rlh;background:#000;font-size:12px}.rch{top:150px;height:10px;width:10rch;background:#000}';
const HTML = '<div class="d" drawable><div class="rem">Hamburg</div><div class="px">Hamburg</div><div class="rlh">&nbsp;</div><div class="rch"></div></div>';

/** the ink box of the rows [y0, y1) @param {CanvasRenderingContext2D} x @param {number} y0 @param {number} y1 */
function inkBox(x, y0, y1) {
  const { width } = x.canvas;
  const d = x.getImageData(0, y0, width, y1 - y0).data;
  let l = Infinity, r = -1, t = Infinity, b = -1;
  for (let y = 0; y < y1 - y0; y++) for (let i = 0; i < width; i++) { const k = (y * width + i) * 4; if (d[k + 3] > 0 && d[k] < 128) { l = Math.min(l, i); r = Math.max(r, i); t = Math.min(t, y); b = Math.max(b, y); } }
  return r < 0 ? { w: 0, h: 0 } : { w: r - l + 1, h: b - t + 1 };
}

/** @param {string} url @returns {Promise<CanvasRenderingContext2D>} */
async function rasterUrl(url, w, h) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d', { willReadFrequently: true }));
  x.drawImage(img, 0, 0);
  return x;
}

test('with :root { font-size: 24px } from a media query, a 1rem line is drawn as a 24px one, a 1rlh box is 30 px tall, a 10rch box is ten root zeros wide', async () => {
  const m = mount(HTML, { css: CSS });
  assert.equal(getComputedStyle(document.documentElement).fontSize, '24px', 'the premise: the page root is 24 px');
  const r = m.capture(m.request(/** @type {Element} */ (m.layerEl.firstElementChild)));
  const x = await rasterize(r);
  const rem = inkBox(x, 0, 45), px = inkBox(x, 50, 95), rlh = inkBox(x, 100, 140), rch = inkBox(x, 150, 160);
  assert.ok(px.w > 60, `the 24px line is drawn (${px.w} px wide)`);
  assert.ok(Math.abs(rem.w - px.w) <= 1 && Math.abs(rem.h - px.h) <= 1, `1rem as 24px: ${JSON.stringify(rem)} vs ${JSON.stringify(px)}`);
  assert.equal(rlh.h, 30, '1rlh = the root line-height');
  const probe = document.createElement('span');
  probe.style.cssText = `font-size:24px;font-family:${getComputedStyle(document.documentElement).fontFamily};position:absolute;visibility:hidden`;
  probe.textContent = '0000000000';
  document.body.append(probe);
  const tenZeros = probe.getBoundingClientRect().width;
  probe.remove();
  assert.ok(Math.abs(rch.w - tenZeros) <= 1.5, `10rch = ten zeros of the root font: ${rch.w} vs ${tenZeros.toFixed(1)}`);

  // control: the same image without the root font on its <svg> draws the 1rem line at 16 px (the measurement sees the difference)
  const svg = decodeURIComponent(r.url.slice(r.url.indexOf(',') + 1));
  assert.ok(/<svg [^>]*style="[^"]*font-size:24px!important/.test(svg), 'the <svg> root carries the page root font');
  const without = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace(/(<svg [^>]*?) style="[^"]*"/, '$1'));
  const y = await rasterUrl(without, x.canvas.width, x.canvas.height);
  const remWithout = inkBox(y, 0, 45);
  assert.ok(remWithout.w < px.w * 0.8, `control: without it the 1rem line is narrower (${remWithout.w} vs ${px.w})`);
  assert.ok(inkBox(y, 100, 140).h !== 30, 'control: and the 1rlh box is not 30 px tall');
});

test('an author svg {} rule cannot change the root font of the snapshot (it is important)', async () => {
  const m = mount(HTML, { css: CSS + 'svg{font-size:8px!important;line-height:4px!important}' });
  const r = m.capture(m.request(/** @type {Element} */ (m.layerEl.firstElementChild)));
  const x = await rasterize(r);
  const rem = inkBox(x, 0, 45), px = inkBox(x, 50, 95);
  assert.ok(Math.abs(rem.w - px.w) <= 1, `1rem still as 24px: ${rem.w} vs ${px.w}`);
});
