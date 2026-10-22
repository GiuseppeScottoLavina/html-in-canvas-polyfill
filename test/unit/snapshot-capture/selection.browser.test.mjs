// Selection painting: the background and the glyph colour of a selection drawn into the tile, per platform model, for text fields and page text.
// Native reference (measured with compositor screenshots, Chrome 155): on Linux the selected glyphs are HighlightText (#ffffff) over Highlight composited on the
// backdrop, on dark and on light controls; on macOS they keep their own colour. An author ::selection rule sets both colours on every platform.
import { test, assert } from '/test/unit/lib/t.js';
import { mount, rasterize, diffFraction } from './_support.mjs';
import { inputSelectionRect } from '/src/snapshot/capture/caret-overlay.js';
import { createSelectionPainter } from '/src/snapshot/capture/selection-paint.js';

const css = '.d{display:flow-root;width:260px;height:80px;font:16px sans-serif;background:#fff}.i{display:block;box-sizing:border-box;width:200px;height:30px;padding:2px 6px;border:2px solid #888;font:16px sans-serif;margin:4px}';
const interaction = (focus) => ({ hover: new Set(), active: new Set(), focus, focusVisible: true, caretVisible: false });

/**
 * The platform model this browser is expected to follow, read independently of src/util/engine.js: Chromium off Apple platforms paints the selection foreground.
 * Firefox and Safari keep the glyph colour in the polyfill (Firefox on Linux / Windows is not measured).
 */
function expectedModel() {
  const data = /** @type {any} */ (navigator).userAgentData;
  const chromium = !!data?.brands?.some((b) => b.brand === 'Chromium') || /Chrome\//.test(navigator.userAgent);
  const apple = data?.platform ? data.platform === 'macOS' : /Mac|iPhone|iPad/.test(navigator.platform);
  return { foreground: chromium && !apple, platform: data?.platform ?? navigator.platform };
}

/** a system colour through a canvas: [r, g, b, a] */
function system(name) {
  const c = document.createElement('canvas').getContext('2d');
  c.fillStyle = '#000';
  c.fillStyle = name;
  const v = String(c.fillStyle);
  if (v.startsWith('#')) return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)).concat(1);
  return v.match(/[\d.]+/g).map(Number);
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
const blend = (under, c) => under.map((u, k) => Math.round(u * (1 - c[3]) + c[k] * c[3]));

/** the most common colour of a rect (the background: glyph pixels are a minority) and the pixel farthest from it (a glyph core) */
function look(img, r) {
  const x0 = Math.ceil(r.x) + 1, y0 = Math.ceil(r.y) + 1, w = Math.floor(r.width) - 2, h = Math.floor(r.height) - 2;
  const d = img.getImageData(x0, y0, w, h).data;
  const n = new Map();
  for (let i = 0; i < d.length; i += 4) { const k = `${d[i]},${d[i + 1]},${d[i + 2]}`; n.set(k, (n.get(k) ?? 0) + 1); }
  const bg = [...n.entries()].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number);
  let glyph = bg, best = -1;
  for (let i = 0; i < d.length; i += 4) { const p = [d[i], d[i + 1], d[i + 2]]; const e = dist(p, bg); if (e > best) { best = e; glyph = p; } }
  return { bg, glyph };
}

/**
 * The glyph colour must be the one of the expected model and far from the other model's: applying the wrong model fails here.
 * @param {number[]} glyph @param {number[]} own @param {string} what
 */
function assertGlyph(glyph, own, what) {
  const { foreground, platform } = expectedModel();
  const highlightText = system('HighlightText').slice(0, 3);
  const want = foreground ? highlightText : own;
  const other = foreground ? own : highlightText;
  assert.ok(dist(want, other) > 120, `${what}: precondition, the two models are told apart (${want} vs ${other})`);
  assert.ok(dist(glyph, want) <= 24, `${what} on ${platform}: selected glyphs ${glyph}, expected ${want} (${foreground ? 'HighlightText' : 'their own colour'})`);
  assert.ok(dist(glyph, other) > 90, `${what} on ${platform}: selected glyphs ${glyph} follow the other platform model (${other})`);
}

// glyph colours far from black and from white: HighlightText is #000000 on macOS and #ffffff on Linux, so either wrong model is told apart
const CONTROLS = [['dark control', '#0e1626', '#f5d76e'], ['light control', '#ffffff', '#7a1020']];

