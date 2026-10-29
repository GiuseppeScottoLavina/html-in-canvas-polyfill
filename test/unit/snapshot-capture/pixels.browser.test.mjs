// Pixel tests: the tile of a drawable against a hand-written reference of the state it must show (3 % / channel delta > 16 gate), each with a positive control.
import { test, assert, frames } from '/test/unit/lib/t.js';
import { mount, rasterize, reference, diffFraction, inkFraction } from './_support.mjs';

// hand written references use the same rasteriser as the tile, so they must agree almost exactly (the 3 % gate is for the screenshot oracle, oracle.driver.mjs)
const GATE = 0.002;
const ok = (got, ref, what) => {
  assert.ok(inkFraction(got) > 0.02, `${what}: the tile is blank`);
  const d = diffFraction(got, ref);
  assert.ok(d <= GATE, `${what}: ${(d * 100).toFixed(2)} % of the pixels differ`);
};
const differs = (a, b, what) => assert.ok(diffFraction(a, b) > 0.01, `positive control (${what}): the oracle must see the difference`);

const CARD = '.card{width:200px;height:80px;background:#3366cc;color:#fff;font:20px/30px sans-serif;padding:10px;box-sizing:border-box}';

test('static card at DPR 1, 1.5 and 2 equals the reference; the data url is svg, not blob', async () => {
  const m = mount('<div class="card" drawable>Hello <b>world</b></div>', { css: CARD });
  const el = m.layerEl.firstElementChild;
  for (const scale of [1, 1.5, 2]) {
    const r = m.capture(m.request(el, { scale }));
    assert.ok(r.url.startsWith('data:image/svg+xml;charset=utf-8,') && !r.url.startsWith('blob:'));
    assert.deepEqual([r.widthPx, r.heightPx], [Math.round(200 * scale), Math.round(80 * scale)]);
    assert.deepEqual(r.cropCss, { x: 0, y: 0, width: 200, height: 80 });
    assert.equal(r.complete, true);
    assert.deepEqual(r.unsupported, []);
    const got = await rasterize(r);
    got.canvas.toDataURL(); // origin-clean: throws when the canvas is tainted
    ok(got, await reference('<div class="card">Hello <b>world</b></div>', CARD, 200, 80, scale), `scale ${scale}`);
  }
});

test('positive control: another text is seen by the oracle, and a blank tile is not "equal"', async () => {
  const m = mount('<div class="card" drawable>Hello</div>', { css: CARD });
  const got = await rasterize(m.capture(m.request(m.layerEl.firstElementChild)));
  differs(got, await reference('<div class="card">Bye bye</div>', CARD, 200, 80), 'text');
  const blank = await reference('', CARD, 200, 80);
  assert.ok(inkFraction(blank) < 0.001);
});

test('ink margin: the tile covers box-shadow outside the border box and a damage crop returns exactly that part', async () => {
  const css = '.s{width:100px;height:60px;background:#fff;box-shadow:0 0 0 12px rgba(200,0,0,.8)}';
  const m = mount('<div class="s" drawable style="margin:30px"></div>', { css });
  const el = m.layerEl.firstElementChild;
  const ink = { left: 24, top: 24, right: 24, bottom: 24 };
  const full = m.capture(m.request(el, { ink }));
  assert.deepEqual(full.cropCss, { x: -24, y: -24, width: 148, height: 108 });
  const fullCtx = await rasterize(full);
  ok(fullCtx, await reference('<div style="position:absolute;left:24px;top:24px" class="s"></div>', css, 148, 108), 'with ink');
  const crop = { x: -24, y: -24, width: 60, height: 40 };
  const part = m.capture(m.request(el, { ink, rect: crop }));
  assert.deepEqual([part.widthPx, part.heightPx], [60, 40]);
  const partCtx = await rasterize(part);
  const cut = document.createElement('canvas'); cut.width = 60; cut.height = 40;
  const cutCtx = cut.getContext('2d', { willReadFrequently: true });
  cutCtx.drawImage(fullCtx.canvas, 0, 0, 60, 40, 0, 0, 60, 40);
  assert.ok(inkFraction(partCtx) > 0.3);
  assert.ok(diffFraction(partCtx, cutCtx) <= 0.005, 'a crop is the same pixels as that part of the full tile');
});

test('form state: values, checked, selected, textarea, details come from the live properties', async () => {
  const html = '<div class="f" drawable><input class="i" type="text"><input type="checkbox" class="k"><input type="radio" class="k"><select class="i"><option>one</option><option>two</option></select>'
    + '<textarea class="i" rows="2"></textarea><details><summary>More</summary>Body text</details></div>';
  const css = '.f{width:300px;height:180px;font:14px sans-serif;background:#fff}.i{display:block;width:150px;margin:4px}.k{display:inline-block}';
  const m = mount(html, { css });
  const el = m.layerEl.firstElementChild;
  const before = await rasterize(m.capture(m.request(el)));
  const q = (s) => el.querySelector(s);
  q('.i').value = 'typed value';
  q('.k').checked = true;
  q('select').selectedIndex = 1;
  q('textarea').value = 'line one\nline two';
  q('details').open = true;
  const after = await rasterize(m.capture(m.request(el)));
  const refHtml = '<div class="f"><input class="i" type="text" value="typed value"><input type="checkbox" class="k" checked><input type="radio" class="k"><select class="i"><option>one</option><option selected>two</option></select>'
    + '<textarea class="i" rows="2">line one\nline two</textarea><details open><summary>More</summary>Body text</details></div>';
  // a drawable is a formatting context (contain:layout): the first child's margin stays inside, like display:flow-root in the reference
  ok(after, await reference(refHtml, css + '.f{display:flow-root}', 300, 180), 'form state');
  differs(before, after, 'state change');
});

