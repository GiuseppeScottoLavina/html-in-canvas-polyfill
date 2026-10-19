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