for (const [name, bg, fg] of CONTROLS) {
  test(`input selection on a ${name}: background backdrop*(1-a)+Highlight*a, glyphs in the platform's selection foreground`, async () => {
    const m = mount(`<div class="d" drawable style="background:${bg}"><input class="i" value="hello world" style="background:${bg};color:${fg};border-color:${bg}"></div>`, { css });
    const input = m.layerEl.querySelector('input');
    const el = m.layerEl.firstElementChild;
    input.focus();
    input.setSelectionRange(3, 3);
    const plain = await rasterize(m.capture(m.request(el, { interaction: interaction(input) })));
    input.setSelectionRange(0, 11);
    const sel = await rasterize(m.capture(m.request(el, { interaction: interaction(input) })));
    const rect = inputSelectionRect(document, input, m.layer.frameRect(input));
    assert.ok(rect && rect.width > 60, 'selection rect');
    const got = look(sel, rect);
    const expected = blend(hex(bg), system('Highlight'));
    assert.ok(dist(got.bg, expected) <= 6, `selection background ${got.bg} expected ${expected}`);
    assert.deepEqual(look(plain, rect).bg, hex(bg), 'control: the unselected field keeps its background');
    assertGlyph(got.glyph, hex(fg), `input on a ${name}`);
  });

  test(`page text selection on a ${name}: the selected text is recoloured in the tile, the rest of the tile is unchanged`, async () => {
    const m = mount(`<div class="d" drawable style="background:${bg};color:${fg}"><p style="margin:8px">hello world static</p></div>`, { css });
    const el = m.layerEl.firstElementChild;
    const text = el.querySelector('p').firstChild;
    const plain = await rasterize(m.capture(m.request(el)));
    const range = document.createRange();
    range.setStart(text, 2);
    range.setEnd(text, 11);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    try {
      const res = m.capture(m.request(el));
      const sel = await rasterize(res);
      const er = el.getBoundingClientRect();
      const rr = range.getBoundingClientRect();
      const rect = { x: rr.left - er.left, y: rr.top - er.top, width: rr.width, height: rr.height };
      const got = look(sel, rect);
      const expected = blend(hex(bg), system('Highlight'));
      assert.ok(dist(got.bg, expected) <= 6, `selection background ${got.bg} expected ${expected}`);
      assertGlyph(got.glyph, hex(fg), `page text on a ${name}`);
      // outside the selection rectangle not one pixel moves: the wrapper changes no layout
      const mask = (x) => { const c = x.canvas; const o = document.createElement('canvas'); o.width = c.width; o.height = c.height; const g = o.getContext('2d', { willReadFrequently: true }); g.drawImage(c, 0, 0); g.clearRect(rect.x - 1, rect.y - 1, rect.width + 2, rect.height + 2); return g; };
      assert.equal(diffFraction(mask(plain), mask(sel), 2), 0, 'pixels outside the selection are those of the unselected tile');
      assert.ok(decodeURIComponent(res.url).includes('<hic-sel'), 'the selected text is wrapped in the clone');
    } finally {
      getSelection().removeAllRanges();
    }
  });
}

test('page text with line-height 2: the highlight fills the line box (the engine splits the leading, upper half rounded down), glyphs do not move', async () => {
  const m = mount('<div class="d" drawable><p style="margin:8px;line-height:2;color:#101418">hello world static</p></div>', { css });
  const el = m.layerEl.firstElementChild;
  const p = el.querySelector('p');
  const plain = await rasterize(m.capture(m.request(el)));
  const range = document.createRange();
  range.setStart(p.firstChild, 2);
  range.setEnd(p.firstChild, 11);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
  try {
    const sel = await rasterize(m.capture(m.request(el)));
    const er = el.getBoundingClientRect();
    const rr = range.getBoundingClientRect();
    const x = Math.round(rr.left - er.left + rr.width / 2);
    const want = blend([255, 255, 255], system('Highlight'));
    // the line box is 32 px from y = 8: rows 8 and 39 are highlighted, rows 7 and 40 are not
    const at = (y) => Array.from(sel.getImageData(x, y, 1, 1).data.slice(0, 3));
    for (const y of [8, 10, 37, 39]) assert.ok(dist(at(y), want) <= 6, `row ${y}: ${at(y)} expected the highlight ${want}`);
    for (const y of [6, 41]) assert.deepEqual(at(y), [255, 255, 255], `row ${y} is outside the line box`);
    // unselected glyphs at the same rows as in the plain tile (a fractional padding above the text would move them by one px)
    const ink = (img) => { const d = img.getImageData(8, 0, Math.floor(rr.left - er.left) - 8, 48).data; const rows = []; for (let y = 0; y < 48; y++) for (let k = 0; k < d.length / 4 / 48; k++) { const i = (y * (d.length / 4 / 48) + k) * 4; if (d[i] < 128) { rows.push(y); break; } } return rows.join(); };
    assert.equal(ink(sel), ink(plain));
  } finally {
    getSelection().removeAllRanges();
  }
});

