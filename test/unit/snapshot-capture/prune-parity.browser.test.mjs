// Gate finding (G-scroll-inner tight pass): damage-cropped pruning removed siblings and flipped :nth-child stripes.
import { test, assert } from '/test/unit/lib/t.js';
import { mount, rasterize, reference, diffFraction, inkFraction } from './_support.mjs';

const stripes = '.l{width:200px;font:12px sans-serif}.c{height:30px;background:#fafafa}.c:nth-child(even){background:#c8d8ff}.c:nth-child(3n){color:#a00}';
const rows = (n) => Array.from({ length: n }, (_, i) => `<div class="c">Row ${i}</div>`).join('');

test('a damage-pruned tile keeps :nth-child stripes of the rows after the pruned ones (spacers are not merged when selectors count siblings)', async () => {
  const m = mount(`<div class="l" drawable>${rows(60)}</div>`, { css: stripes, height: 2000 });
  const el = m.layerEl.firstElementChild;
  const rect = { x: 0, y: 150, width: 200, height: 90 };
  const full = await rasterize(m.capture(m.request(el, { rect })));
  const pruned = m.capture(m.request(el, { rect, prune: true }));
  assert.ok((decodeURIComponent(pruned.url).match(/data-hic-sp/g) ?? []).length >= 4, 'rows outside the crop became spacers');
  assert.ok(inkFraction(full) > 0.5);
  assert.ok(diffFraction(await rasterize(pruned), full) <= 0.002, 'same stripes as the full tile');
});

test('a long scroller cut to its window keeps stripe parity and the sibling count', async () => {
  const css = `.s{width:120px;height:100px;overflow:auto;position:relative;scrollbar-width:none;font:12px sans-serif}.r{height:20px}.r:nth-child(odd){background:#fdd}.r:nth-child(even){background:#ddf}`;
  const list = Array.from({ length: 301 }, (_, i) => `<div class="r">row ${i}</div>`).join('');
  const m = mount(`<div class="s" drawable>${list}</div>`, { css, layerStyle: 'width:120px;height:100px' });
  const el = m.layerEl.firstElementChild;
  el.scrollTop = 2010;
  const got = await rasterize(m.capture(m.request(el)));
  const ref = await reference(`<div class="s" style="overflow:hidden"><div style="transform:translateY(-2010px)">${list}</div></div>`, css, 120, 100);
  assert.ok(diffFraction(got, ref) <= 0.002, `stripes differ: ${(diffFraction(got, ref) * 100).toFixed(2)} %`);
});

test('script and style siblings keep counting for :nth-child (attribute-only stand-ins)', async () => {
  const css = '.l{width:100px}.l p{height:20px;margin:0}.l p:nth-child(odd){background:rgb(255,0,0)}.l p:nth-child(even){background:rgb(0,0,255)}';
  const m = mount('<div class="l" drawable><script>1</script><p>a</p><p>b</p></div>', { css });
  const x = await rasterize(m.capture(m.request(m.layerEl.firstElementChild)));
  // children: script(1) p(2: even) p(3: odd)
  assert.deepEqual([...x.getImageData(50, 10, 1, 1).data].slice(0, 3), [0, 0, 255]);
  assert.deepEqual([...x.getImageData(50, 30, 1, 1).data].slice(0, 3), [255, 0, 0]);
});

test('a pruned grid item keeps its id: an id-placed spacer (#bar spans both columns) leaves every later item in its cell', async () => {
  const css = '#g{display:grid;grid-template-columns:1fr 80px;width:240px;font:12px sans-serif}#bar{grid-column:1/-1;height:30px;background:#335}#l{height:400px;background:#eef}#s{background:#fdd}';
  const m = mount('<div id="g" drawable><div id="bar">bar</div><div id="l">list</div><div id="s">side</div></div>', { css, height: 500 });
  const el = m.layerEl.firstElementChild;
  const rect = { x: 0, y: 300, width: 240, height: 40 };
  const full = await rasterize(m.capture(m.request(el, { rect })));
  const pruned = m.capture(m.request(el, { rect, prune: true }));
  assert.ok(/data-hic-sp/.test(decodeURIComponent(pruned.url)), 'the bar outside the crop became a spacer');
  assert.ok(diffFraction(await rasterize(pruned), full) <= 0.002, `the pruned tile shows the list and the side where they are (${(diffFraction(await rasterize(pruned), full) * 100).toFixed(2)} %)`);
});