test('scrolled scroller shows its live offset, sticky header included', async () => {
  const rows = Array.from({ length: 12 }, (_, i) => `<div class="r" style="background:hsl(${i * 30},70%,60%)">row ${i}</div>`).join('');
  const css = '.s{width:120px;height:100px;overflow:auto;position:relative;font:12px sans-serif;scrollbar-width:none}.h{position:sticky;top:0;height:20px;background:#222;color:#fff}.r{height:20px}';
  const m = mount(`<div class="s" drawable><div class="h">head</div>${rows}</div>`, { css, layerStyle: 'width:120px' });
  const el = m.layerEl.firstElementChild;
  el.scrollTop = 0;
  const top = await rasterize(m.capture(m.request(el)));
  el.scrollTop = 130;
  assert.equal(el.scrollTop, 130);
  const got = await rasterize(m.capture(m.request(el)));
  const refHtml = `<div class="s" style="overflow:hidden"><div style="transform:translateY(-130px)"><div class="h" style="visibility:hidden">head</div>${rows}</div><div class="h" style="position:absolute;left:0;top:0;width:120px">head</div></div>`;
  ok(got, await reference(refHtml, css, 120, 100), 'scrolled');
  differs(top, got, 'scroll offset');
});

test('scroller whose ::after is taken still scrolls (real marker element)', async () => {
  const rows = Array.from({ length: 12 }, (_, i) => `<div class="r" style="background:hsl(${i * 30},70%,60%)">row ${i}</div>`).join('');
  const css = '.s{width:120px;height:100px;overflow:auto;position:relative;scrollbar-width:none}.r{height:20px}.s::after{content:"";display:block;height:0}';
  const m = mount(`<div class="s" drawable>${rows}</div>`, { css, layerStyle: 'width:120px' });
  const el = m.layerEl.firstElementChild;
  el.scrollTop = 100;
  const got = await rasterize(m.capture(m.request(el)));
  const refHtml = `<div class="s" style="overflow:hidden"><div style="transform:translateY(-100px)">${rows}</div></div>`;
  ok(got, await reference(refHtml, css, 120, 100), 'scrolled with ::after');
});

test('shells: ancestor rules, container queries, sibling combinators and :nth-child keep their live answer', async () => {
  const css = '.wrap .x{color:#c00;font:16px sans-serif}.a+.t{border:4px solid #080}.t:nth-child(3){padding-left:20px}.t:last-child{text-decoration:underline}'
    + '.cq{container-type:inline-size;width:300px}@container (min-width:250px){.t{background:#cfc}}';
  const html = '<div class="wrap cq"><div class="a"></div><div class="t" drawable style="width:200px;height:60px"><span class="x">Styled</span></div></div>';
  const m = mount(html, { css });
  const el = m.layerEl.querySelector('.t');
  const got = await rasterize(m.capture(m.request(el)));
  const refHtml = '<div class="t" style="width:200px;height:60px;box-sizing:content-box;background:#cfc;border:4px solid #080;padding-left:0;text-decoration:underline"><span class="x" style="color:#c00;font:16px sans-serif">Styled</span></div>';
  ok(got, await reference(refHtml, css, got.canvas.width, got.canvas.height), 'shells');
  // positive control: a 200 px wide container does not satisfy the query, and the tile must show the narrower look
  m.layerEl.querySelector('.cq').style.width = '200px';
  const narrow = await rasterize(m.capture(m.request(el)));
  assert.notEqual(narrow.getImageData(100, 30, 1, 1).data.join(), got.getImageData(100, 30, 1, 1).data.join(), 'container width must change the result');
});

test('ancestors do not leak their look: filter, opacity, background, border and clipping of a wrapper are not in the snapshot', async () => {
  const css = '.w{filter:blur(4px);opacity:.4;background:#f00;border:5px solid #00f;overflow:hidden;width:90px;height:50px;padding:7px}.d{width:150px;height:40px;background:#0a0;color:#fff;font:14px sans-serif}';
  const m = mount('<div class="w"><div class="d" drawable>Plain</div></div>', { css });
  const got = await rasterize(m.capture(m.request(m.layerEl.querySelector('.d'))));
  assert.deepEqual([got.canvas.width, got.canvas.height], [150, 40]);
  ok(got, await reference('<div class="d">Plain</div>', css, 150, 40), 'wrapper effects');
});

test('hover, active and focus come from the interaction snapshot, not from the clone', async () => {
  const css = '.b{display:block;width:100px;height:30px;background:#ddd}.b:hover{background:#f00}.b:active{background:#0f0}.b:focus{background:#00f}.g:focus-within .b{border:3px solid #000}';
  const m = mount('<div class="g" drawable><div class="b" tabindex="0">x</div></div>', { css });
  const el = m.layerEl.firstElementChild;
  const b = el.querySelector('.b');
  const px = async (over) => (await rasterize(m.capture(m.request(el, { interaction: { hover: new Set(), active: new Set(), focus: null, focusVisible: false, caretVisible: true, ...over } })))).getImageData(50, 15, 1, 1).data;
  assert.deepEqual([...await px({})].slice(0, 3), [221, 221, 221]);
  assert.deepEqual([...await px({ hover: new Set([b, el]) })].slice(0, 3), [255, 0, 0]);
  assert.deepEqual([...await px({ active: new Set([b]) })].slice(0, 3), [0, 255, 0]);
  assert.deepEqual([...await px({ focus: b })].slice(0, 3), [0, 0, 255]);
  const ringed = await rasterize(m.capture(m.request(el, { interaction: { hover: new Set(), active: new Set(), focus: b, focusVisible: true, caretVisible: true } })));
  assert.ok(diffFraction(ringed, await rasterize(m.capture(m.request(el)))) > 0.01, 'focus ring and :focus-within are drawn');
});

test('html/body rules: custom properties and inherited text apply, box properties and backgrounds of the page do not', async () => {
  const css = ':root{--c:#0a0}body{color:#a00;font:15px monospace;background:#eee;padding:30px}.t{background:var(--c);width:120px;height:30px}';
  const m = mount('<div class="t" drawable>Mono</div>', { css });
  const got = await rasterize(m.capture(m.request(m.layerEl.firstElementChild)));
  assert.deepEqual([got.canvas.width, got.canvas.height], [120, 30]);
  assert.deepEqual([...got.getImageData(110, 25, 1, 1).data], [0, 170, 0, 255], 'var() from :root');
  const inked = await rasterize(m.capture(m.request(m.layerEl.firstElementChild, { ink: { left: 10, top: 10, right: 10, bottom: 10 } })));
  assert.equal(inked.getImageData(3, 3, 1, 1).data[3], 0, 'the body background and padding do not paint the ink margin');
});