test('author ::selection rules: a background alone keeps the glyph colour, a colour alone paints no Highlight, both inherit to descendants', async () => {
  const m = mount('<div class="d" drawable><input class="i" value="hello world" style="color:#101418"></div>',
    { css: `${css}.i::selection{background:rgb(255,0,255)}` });
  const input = m.layerEl.querySelector('input');
  input.focus();
  input.setSelectionRange(0, 5);
  const el = m.layerEl.firstElementChild;
  const a = look(await rasterize(m.capture(m.request(el, { interaction: interaction(input) }))), inputSelectionRect(document, input, m.layer.frameRect(input)));
  assert.deepEqual(a.bg, [255, 0, 255], 'author background');
  assert.ok(dist(a.glyph, [16, 20, 24]) <= 24, `the glyphs keep their colour over an author background (and are not hidden by it): ${a.glyph}`);

  const m2 = mount('<div class="d" drawable><p style="margin:8px;color:#101418">hello <b>world</b> static</p></div>', { css: `${css}p::selection{color:rgb(0,160,0)}` });
  const b = m2.layerEl.querySelector('b');
  const range = document.createRange();
  range.selectNodeContents(b);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
  try {
    const el2 = m2.layerEl.firstElementChild;
    const er = el2.getBoundingClientRect();
    const rr = range.getBoundingClientRect();
    const got = look(await rasterize(m2.capture(m2.request(el2))), { x: rr.left - er.left, y: rr.top - er.top, width: rr.width, height: rr.height });
    assert.deepEqual(got.bg, [255, 255, 255], 'a rule that sets only the colour paints no Highlight background');
    assert.ok(dist(got.glyph, [0, 160, 0]) <= 24, `the descendant <b> takes the inherited ::selection colour: ${got.glyph}`);
  } finally {
    getSelection().removeAllRanges();
  }
});

test('createSelectionPainter: the system colours per platform model, author rules found in the CSSOM (@media evaluated, nesting resolved)', () => {
  const host = document.createElement('div');
  host.innerHTML = '<style>@media (max-width: 1px){.never::selection{background:rgb(1,2,3)}} .nest{&::selection{background:rgb(4,5,6)}} .x ::selection{color:rgb(7,8,9)}</style>'
    + '<p class="never">a</p><p class="nest">b</p><div class="x"><span>c</span></div><p>d</p>';
  document.body.append(host);
  try {
    const [never, nest, span, plain] = [host.querySelector('.never'), host.querySelector('.nest'), host.querySelector('span'), host.querySelector('p:last-child')];
    const fg = createSelectionPainter(document, true);
    const keep = createSelectionPainter(document, false);
    const hi = system('Highlight');
    assert.equal(fg.paint(plain).foreground, `rgb(${system('HighlightText').slice(0, 3).join(', ')})`, 'selection foreground model: HighlightText');
    assert.equal(keep.paint(plain).foreground, null, 'glyph-colour model: no foreground');
    const nums = (/** @type {string} */ v) => { const n = v.match(/[\d.]+/g).map(Number); return n.length === 3 ? [...n, 1] : n; };
    assert.deepEqual(nums(fg.paint(plain).background), hi, 'the system Highlight');
    assert.equal(fg.paint(never).foreground, `rgb(${system('HighlightText').slice(0, 3).join(', ')})`, 'a rule inside a non-matching @media does not apply');
    assert.equal(keep.paint(nest).background, 'rgb(4, 5, 6)', 'nested &::selection');
    assert.equal(keep.paint(span).foreground, 'rgb(7, 8, 9)', 'descendant ::selection');
  } finally {
    host.remove();
  }
});