// Chromium scroll compositor drift (work/chromium-drift): a spacer must reach the clone at the live height to the LayoutUnit (1/64 device px). Tiles and scroll
// compositor pages prune different rows, so any spacer error moved the same row between a composed frame and the settled tile.
// Rows of line-height 20.08px are 20.078125 px (the engine truncates 1285.12 LayoutUnits to 1285), 21.078125 px with their border.
const fracRows = '.l{width:200px;font:12px sans-serif}.c{line-height:20.08px;border-bottom:1px solid #345;background:#fafafa}';

test('spacers keep the live height to the LayoutUnit: rows after 100 pruned rows of 21.078125 px are where the full tile has them', async () => {
  // :nth-child keeps one spacer per row. Rounded to the nearest 0.001 px (21.078) and truncated by the engine, each spacer was 1/64 px short: 1.6 px after 100 rows
  const m = mount(`<div class="l" drawable>${rows(140)}</div>`, { css: `${fracRows}.c:nth-child(even){background:#dde6ff}`, height: 3100 });
  const el = m.layerEl.firstElementChild;
  const rect = { x: 0, y: 2200, width: 200, height: 160 };
  const full = await rasterize(m.capture(m.request(el, { rect })));
  const prunedResult = m.capture(m.request(el, { rect, prune: true }));
  assert.ok((decodeURIComponent(prunedResult.url).match(/data-hic-sp/g) ?? []).length >= 100, 'the rows above the crop became spacers, one per row');
  const pruned = await rasterize(prunedResult);
  assert.ok(inkFraction(full) > 0.5);
  const d = diffFraction(pruned, full);
  assert.ok(d <= 0.002, `the pruned tile shows the rows where the full tile does (${(d * 100).toFixed(2)} % differ)`);
});

test('a merged spacer run reaches the clone to the LayoutUnit: runs stay below 1000 px (the CSSOM keeps 6 significant digits of a length)', async () => {
  // no sibling selector: the rows above the crop merge. One 2108 px run was written 2107.81px (2107.8125 rounded by the CSSOM), a LayoutUnit short
  const m = mount(`<div class="l" drawable>${rows(140)}</div>`, { css: fracRows, height: 3100 });
  const el = m.layerEl.firstElementChild;
  const rect = { x: 0, y: 2200, width: 200, height: 160 };
  const url = m.capture(m.request(el, { rect, prune: true })).url;
  const svg = new DOMParser().parseFromString(decodeURIComponent(url.slice(url.indexOf(',') + 1)), 'image/svg+xml');
  const list = svg.querySelector('.l');
  const lead = [];
  for (const c of list.children) { if (!c.hasAttribute('data-hic-sp')) break; lead.push(Number(/(?:^|;)\s*height:\s*([\d.]+)px/.exec(c.getAttribute('style') ?? '')?.[1])); }
  const first = list.children[lead.length];
  const live = el.children[[...list.children].slice(0, lead.length).length && Number(first.textContent.replace(/\D+/g, ''))];
  const want = Math.round((live.getBoundingClientRect().top - el.getBoundingClientRect().top) * 64);
  const units = lead.reduce((a, h) => a + Math.trunc(h * 64), 0);
  assert.ok(lead.length >= 3 && lead.every((h) => h > 0 && h < 1000), `runs below 1000 px: ${lead.join(', ')}`);
  assert.equal(units, want, 'the spacers before the first kept row lay out at its live offset, in LayoutUnits');
});

test('layoutPx rounds a live length up so the engine truncates it back to the same LayoutUnit (below 1000 px, scales up to 15); onLiveGrid removes client-rect noise', async () => {
  const { layoutPx, onLiveGrid } = await import('/src/snapshot/capture/clone.js');
  assert.equal(layoutPx(21.078125), '21.079');
  assert.equal(layoutPx(36.6), '36.6');
  assert.equal(layoutPx(36.6 + 1e-12), '36.6');
  assert.equal(layoutPx(1024.7708), '1024.78', 'above 1000 px: up, to the 6 significant digits the CSSOM keeps');
  assert.equal(layoutPx(123456.7), '123457');
  for (const scale of [1, 1.25, 1.5, 2, 2.5, 3, 4, 15]) {
    for (let m = 1; m < 64 * 999 * scale; m += 997) {
      const v = m / (64 * scale);
      assert.equal(Math.trunc(Number(layoutPx(v)) * scale * 64 + 1e-9), m, `${m} LayoutUnits at scale ${scale}`);
    }
  }
  assert.equal(onLiveGrid(7027 / 192 + 0.0004, 3), 7027 / 192, 'noise of 0.08 LayoutUnit at DPR 3 is removed');
  assert.equal(onLiveGrid(36.6025, 3), 36.6025, 'a value off the grid (another engine, a scaled layer) is left alone');
});