test('frozen animation shows the live computed position', async () => {
  const css = '@keyframes mv{from{left:0}to{left:100px}}.a{position:relative;width:20px;height:20px;background:#f0f;animation:mv 1s linear -.5s 1 both paused}.d{width:140px;height:20px}';
  const m = mount('<div class="d" drawable><div class="a"></div></div>', { css });
  await frames(2);
  const got = await rasterize(m.capture(m.request(m.layerEl.firstElementChild)));
  ok(got, await reference('<div class="d"><div class="a" style="position:relative;left:50px;width:20px;height:20px;background:#f0f"></div></div>', css.replace(/@keyframes[^}]*}[^}]*}}/, ''), 140, 20), 'animation');
});

test('nested drawable is an invisible spacer: layout around it is unchanged', async () => {
  const css = '.o{width:160px;font:14px sans-serif;background:#fff}.i{height:40px;background:#f00}';
  const m = mount('<div class="o" drawable>before<div class="i" drawable>inner</div>after</div>', { css });
  const got = await rasterize(m.capture(m.request(m.layerEl.firstElementChild)));
  ok(got, await reference('<div class="o">before<div class="i" style="visibility:hidden">inner</div>after</div>', css, got.canvas.width, got.canvas.height), 'nested');
  assert.equal(got.getImageData(10, 25, 1, 1).data[0], 255, 'the spacer is invisible: its red must not show (white page behind)');
});

test('canvas, image and inline svg children are captured as bitmaps', async () => {
  const m = mount('<div class="d" drawable><canvas id="k" width="60" height="30"></canvas><svg width="40" height="30"><circle cx="20" cy="15" r="14" fill="#06c"/></svg></div>', { css: '.d{width:140px;height:40px;font-size:0}' });
  const k = m.layerEl.querySelector('#k');
  const x = k.getContext('2d'); x.fillStyle = '#f80'; x.fillRect(0, 0, 60, 30);
  const got = await rasterize(m.capture(m.request(m.layerEl.firstElementChild)));
  assert.deepEqual([...got.getImageData(10, 10, 1, 1).data], [255, 136, 0, 255], 'canvas bitmap');
  assert.deepEqual([...got.getImageData(80, 15, 1, 1).data].slice(0, 3), [0, 102, 204], 'inline svg');
});

test('same-origin image is fetched once, inlined as data url, and the tile completes', async () => {
  const m = mount('<div class="d" drawable><img src="/test/unit/snapshot-capture/assets/red.svg" width="40" height="20"></div>', { css: '.d{width:60px;height:30px}' });
  const el = m.layerEl.firstElementChild;
  const first = m.capture(m.request(el));
  assert.equal(first.complete, false, 'the first capture cannot have the image yet');
  await m.resources.load(new URL('/test/unit/snapshot-capture/assets/red.svg', location.href).href, 'svg');
  const second = m.capture(m.request(el));
  assert.equal(second.complete, true);
  assert.ok(!decodeURIComponent(second.url).includes('/assets/red.svg'), 'no external url may remain in the image');
  const got = await rasterize(second);
  assert.deepEqual([...got.getImageData(10, 10, 1, 1).data], [224, 0, 0, 255]);
});

test('damage pruning is exact inside the crop and cuts the markup', async () => {
  const cards = Array.from({ length: 60 }, (_, i) => `<div class="c"><span>Card ${i}</span><button>go</button></div>`).join('');
  const css = '.l{width:200px;font:12px sans-serif}.c{height:30px;border-bottom:1px solid #ccc;background:#fafafa;display:flex;justify-content:space-between}';
  const m = mount(`<div class="l" drawable>${cards}</div>`, { css, height: 2000 });
  const el = m.layerEl.firstElementChild;
  const rect = { x: 0, y: 0, width: 200, height: 70 };
  const full = m.capture(m.request(el, { rect }));
  const pruned = m.capture(m.request(el, { rect, prune: true }));
  const cardsIn = (r) => (decodeURIComponent(r.url).match(/Card \d+/g) ?? []).length;
  assert.equal(cardsIn(full), 60);
  assert.ok(cardsIn(pruned) <= 4, `pruned tile keeps ${cardsIn(pruned)} cards`);
  assert.ok(pruned.url.length < full.url.length, `pruned ${pruned.url.length} vs full ${full.url.length}: runs of spacers are merged`);
  assert.equal(pruned.nodes, full.nodes, 'nodes report what the full clone stands for');
  assert.ok(diffFraction(await rasterize(pruned), await rasterize(full)) <= 0.003, 'pruned tile equals the full tile');
  // positive control: a spacer where content must be differs from the content
  const farRect = { x: 0, y: 900, width: 200, height: 70 };
  const farFull = await rasterize(m.capture(m.request(el, { rect: farRect })));
  const farPruned = await rasterize(m.capture(m.request(el, { rect, prune: true })));
  assert.ok(inkFraction(farFull) > 0.5 && diffFraction(farFull, farPruned) > 0.01);
});

// A large drawable whose trailing inline cells lie below a pruned tile: the clone leaves them out (truncation) and the tile stays exact; the conditions under which the
// kept lines could lay out differently keep every cell.
const CELLS = (n) => Array.from({ length: n }, (_, i) => `<span>cell ${i} </span>`).join('');
const TRUNC_CSS = '.d{width:300px;font:12px/16px sans-serif;color:#222}.h{height:60px;background:#cde}.f{width:100%}';
/** the declaration a cut container carries in the clone (clone.js truncation) */
const PINNED = /min-height: ?[1-9][\d.]*px ?!important/;

test('a pruned tile leaves out the trailing inline cells below it, reports the full node count and equals the full tile', async () => {
  const m = mount(`<div class="d" drawable><div class="h">head</div><div class="f">${CELLS(300)}</div></div>`, { css: TRUNC_CSS, height: 2000 });
  const el = m.layerEl.firstElementChild;
  const rect = { x: 0, y: 0, width: 300, height: 90 };
  const full = m.capture(m.request(el, { rect }));
  const pruned = m.capture(m.request(el, { rect, prune: true }));
  const cellsIn = (r) => (decodeURIComponent(r.url).match(/cell \d+/g) ?? []).length;
  assert.equal(cellsIn(full), 300, 'below the soft node budget the unpruned tile has every cell');
  assert.ok(cellsIn(pruned) > 0 && cellsIn(pruned) < 120, `pruned tile keeps ${cellsIn(pruned)} of 300 cells`);
  assert.equal(pruned.nodes, full.nodes, 'nodes report what the full clone stands for');
  const got = await rasterize(pruned);
  assert.ok(inkFraction(got) > 0.05, 'the tile shows the head and the first lines of cells');
  assert.ok(diffFraction(got, await rasterize(full)) <= 0.002, 'pruned tile equals the full tile');
  assert.ok(PINNED.test(decodeURIComponent(pruned.url)) && !PINNED.test(decodeURIComponent(full.url)), 'the cut container keeps its live height');
  // positive control: the cells inside the tile are visible, so a cut inside it would be seen
  const none = mount(`<div class="d" drawable><div class="h">head</div><div class="f">${CELLS(300)}</div></div>`, { css: TRUNC_CSS + '.f span{color:transparent}', height: 2000 });
  differs(await rasterize(none.capture(none.request(none.layerEl.firstElementChild, { rect }))), got, 'no visible cells');
});