test('selected page text is not wrapped where a wrapper could change a selector or a box: sibling-position selectors with element siblings, :has(), flex parents', async () => {
  const cases = [
    ['b:first-child{color:rgb(200,0,0)}', '<p style="margin:8px">hello <b>world</b> static</p>', 'p', 'sibling-position selector, element sibling'],
    ['.d:has(p){outline:0}', '<p style="margin:8px">hello world static</p>', 'p', ':has()'],
    ['', '<div style="display:flex;margin:8px">hello world static</div>', 'div', 'flex parent'],
  ];
  for (const [rule, html, sel, what] of cases) {
    const m = mount(`<div class="d" drawable>${html}</div>`, { css: css + rule });
    const el = m.layerEl.firstElementChild;
    const text = el.querySelector(sel).firstChild;
    const range = document.createRange();
    range.setStart(text, 1);
    range.setEnd(text, 4);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    try {
      const res = m.capture(m.request(el));
      const svg = decodeURIComponent(res.url);
      assert.ok(!svg.includes('<hic-sel'), `${what}: no wrapper`);
      const er = el.getBoundingClientRect();
      const rr = range.getBoundingClientRect();
      const got = look(await rasterize(res), { x: rr.left - er.left, y: rr.top - er.top, width: rr.width, height: rr.height });
      assert.ok(dist(got.bg, [255, 255, 255]) > 30, `${what}: the selection is still highlighted (overlay), got ${got.bg}`);
    } finally {
      getSelection().removeAllRanges();
    }
  }
  // the sibling-position rule still applies to <b> while its text is selected (no wrapper was inserted before it)
  const m = mount('<div class="d" drawable><p style="margin:8px">hello <b>world</b> static</p></div>', { css: `${css}b:first-child{color:rgb(200,0,0)}` });
  const el = m.layerEl.firstElementChild;
  const b = el.querySelector('b');
  const range = document.createRange();
  range.setStart(el.querySelector('p').firstChild, 1);
  range.setEnd(el.querySelector('p').firstChild, 4);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
  try {
    const er = el.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    const got = look(await rasterize(m.capture(m.request(el))), { x: br.left - er.left, y: br.top - er.top, width: br.width, height: br.height });
    assert.ok(dist(got.glyph, [200, 0, 0]) <= 24, `b:first-child keeps its colour: ${got.glyph}`);
  } finally {
    getSelection().removeAllRanges();
  }
});

test('an author ::selection rule with text-decoration and text-shadow: the selected page text is drawn with them (WPT privacy/selection-alone-with-decorations-painted); control: a rule without them draws neither', async () => {
  // one class per draw: the fixture of the first draw is still in the document during the second
  const selCss = (cls, deco) => `${css}.${cls}{margin:0;font:20px/30px sans-serif;color:rgb(0,0,0)}.${cls}::selection{background:rgb(0,255,0);color:rgb(0,128,0)${deco}}`;
  const draw = async (cls, deco) => {
    const m = mount(`<div class="d" drawable><p class="${cls}">select me</p></div>`, { css: selCss(cls, deco) });
    const text = /** @type {Text} */ (m.layerEl.querySelector('p')?.firstChild);
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 6);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    try {
      const el = m.layerEl.firstElementChild;
      const er = el.getBoundingClientRect();
      const rr = range.getBoundingClientRect();
      const img = await rasterize(m.capture(m.request(el)));
      return { img, box: { x: Math.round(rr.left - er.left), y: Math.round(rr.top - er.top), w: Math.round(rr.width), h: Math.round(rr.height) } };
    } finally {
      getSelection().removeAllRanges();
    }
  };
  /** count of pixels of a colour in the selected line box and below it */
  const count = ({ img, box }, rgb, tol = 40) => {
    const d = img.getImageData(box.x, box.y, box.w + 4, box.h + 8).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - rgb[0]) + Math.abs(d[i + 1] - rgb[1]) + Math.abs(d[i + 2] - rgb[2]) <= tol) n++;
    return n;
  };
  const decorated = await draw('deco', ';text-decoration:2px rgb(0,0,255) underline;text-shadow:rgb(255,0,255) 2px 5px');
  const plain = await draw('plain', '');
  assert.ok(count(decorated, [0, 0, 255]) >= 40, `the blue underline is drawn: ${count(decorated, [0, 0, 255])} px`);
  assert.ok(count(decorated, [255, 0, 255]) >= 20, `the magenta shadow is drawn: ${count(decorated, [255, 0, 255])} px`);
  assert.equal(count(plain, [0, 0, 255]), 0, 'control: no underline without the rule');
  assert.equal(count(plain, [255, 0, 255]), 0, 'control: no shadow without the rule');
});