test('no truncation where the kept lines could change: justified text, ::after content, columns, a reversed list, a :has() rule; each tile stays exact', async () => {
  const cases = {
    justify: ['.f{text-align:justify}', 'div'],
    after: ['.f::after{content:"end"}', 'div'],
    columns: ['.f{columns:2}', 'div'],
    reversed: ['', 'ol'],
    has: ['.d:has(.f){outline:0}', 'div'],
  };
  for (const [name, [css, tag]] of Object.entries(cases)) {
    const m = mount(`<div class="d" drawable><div class="h">head</div><${tag} class="f"${tag === 'ol' ? ' reversed' : ''}>${tag === 'ol' ? Array.from({ length: 60 }, (_, i) => `<li>item ${i}</li>`).join('') : CELLS(300)}</${tag}></div>`, { css: TRUNC_CSS + css, height: 2000 });
    const el = m.layerEl.firstElementChild;
    const rect = { x: 0, y: 0, width: 300, height: 90 };
    const full = m.capture(m.request(el, { rect }));
    const pruned = m.capture(m.request(el, { rect, prune: true }));
    assert.ok(!PINNED.test(decodeURIComponent(pruned.url)), `${name}: no container was cut`);
    assert.ok(diffFraction(await rasterize(pruned), await rasterize(full)) <= 0.002, `${name}: pruned tile equals the full tile`);
  }
});

test('list items pruned to stand-ins still count: the items after them keep their numbers (ordered and reversed lists)', async () => {
  const css = '.d{width:300px;font:14px/20px sans-serif;color:#222}';
  for (const reversed of [false, true]) {
    const m = mount(`<div class="d" drawable><ol${reversed ? ' reversed' : ''}>${Array.from({ length: 80 }, (_, i) => `<li>item ${i}</li>`).join('')}</ol></div>`, { css, height: 2000 });
    const el = m.layerEl.firstElementChild;
    const rect = { x: 0, y: 800, width: 300, height: 80 };
    const full = await rasterize(m.capture(m.request(el, { rect })));
    const prunedResult = m.capture(m.request(el, { rect, prune: true }));
    assert.ok((decodeURIComponent(prunedResult.url).match(/data-hic-sp/g) ?? []).length > 20, 'the items far from the tile are stand-ins');
    assert.ok(diffFraction(await rasterize(prunedResult), full) <= 0.002, `${reversed ? 'reversed' : 'ordered'} list: the numbers in the tile are the full tile's`);
    // positive control: numbers shifted by one are more than the equality tolerance above
    const later = mount(`<div class="d" drawable><ol${reversed ? ' reversed' : ''} start="${reversed ? 81 : 2}">${Array.from({ length: 80 }, (_, i) => `<li>item ${i}</li>`).join('')}</ol></div>`, { css, height: 2000 });
    const shifted = diffFraction(await rasterize(later.capture(later.request(later.layerEl.firstElementChild, { rect }))), full);
    assert.ok(shifted > 0.002, `positive control (numbering): ${shifted} of the pixels differ`);
  }
});

test('long scrollers are cut to their window and stay exact', async () => {
  const rows = Array.from({ length: 300 }, (_, i) => `<div class="r">row ${i}</div>`).join('');
  const css = '.s{width:120px;height:100px;overflow:auto;position:relative;scrollbar-width:none;font:12px sans-serif}.r{height:20px;border-bottom:1px solid #aaa}';
  const m = mount(`<div class="s" drawable>${rows}</div>`, { css, layerStyle: 'width:120px;height:100px' });
  const el = m.layerEl.firstElementChild;
  el.scrollTop = 2000;
  const small = m.capture(m.request(el));
  assert.ok(small.url.length < 60_000, `window pruning keeps ${small.url.length} chars`);
  const refRows = rows;
  ok(await rasterize(small), await reference(`<div class="s" style="overflow:hidden"><div style="transform:translateY(-2000px)">${refRows}</div></div>`, css, 120, 100), 'long list');
});

test('a scrolled textarea shows its live scroll offset (div stand-in with the same box)', async () => {
  const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  const css = '.d{width:200px;height:100px}textarea{display:block;box-sizing:border-box;width:200px;height:100px;font:14px/20px sans-serif;padding:4px;border:1px solid #888;resize:none;overflow:auto;scrollbar-width:none}';
  const m = mount(`<div class="d" drawable><textarea>${text}</textarea></div>`, { css });
  const ta = m.layerEl.querySelector('textarea');
  const top = await rasterize(m.capture(m.request(m.layerEl.firstElementChild)));
  ta.scrollTop = 200;
  const got = await rasterize(m.capture(m.request(m.layerEl.firstElementChild)));
  differs(top, got, 'textarea scroll');
  const refText = text.split('\n').slice(10).join('\n');
  const ref = await reference(`<div class="d"><textarea>${refText}</textarea></div>`, css, 200, 100);
  ok(got, ref, 'scrolled textarea');
});

test('a crop at DPR 2 is the same pixels as that part of the full tile', async () => {
  const css = '.s{width:100px;height:60px;background:linear-gradient(90deg,#f00,#00f);color:#fff;font:14px sans-serif}';
  const m = mount('<div class="s" drawable>gradient text</div>', { css });
  const el = m.layerEl.firstElementChild;
  const full = await rasterize(m.capture(m.request(el, { scale: 2 })));
  const part = m.capture(m.request(el, { scale: 2, rect: { x: 30, y: 10, width: 40, height: 20 } }));
  assert.deepEqual([part.widthPx, part.heightPx], [80, 40]);
  const cut = document.createElement('canvas'); cut.width = 80; cut.height = 40;
  const cutCtx = cut.getContext('2d', { willReadFrequently: true });
  cutCtx.drawImage(full.canvas, 60, 20, 80, 40, 0, 0, 80, 40);
  assert.ok(diffFraction(await rasterize(part), cutCtx) <= 0.002);
});

test('above the soft node budget a partial tile is pruned by itself and reports the full node count', async () => {
  const cards = Array.from({ length: 40 }, (_, i) => `<div class="c"><b>Card ${i}</b><i>x</i></div>`).join('');
  const m = mount(`<div class="l" drawable style="width:200px">${cards}</div>`, { css: '.c{height:30px}', height: 2000, envOpts: { nodeBudget: { soft: 20, hard: 3000, absolute: 20000 } } });
  const el = m.layerEl.firstElementChild;
  const r = m.capture(m.request(el, { rect: { x: 0, y: 0, width: 200, height: 60 } }));
  assert.ok((decodeURIComponent(r.url).match(/Card \d+/g) ?? []).length <= 4);
  assert.ok(r.nodes >= 120);
  const whole = m.capture(m.request(el));
  assert.ok((decodeURIComponent(whole.url).match(/Card \d+/g) ?? []).length >= 3, 'a full tile has nothing outside its crop to cut');
});

test('unitless line-height is inherited as a number: a larger descendant keeps its own line height', async () => {
  const css = 'body{font:15px/1.4 sans-serif}.big{font-size:30px;width:160px;color:#036}';
  const m = mount('<div class="big" drawable>Aa<br>Bb</div>', { css });
  const got = await rasterize(m.capture(m.request(m.layerEl.firstElementChild)));
  ok(got, await reference('<div style="font:15px/1.4 sans-serif"><div class="big">Aa<br>Bb</div></div>', css.replace('body{', '.x{'), got.canvas.width, got.canvas.height), 'line-height');
});

test('display:contents shells: padding, margin and border of plain ancestors do not move or paint into the tile', async () => {
  const css = '.w{padding:20px;margin:15px;border:5px solid #f00;background:#ff0}.d{width:80px;height:30px;background:#0a0}';
  const m = mount('<div class="w"><div class="d" drawable>x</div></div>', { css });
  const got = await rasterize(m.capture(m.request(m.layerEl.querySelector('.d'))));
  ok(got, await reference('<div class="d">x</div>', css, 80, 30), 'plain ancestor');
  const inked = await rasterize(m.capture(m.request(m.layerEl.querySelector('.d'), { ink: { left: 8, top: 8, right: 8, bottom: 8 } })));
  assert.equal(inked.getImageData(2, 2, 1, 1).data[3] + inked.getImageData(50, 42, 1, 1).data[3], 0, 'the ancestor background must not show in the ink margin');
});

// ---------------------------------------------------------------------------------------------- WPT regressions (2026-10 conformance run)

test('filter: url(#id) naming an SVG <filter> outside the drawable and inside the canvas is applied (WPT css-filter-reference-on-div); one outside the canvas is not (Canary 159, WPT privacy/filtered-outside-subtree-ignored); positive control: without the filter the tile is red', async () => {
  const css = '.d{width:60px;height:40px;background:red;filter:url(#hic-green)} .e{width:60px;height:40px;background:red;filter:url(#hic-green-out)}';
  const m = mount('<div class="d" drawable></div><div class="e" drawable></div>', { css });
  m.layerEl.insertAdjacentHTML('beforeend', '<svg width="1" height="1"><filter id="hic-green"><feFlood flood-color="green"/></filter></svg>');
  m.host.insertAdjacentHTML('beforeend', '<svg width="1" height="1"><filter id="hic-green-out"><feFlood flood-color="green"/></filter></svg>');
  const got = await rasterize(m.capture(m.request(m.layerEl.firstElementChild)));
  const px = got.getImageData(30, 20, 1, 1).data;
  assert.deepEqual([px[0], px[1], px[2], px[3]], [0, 128, 0, 255], 'the flood replaces the red box');
  const out = (await rasterize(m.capture(m.request(m.layerEl.children[1])))).getImageData(30, 20, 1, 1).data;
  assert.deepEqual([out[0], out[1], out[2], out[3]], [255, 0, 0, 255], 'the filter outside the canvas is ignored: drawn unfiltered');
  const plain = mount('<div class="p" drawable></div>', { css: '.p{width:60px;height:40px;background:red}' });
  const red = (await rasterize(plain.capture(plain.request(plain.layerEl.firstElementChild)))).getImageData(30, 20, 1, 1).data;
  assert.deepEqual([red[0], red[1], red[2]], [255, 0, 0], 'positive control');
});

test('a filter whose feImage is a same-origin URL that does not load keeps applying with an empty image (the platform does the same; measured on the native oracle)', async () => {
  const m = mount('<div class="d" drawable></div>', { css: '.d{width:40px;height:40px;background:red;filter:url(#hic-img)}' });
  m.layerEl.insertAdjacentHTML('beforeend', '<svg width="1" height="1"><filter id="hic-img"><feImage href="/test/unit/snapshot-capture/assets/missing.png" result="i"/><feFlood flood-color="blue"/></filter></svg>');
  const el = m.layerEl.firstElementChild;
  m.capture(m.request(el));
  await new Promise((ok) => setTimeout(ok, 400));
  const r = m.capture(m.request(el));
  const svg = decodeURIComponent(r.url.slice(r.url.indexOf(',') + 1));
  assert.ok(svg.includes('<filter') && !svg.includes('missing.png'));
  const px = (await rasterize(r)).getImageData(20, 20, 1, 1).data;
  assert.deepEqual([px[0], px[1], px[2]], [0, 0, 255]);
});

test('a filter whose feImage cannot be read (cross-origin without CORS, or a URL that does not parse) is not applied at all, as the platform ignores it (WPT privacy/filtered-div-*-ignored); positive control: a readable one applies', async () => {
  const css = '.d{width:40px;height:40px;background:rgb(0,128,0)} #a{filter:url(#hic-x)} #b{filter:url(#hic-bad) blur(2px)} #c{filter:url(#hic-ok)}';
  const m = mount('<div id="a" class="d" drawable></div><div id="b" class="d" drawable></div><div id="c" class="d" drawable></div>', { css });
  m.layerEl.insertAdjacentHTML('beforeend', '<svg width="1" height="1"><filter id="hic-x"><feImage href="http://127.0.0.1:9/x.png"/></filter>'
    + '<filter id="hic-bad"><feImage href="https://127.0.0.1:9x.png" result="o"/><feGaussianBlur in="o" stdDeviation="2"/></filter>'
    + '<filter id="hic-ok"><feImage href="/test/unit/snapshot-capture/assets/red.svg" x="0" y="0" width="40" height="40" preserveAspectRatio="none"/></filter></svg>');
  const [a, b, c] = m.layerEl.querySelectorAll('[drawable]');
  for (const el of [a, b, c]) m.capture(m.request(el));
  await new Promise((ok) => setTimeout(ok, 400));
  const center = async (el) => { const r = m.capture(m.request(el)); return { r, px: Array.from((await rasterize(r)).getImageData(20, 20, 1, 1).data) }; };
  const ra = await center(a);
  assert.deepEqual(ra.px, [0, 128, 0, 255], 'cross-origin: drawn unfiltered');
  assert.ok(ra.r.unsupported.some((e) => e.feature === 'cross-origin-resource'), 'reported');
  assert.ok(!decodeURIComponent(ra.r.url).includes('127.0.0.1:9'), 'never the external URL');
  const rb = await center(b);
  assert.deepEqual(rb.px, [0, 128, 0, 255], 'unparseable URL: the url() filter is ignored, the blur still runs (centre unchanged)');
  assert.ok(!rb.r.unsupported.some((e) => e.feature === 'capture-error'), 'the capture does not fail');
  const rc = await center(c);
  assert.deepEqual(rc.px, [224, 0, 0, 255], 'positive control: the same-origin image replaces the box');
});

test('a feImage of a filter INSIDE the drawable (an <svg drawable>) is inlined when same-origin and drops its filter when cross-origin (WPT privacy/filtered-svg-ref-svg-feimage-ignored, svg-pattern-with-feImage)', async () => {
  const m = mount('<svg drawable width="40" height="80" style="display:block"><filter id="hic-s"><feImage href="/test/unit/snapshot-capture/assets/red.svg" x="0" y="0" width="40" height="40" preserveAspectRatio="none"/></filter>'
    + '<filter id="hic-c"><feImage href="http://127.0.0.1:9/x.png"/></filter><rect width="40" height="40" fill="rgb(0,128,0)" filter="url(#hic-s)"/><rect y="40" width="40" height="40" fill="rgb(0,128,0)" filter="url(#hic-c)"/></svg>');
  const el = m.layerEl.firstElementChild;
  m.capture(m.request(el));
  await new Promise((ok) => setTimeout(ok, 400));
  const r = m.capture(m.request(el));
  const x = await rasterize(r);
  const px = (a, b) => Array.from(x.getImageData(a, b, 1, 1).data);
  assert.deepEqual(px(20, 20), [224, 0, 0, 255], 'same-origin feImage drawn');
  assert.deepEqual(px(20, 60), [0, 128, 0, 255], 'cross-origin: the rect is drawn unfiltered');
});

test('a mask outside the drawable masks its element away (the platform does not draw it, WPT privacy/svg/svg-mask-*); a mask inside the drawable applies; an id that exists nowhere is ignored', async () => {
  const outside = document.createElement('div');
  outside.innerHTML = '<svg width="0" height="0"><mask id="hic-out-mask"><rect width="100" height="100" fill="white"/></mask></svg>';
  document.body.appendChild(outside);
  const m = mount('<svg drawable width="40" height="120" style="display:block"><mask id="hic-in-mask"><rect width="40" height="20" fill="white"/></mask>'
    + '<rect width="40" height="40" fill="rgb(0,128,0)" mask="url(#hic-in-mask)"/><rect y="40" width="40" height="40" fill="rgb(0,128,0)" mask="url(#hic-out-mask)"/><rect y="80" width="40" height="40" fill="rgb(0,128,0)" mask="url(#hic-nowhere)"/></svg>'
    + '<div drawable style="width:40px;height:40px;background:rgb(0,128,0);mask:url(#hic-out-mask)"></div>');
  const [svgEl, div] = m.layerEl.children;
  const x = await rasterize(m.capture(m.request(svgEl)));
  outside.remove();
  const a = (p, q) => x.getImageData(p, q, 1, 1).data[3];
  assert.equal(a(20, 10), 255, 'inside mask: the white half shows');
  assert.equal(a(20, 30), 0, 'inside mask: the other half is masked');
  assert.equal(a(20, 60), 0, 'outside mask: not drawn');
  assert.equal(a(20, 100), 255, 'a mask that exists nowhere is ignored, as in the page');
  document.body.appendChild(outside);
  const y = await rasterize(m.capture(m.request(div)));
  outside.remove();
  assert.equal(y.getImageData(20, 20, 1, 1).data[3], 0, 'an HTML element masked by an outside mask is not drawn either');
});

test('a mask-image that cannot be read masks its element away (CSS Masking: an image that cannot be displayed is a transparent black layer; read-back-allowed rendering, WPT privacy/box-mask-*, fragment-mask-*); positive control: a same-origin mask image applies', async () => {
  const cross = `http://localhost:${location.port}/test/unit/snapshot-capture/assets/red.svg?mask=1`;
  const css = `.d{width:40px;height:40px;background:rgb(0,128,0)} #a{mask-image:url(/test/unit/snapshot-capture/assets/red.svg)} #b{mask-image:url(${cross})} #c{-webkit-mask:url(${cross}) no-repeat}`;
  const m = mount('<div id="a" class="d" drawable></div><div id="b" class="d" drawable></div><div id="c" class="d" drawable><span>x</span></div>', { css });
  const els = Array.from(m.layerEl.children);
  for (const el of els) m.capture(m.request(el));
  const loading = m.capture(m.request(els[0]));
  assert.equal((await rasterize(loading)).getImageData(20, 20, 1, 1).data[3], 0, 'while the mask image loads the element is masked away, never drawn unmasked');
  await new Promise((ok) => setTimeout(ok, 400));
  const alpha = async (el) => { const r = m.capture(m.request(el)); return { r, a: (await rasterize(r)).getImageData(20, 20, 1, 1).data[3] }; };
  const a = await alpha(els[0]);
  assert.equal(a.a, 255, 'positive control: the same-origin mask image is drawn and lets the element through');
  const b = await alpha(els[1]);
  assert.equal(b.a, 0, 'cross-origin mask image: the element is not drawn');
  assert.ok(m.reported.some((e) => e.feature === 'cross-origin-resource' && e.path === cross), 'reported');
  assert.ok(!decodeURIComponent(b.r.url).includes('localhost:'), 'never the external URL');
  assert.equal((await alpha(els[2])).a, 0, 'the -webkit-mask shorthand too');
});

test('a mask-image that cannot be read on SVG CONTENT is ignored (drawn unmasked, as Chromium\'s read-back-allowed rendering does, WPT privacy/svg/svg-mask-on-svg-content-ignored), on the outer <svg> box it masks the box away; positive control: a readable mask applies to SVG content', async () => {
  const cross = `http://localhost:${location.port}/test/unit/snapshot-capture/assets/red.svg?svgmask=1`;
  const half = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect y="20" width="40" height="20"/></svg>')}`;
  const m = mount(`<svg drawable width="40" height="80" style="display:block"><rect width="40" height="40" fill="rgb(0,0,255)" style="mask-image:url('${half}')"/>`
    + `<rect y="40" width="40" height="40" fill="rgb(0,0,255)" style="mask-image:url('${cross}')"/></svg>`
    + `<svg drawable width="40" height="40" style="display:block;background:rgb(0,128,0);mask-image:url('${cross}')"><rect width="40" height="40" fill="rgb(0,0,255)"/></svg>`);
  const [content, box] = Array.from(m.layerEl.children);
  m.capture(m.request(content));
  m.capture(m.request(box));
  await new Promise((ok) => setTimeout(ok, 400));
  const x = await rasterize(m.capture(m.request(content)));
  const px = (a, b) => Array.from(x.getImageData(a, b, 1, 1).data);
  assert.equal(px(20, 10)[3], 0, 'positive control: the readable mask hides the top half');
  assert.deepEqual(px(20, 30), [0, 0, 255, 255], 'positive control: and shows the bottom half');
  assert.deepEqual(px(20, 50), [0, 0, 255, 255], 'cross-origin mask on SVG content: ignored, the rect is drawn unmasked');
  assert.deepEqual(px(20, 70), [0, 0, 255, 255]);
  const y = await rasterize(m.capture(m.request(box)));
  assert.equal(y.getImageData(20, 20, 1, 1).data[3], 0, 'the outer <svg> is a CSS box: masked away');
});

test('a loaded video that never played shows its poster (HTML show poster flag, WPT privacy/video-ignored); positive control: once played, its frame; a cross-origin video draws nothing, poster included (read-back-allowed rendering)', async () => {
  const poster = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="rgb(255,255,0)"/></svg>')}`;
  const video = (src) => `<div drawable style="width:40px;height:40px"><video muted preload="auto" width="40" height="40" style="display:block;object-fit:fill" poster="${poster}" src="${src}"></video></div>`;
  const m = mount(video('/test/vendor/wpt/media/rgb100.webm') + video(`http://localhost:${location.port}/test/vendor/wpt/media/rgb100.webm?corp=cross-origin`));
  const [same, cross] = Array.from(m.layerEl.children);
  const vids = [same, cross].map((d) => /** @type {HTMLVideoElement} */ (d.querySelector('video')));
  for (let i = 0; i < 400 && vids.some((v) => v.readyState < 2); i++) await new Promise((ok) => setTimeout(ok, 10));
  assert.ok(vids.every((v) => v.readyState >= 2), `both videos loaded their first frame: ${vids.map((v) => `${v.readyState}/${v.networkState}/${v.error?.code ?? '-'}`)}`);
  const centre = async (el) => Array.from((await rasterize(m.capture(m.request(el)))).getImageData(20, 20, 1, 1).data);
  assert.deepEqual(await centre(same), [255, 255, 0, 255], 'never played: the poster, not the first (red) frame');
  assert.equal((await centre(cross))[3], 0, 'cross-origin media data: the box is invisible, its same-origin poster too');
  assert.ok(m.reported.some((e) => e.feature === 'cross-origin-resource'), 'reported');
  // the test server answers without byte ranges, so the video cannot seek: it plays for a moment instead (the show poster flag is unset when playback starts)
  await vids[0].play();
  await new Promise((ok) => setTimeout(ok, 250));
  vids[0].pause();
  assert.ok(vids[0].played.length > 0 && vids[0].readyState >= 2, 'played');
  const [r, g, b] = await centre(same);
  assert.ok(!(r > 200 && g > 200 && b < 80), `positive control: once it played, a frame is drawn instead of the poster, got ${r},${g},${b}`);
});

test('a loaded video whose poster fails to load (404, not an image) draws nothing until it plays, not its first frame (measured in the page and on the native oracle, Chrome Canary 158); positive controls: without a poster attribute the first frame is drawn, and once played the frame', async () => {
  const video = (poster) => `<div drawable style="width:40px;height:40px"><video muted preload="auto" width="40" height="40" style="display:block;object-fit:fill" ${poster} src="/test/vendor/wpt/media/rgb100.webm"></video></div>`;
  const m = mount(video('poster="/test/unit/snapshot-capture/assets/missing-poster.png"') + video('poster="/test/vendor/wpt/media/white.webm"') + video(''));
  const boxes = Array.from(m.layerEl.children);
  const vids = boxes.map((d) => /** @type {HTMLVideoElement} */ (d.querySelector('video')));
  for (let i = 0; i < 400 && vids.some((v) => v.readyState < 2); i++) await new Promise((ok) => setTimeout(ok, 10));
  assert.ok(vids.every((v) => v.readyState >= 2), 'the videos loaded their first frame');
  const centre = async (el) => {
    m.capture(m.request(el));
    await new Promise((ok) => setTimeout(ok, 150));
    return Array.from((await rasterize(m.capture(m.request(el)))).getImageData(20, 20, 1, 1).data);
  };
  const [r, g, b] = await centre(boxes[2]);
  assert.ok(r > 200 && g < 40 && b < 40, `positive control: no poster attribute, the first (red) frame, got ${r},${g},${b}`);
  assert.equal((await centre(boxes[0]))[3], 0, 'a poster that does not load (404): nothing');
  assert.equal((await centre(boxes[1]))[3], 0, 'a poster that is not an image: nothing');
  await vids[0].play();
  await new Promise((ok) => setTimeout(ok, 250));
  vids[0].pause();
  assert.ok((await centre(boxes[0]))[3] > 0, 'positive control: once it played, its frame is drawn');
});

test('a drawable with its own CSS transform keeps it in the snapshot (WPT css-transform-on-div): the rotated square reaches outside the corners of its border box', async () => {
  const m = mount('<div class="d" drawable></div>', { css: '.d{width:60px;height:60px;background:#080;transform:rotate(45deg)}' });
  // the fake layer measures with getBoundingClientRect, which sees the rotation: the real layer reports the layout size
  m.layer.borderBoxSize = () => ({ width: 60, height: 60 });
  m.layer.borderBoxRectInLayer = () => ({ x: 0, y: 0, width: 60, height: 60 });
  const r = m.capture(m.request(m.layerEl.firstElementChild, { ink: { left: 30, top: 30, right: 30, bottom: 30 } }));
  const x = await rasterize(r);
  const at = (px, py) => x.getImageData(px, py, 1, 1).data[3];
  assert.equal(at(30 + 30, 30 + 30), 255, 'centre');
  assert.equal(at(30 + 1, 30 + 1), 0, 'the corner of the border box is empty after the rotation');
  assert.equal(at(30 + 30, 30 - 10), 255, 'a point above the box top edge, reached by the rotated corner (the vertex is 12.4 px above it)');
});

test('the drawable root does not match `div > div` (its clone parent is not a div): WPT css-blend-mode painted the nested rule onto the drawable', async () => {
  const m = mount('<div class="d" drawable>x</div>', { css: 'div{width:30px;height:20px;background:#c00} div > div{background:#0c0;margin:5px}' });
  const el = m.layerEl.firstElementChild;
  const r = m.capture(m.request(el));
  const svg = decodeURIComponent(r.url.slice(r.url.indexOf(',') + 1));
  assert.ok(svg.includes('<hic-canvas') && !/<div[^>]*data-hic-root/.test(svg), 'the canvas stand-in is a custom element');
  const px = (await rasterize(r)).getImageData(10, 10, 1, 1).data;
  assert.deepEqual([px[0], px[1], px[2]], [204, 0, 0], 'the drawable keeps the rule written for `div`, not the one for `div > div`');
});

test('a same-origin feImage of a referenced filter is inlined as a data: URL once loaded (first capture is incomplete), WPT privacy/filtered-div-ref-svg-feimage-ignored', async () => {
  const m = mount('<div class="d" drawable></div>', { css: '.d{width:40px;height:40px;filter:url(#hic-self)}' });
  m.layerEl.insertAdjacentHTML('beforeend', '<svg width="1" height="1"><filter id="hic-self"><feImage href="/test/unit/snapshot-capture/assets/red.svg" width="40" height="40"/></filter></svg>');
  const el = m.layerEl.firstElementChild;
  const first = m.capture(m.request(el));
  assert.equal(first.complete, false, 'the filter image is still loading');
  await new Promise((ok) => setTimeout(ok, 400));
  const second = m.capture(m.request(el));
  const svg = decodeURIComponent(second.url.slice(second.url.indexOf(',') + 1));
  assert.equal(second.complete, true);
  assert.ok(/<feImage[^>]*href="data:image\/svg\+xml/.test(svg) && !svg.includes('/test/unit/snapshot-capture/assets'));
});

test('an SVG <image> that cannot be read draws nothing (no broken-image icon) and is reported; a same-origin one is drawn (WPT privacy/svg/svg-images-ignored)', async () => {
  const m = mount('<svg drawable width="40" height="80" style="display:block"><rect width="40" height="80" fill="rgb(0,128,0)"/><image href="/test/unit/snapshot-capture/assets/red.svg" width="40" height="40" preserveAspectRatio="none"/>'
    + `<image y="40" href="http://localhost:${location.port}/test/unit/snapshot-capture/assets/red.svg?iso=0" width="40" height="40" preserveAspectRatio="none"/></svg>`);
  const el = m.layerEl.firstElementChild;
  m.capture(m.request(el));
  await new Promise((ok) => setTimeout(ok, 400));
  const r = m.capture(m.request(el));
  assert.deepEqual(r.unsupported.map((e) => e.feature), ['cross-origin-resource']);
  const x = await rasterize(r);
  const px = (a, b) => Array.from(x.getImageData(a, b, 1, 1).data);
  assert.deepEqual(px(20, 20), [224, 0, 0, 255], 'same-origin image drawn');
  for (const [a, b] of [[20, 60], [3, 43], [36, 77]]) assert.deepEqual(px(a, b), [0, 128, 0, 255], `cross-origin image: nothing at ${a},${b}`);
});

test('a date / time field keeps its live border box in the snapshot (its intrinsic width, the text of its fields, came out 1-2 device px off at DPR 1.25-2 and moved the controls after it); control: a text field is not pinned', () => {
  const m = mount('<div drawable style="width:300px;height:40px"><input type="time" id="t" value="14:35"><input type="date" id="d" value="2026-10-08"><input id="x" value="text"></div>');
  const r = m.capture(m.request(m.layerEl.firstElementChild));
  const svg = decodeURIComponent(r.url.slice(r.url.indexOf(',') + 1));
  const tag = (id) => (new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(svg) ?? [''])[0];
  for (const id of ['t', 'd']) {
    const el = /** @type {HTMLElement} */ (m.layerEl.querySelector(`#${id}`));
    const cs = getComputedStyle(el), n = (p) => parseFloat(cs.getPropertyValue(p)) || 0;
    const w = cs.boxSizing === 'border-box' ? n('width') : n('width') + n('padding-left') + n('padding-right') + n('border-left-width') + n('border-right-width');
    assert.ok(w > 0 && tag(id).replace(/\s+/g, '').includes(`;width:${w}px!important`), `${id}: the live border box ${w} px in ${tag(id)}`);
  }
  assert.ok(!/box-sizing:\s*border-box\s*!important/.test(tag('x')), `control: ${tag('x')}`);
});
