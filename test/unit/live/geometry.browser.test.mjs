import { test, assert, microtasks } from '/test/unit/lib/t.js';
import { setup, page, contentRect } from '/test/unit/live/lib.mjs';
import { flushGeometryWrites } from '/src/live/geometry-apply.js';

const KIDS = '<div id="a" drawable style="height:40px;width:100px;background:#c00">A</div><div id="b" drawable style="height:40px;width:100px;background:#0c0">B</div><div id="c" drawable style="height:40px;width:100px;background:#00c">C</div>';
const CANVAS = 'display:block;width:500px;height:400px;margin:20px 0 0 30px';

/** The canvas transform of a draw is D itself: it maps the border box (origin at its top-left corner) to the canvas and knows no transform-origin (WPT get-element-transform). */
function specMatrix(D) {
  return D;
}

/** bbox of D applied to the border box of el, in viewport px (the canvas content box is the origin). */
function expectedBox(D, el, canvas, w = el.offsetWidth, h = el.offsetHeight) {
  const o = contentRect(canvas);
  const pts = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => { const p = D.transformPoint(new DOMPoint(x, y)); return [o.x + p.x / p.w, o.y + p.y / p.w]; });
  const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), pts, o };
}

/** Elements drawn so far in the current test, in draw order. */
const order_ = [];

/** Draw `el` with D: store M on the layer like api/geometry.js does and flush. */
async function draw(r, el, D, clip = null) {
  if (!order_.includes(el)) order_.push(el);
  r.layer.setHitTestOrder([...order_]);
  r.layer.applyGeometry(el, { transform: specMatrix(D, el), clip }, null);
  flushGeometryWrites();
}

function near(a, b, tol, msg) {
  assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
}

function hit(x, y) { return document.elementFromPoint(x, y); }

test('2D translate, scale and rotate land the live element exactly where it is drawn and hit testing follows', async (t) => {
  const { managed } = setup({ t });
  const cases = {
    translate: new DOMMatrix().translate(150, 100),
    scale: new DOMMatrix().translate(40, 60).scale(1.5, 2),
    rotate: new DOMMatrix().translate(200, 120).rotate(25),
  };
  for (const [name, D] of Object.entries(cases)) {
    order_.length = 0;
    const { canvas, root } = page(KIDS, CANVAS);
    const r = managed(canvas);
    const a = canvas.querySelector('#b');
    const style = a.getAttribute('style');
    const layoutBox = a.getBoundingClientRect();
    await draw(r, a, D);
    const want = expectedBox(D, a, canvas);
    const got = a.getBoundingClientRect();
    for (const k of ['x', 'y', 'width', 'height']) near(got[k], want[k], 0.01, `${name} ${k}`);
    const centre = D.transformPoint(new DOMPoint(a.offsetWidth / 2, a.offsetHeight / 2));
    assert.equal(hit(want.o.x + centre.x, want.o.y + centre.y), a, `${name}: centre of the drawn element hits it (got ${hit(want.o.x + centre.x, want.o.y + centre.y)?.id}/${hit(want.o.x + centre.x, want.o.y + centre.y)?.localName} at ${want.o.x + centre.x},${want.o.y + centre.y}; box ${JSON.stringify(a.getBoundingClientRect())})`);
    const inner = D.transformPoint(new DOMPoint(10, 10));
    assert.equal(hit(want.o.x + inner.x, want.o.y + inner.y), a, `${name}: inner point`);
    assert.notEqual(hit(layoutBox.x + 2, layoutBox.y + 2), a, `${name}: the old layout position no longer hits the element`);
    assert.equal(a.getAttribute('style'), style, `${name}: author style attribute untouched`);
    r.layer.unmount();
    assert.equal(a.hasAttribute('data-hic-hit'), false);
    r.layer.dispose();
    root.remove();
  }
});

test('3D matrix with perspective', async (t) => {
  const { managed } = setup({ t });
  order_.length = 0;
  const { canvas } = page(KIDS, CANVAS);
  const r = managed(canvas);
  const a = canvas.querySelector('#a');
  const D = new DOMMatrix().translate(120, 80).rotateAxisAngle(0, 1, 0, 35);
  D.m34 = -1 / 600;
  await draw(r, a, D);
  const want = expectedBox(D, a, canvas);
  const got = a.getBoundingClientRect();
  for (const k of ['x', 'y', 'width', 'height']) near(got[k], want[k], 0.05, `3D ${k}`);
  const c = D.transformPoint(new DOMPoint(50, 20));
  assert.equal(hit(want.o.x + c.x / c.w, want.o.y + c.y / c.w), a);
});

test('not drawn elements fall through to the canvas; z-order follows the draw order', async (t) => {
  const { managed } = setup({ t });
  order_.length = 0;
  const { canvas } = page(KIDS, CANVAS);
  const r = managed(canvas);
  const [a, b] = [canvas.querySelector('#a'), canvas.querySelector('#b')];
  const o = contentRect(canvas);
  assert.equal(hit(o.x + 20, o.y + 20), canvas, 'nothing drawn yet: the canvas is hit');
  const Da = new DOMMatrix().translate(100, 100);
  const Db = new DOMMatrix().translate(130, 110);
  r.layer.setHitTestOrder([a, b]);
  r.layer.applyGeometry(a, { transform: specMatrix(Da, a), clip: null }, null);
  r.layer.applyGeometry(b, { transform: specMatrix(Db, b), clip: null }, null);
  flushGeometryWrites();
  assert.equal(hit(o.x + 140, o.y + 115), b, 'b was drawn last: it is on top where both overlap');
  assert.deepEqual(document.elementsFromPoint(o.x + 140, o.y + 115).slice(0, 3).map((e) => e.id), ['b', 'a', 'c']);
  r.layer.setHitTestOrder([b, a]);
  flushGeometryWrites();
  assert.equal(hit(o.x + 140, o.y + 115), a, 'order reversed');
  r.layer.setHitTestOrder([b]);
  flushGeometryWrites();
  assert.equal(hit(o.x + 105, o.y + 105), canvas, 'a left the drawn list and no longer hits');
  assert.equal(a.hasAttribute('data-hic-hit'), false);
  r.layer.applyGeometry(b, null);
  flushGeometryWrites();
  assert.equal(b.hasAttribute('data-hic-hit'), false, 'null geometry removes the hit attribute');
});

test('clip restricts hit testing to the clipped part', async (t) => {
  const { managed } = setup({ t });
  order_.length = 0;
  const { canvas } = page(KIDS, CANVAS);
  const r = managed(canvas);
  const a = canvas.querySelector('#a');
  const D = new DOMMatrix().translate(200, 200);
  await draw(r, a, D, new DOMRect(0, 0, 50, 40));
  const o = contentRect(canvas);
  assert.equal(hit(o.x + 220, o.y + 220), a, 'kept half');
  assert.equal(hit(o.x + 270, o.y + 220), canvas, 'clipped half falls through to the canvas');
});

test('regression: a full-box clip follows the element size after a resize (the cached size once turned it into a clip of everything)', async (t) => {
  const { managed } = setup({ t });
  order_.length = 0;
  const { canvas } = page(KIDS, CANVAS);
  const r = managed(canvas);
  const a = canvas.querySelector('#a');
  const D = new DOMMatrix();
  await draw(r, a, D, new DOMRect(0, 0, 100, 40));
  const o = contentRect(canvas);
  assert.equal(hit(o.x + 50, o.y + 20), a, 'hit before the resize');
  a.style.width = '60px';
  await draw(r, a, D, new DOMRect(0, 0, 60, 40));
  assert.equal(hit(o.x + 30, o.y + 20), a, 'a full-box clip of the new, smaller box clips nothing');
  a.style.width = '100px';
  await draw(r, a, D, new DOMRect(0, 0, 100, 40));
  assert.equal(hit(o.x + 90, o.y + 20), a, 'and after growing again');
});

test('an unchanged geometry causes no DOM or rule writes (no feedback loop)', async (t) => {
  const { managed } = setup({ t });
  order_.length = 0;
  const { canvas } = page(KIDS, CANVAS);
  const r = managed(canvas);
  const a = canvas.querySelector('#a');
  const D = new DOMMatrix().translate(90, 70);
  await draw(r, a, D);
  const records = [];
  const mo = new MutationObserver((rs) => records.push(...rs));
  mo.observe(r.layer.element, { attributes: true, subtree: true });
  mo.observe(canvas.ownerDocument.body, { attributes: true, subtree: true });
  const sheet = [...document.adoptedStyleSheets].find((s) => [...s.cssRules].some((x) => x.selectorText?.includes('data-hic-hit="g')));
  const text = [...sheet.cssRules].map((x) => x.cssText).join('|');
  for (let i = 0; i < 50; i++) r.layer.applyGeometry(a, { transform: specMatrix(D, a), clip: null }, { x: 0, y: 0 });
  flushGeometryWrites();
  await microtasks();
  assert.equal(records.length, 0, `attribute mutations: ${records.map((x) => x.attributeName)}`);
  assert.equal([...sheet.cssRules].map((x) => x.cssText).join('|'), text);
  mo.disconnect();
});

test('geometry is visible at once and the last value wins however many times it is set', async (t) => {
  const { managed } = setup({ t });
  order_.length = 0;
  const { canvas } = page(KIDS, CANVAS);
  const r = managed(canvas);
  const a = canvas.querySelector('#a');
  r.layer.setHitTestOrder([a]);
  for (let i = 1; i <= 20; i++) r.layer.applyGeometry(a, { transform: specMatrix(new DOMMatrix().translate(i * 5, 10), a), clip: null }, null);
  assert.equal(a.hasAttribute('data-hic-hit'), true, 'written synchronously: getBoundingClientRect() right after updateElementGeometry() must see it (WPT canvas-transform-*)');
  await microtasks();
  const want = expectedBox(new DOMMatrix().translate(100, 10), a, canvas);
  near(a.getBoundingClientRect().x, want.x, 0.01, 'last value wins');
});

test('nested drawables compose: parent and child land where each is drawn', async (t) => {
  const { managed } = setup({ t });
  order_.length = 0;
  const { canvas } = page('<div id="p" drawable style="width:200px;height:100px;padding:10px;background:#eee"><div id="k" drawable style="margin-top:20px;width:60px;height:30px;background:#c0c">K</div></div>', CANVAS);
  const r = managed(canvas);
  const [p, k] = [canvas.querySelector('#p'), canvas.querySelector('#k')];
  const Dp = new DOMMatrix().translate(100, 150).scale(1.25, 1.25);
  const Dk = new DOMMatrix().translate(300, 40).rotate(10);
  r.layer.setHitTestOrder([p, k]);
  r.layer.applyGeometry(p, { transform: specMatrix(Dp, p), clip: new DOMRect(0, 0, 100, 100) }, null);
  r.layer.applyGeometry(k, { transform: specMatrix(Dk, k), clip: null }, null);
  flushGeometryWrites();
  const want = expectedBox(Dk, k, canvas, 60, 30);
  const got = k.getBoundingClientRect();
  for (const key of ['x', 'y', 'width', 'height']) near(got[key], want[key], 0.05, `child ${key}`);
  const c = Dk.transformPoint(new DOMPoint(30, 15));
  assert.equal(hit(want.o.x + c.x, want.o.y + c.y), k, 'trusted hit lands on the nested drawable');
  const wantP = expectedBox(Dp, p, canvas, p.offsetWidth, p.offsetHeight);
  near(p.getBoundingClientRect().x, wantP.x, 0.01, 'parent still where it is drawn');
  const px = Dp.transformPoint(new DOMPoint(5, 5));
  assert.equal(hit(wantP.o.x + px.x, wantP.o.y + px.y), p);
  assert.ok(r.layer.element.ownerDocument.defaultView);
});

test('css-transform-on-drawable: a scale/rotation canvas transform on an element with its own CSS transform is skipped and reported once', async (t) => {
  const { managed, reports } = setup({ t });
  order_.length = 0;
  const { canvas } = page('<div id="a" drawable style="width:50px;height:50px;transform:rotate(3deg)"></div>', CANVAS);
  const r = managed(canvas);
  const a = canvas.querySelector('#a');
  r.layer.setHitTestOrder([a]);
  r.layer.applyGeometry(a, { transform: new DOMMatrix().scale(2), clip: null }, null);
  r.layer.applyGeometry(a, { transform: new DOMMatrix().scale(2), clip: null }, null);
  flushGeometryWrites();
  assert.equal(a.hasAttribute('data-hic-hit'), false);
  assert.equal(reports.deviation.filter((d) => d.id === 'css-transform-on-drawable').length, 1);
});

test('css-transform-on-drawable: a translation canvas transform composes with the own CSS transform, translate and rotate in spec order (canvas transform first), synchronously (WPT canvas-transform-get-bounding-client-rect)', async (t) => {
  const { managed, reports } = setup({ t });
  order_.length = 0;
  const { canvas } = page('<div id="a" drawable style="position:absolute;left:0;top:0;width:100px;height:50px;transform:scale(2)"></div>', CANVAS);
  const r = managed(canvas);
  const a = /** @type {HTMLElement} */ (canvas.querySelector('#a'));
  const o = contentRect(canvas);
  await draw(r, a, new DOMMatrix().translate(30, 40));
  const near = (/** @type {number} */ v, /** @type {number} */ e, /** @type {string} */ m) => assert.ok(Math.abs(v - e) < 0.01, `${m}: ${v} vs ${e}`);
  let b = a.getBoundingClientRect();
  near(b.left - o.x, 30 - 50, 'scale(2) around the centre after the canvas translation');
  near(b.top - o.y, 40 - 25, 'top');
  near(b.width, 200, 'width');
  a.style.translate = '5px 10px';
  b = a.getBoundingClientRect();
  near(b.left - o.x, 30 + 5 - 50, 'the author translate property composes too, without a re-application');
  a.style.transform = 'none'; a.style.translate = '';
  b = a.getBoundingClientRect();
  near(b.left - o.x, 30, 'author transform removed: the canvas translation alone');
  a.style.transform = 'translate(50px, 50px)';
  const hit = document.elementsFromPoint(o.x + 30 + 50 + 10, o.y + 40 + 50 + 10);
  assert.ok(hit.includes(a), 'hit testing follows the CSS transform on top of the canvas transform');
  await draw(r, a, new DOMMatrix().translate(30, 40).scale(2));
  assert.equal(reports.deviation.filter((d) => d.id === 'css-transform-on-drawable').length, 1, 'a scale with an own transform is reported');
  a.style.transform = '';
  assert.equal(getComputedStyle(a).transform, 'none', 'the polyfill never wrote the transform of a shifted element');
});

test('a transformed non-drawable ancestor skips geometry and is reported (nested-geometry)', async (t) => {
  const { managed, reports } = setup({ t });
  order_.length = 0;
  const { canvas } = page('<section style="transform:translateX(5px)"><div id="a" drawable style="width:50px;height:50px"></div></section>', CANVAS);
  const r = managed(canvas);
  const a = canvas.querySelector('#a');
  r.layer.setHitTestOrder([a]);
  r.layer.applyGeometry(a, { transform: new DOMMatrix(), clip: null }, null);
  flushGeometryWrites();
  assert.equal(a.hasAttribute('data-hic-hit'), false);
  assert.equal(reports.deviation.filter((d) => d.id === 'nested-geometry').length, 1);
});

test('revalidateGeometry follows a layout shift without a new draw', async (t) => {
  const { managed } = setup({ t });
  order_.length = 0;
  const { canvas } = page('<div id="w" style="padding-top:5px"><div id="b" drawable style="height:40px;width:100px;background:#0c0">B</div></div>', CANVAS);
  const r = managed(canvas);
  const b = canvas.querySelector('#b');
  const D = new DOMMatrix().translate(200, 220);
  await draw(r, b, D);
  canvas.querySelector('#w').style.paddingTop = '38px';
  flushGeometryWrites();
  const stale = b.getBoundingClientRect().y;
  r.layer.revalidateGeometry();
  flushGeometryWrites();
  const want = expectedBox(D, b, canvas);
  near(b.getBoundingClientRect().y, want.y, 0.01, 'back on the drawn position');
  assert.notEqual(Math.round(stale), Math.round(want.y), 'the shift really moved it before revalidation');
});

test('a measure between a draw and the flush of its correction divides by the transform that is in the DOM (resize residual)', async (t) => {
  // paint dispatch runs inside the scheduler's JS stack, so no microtask checkpoint separates the draw (which stores the new matrix) from the store's next layout read
  // (verifyGeometries): the read used to divide by the NEW matrix while the document still carried the OLD one, measured a size 1.7 % off and re-rastered the drawable from it.
  const { managed } = setup({ t });
  order_.length = 0;
  const { canvas } = page(KIDS, CANVAS);
  const r = managed(canvas);
  const a = canvas.querySelector('#a');
  const layout = r.layer.borderBoxSize(a);
  await draw(r, a, new DOMMatrix().scale(1.5, 1.5)); // the old drawing is stretched: the document carries scale(1.5)
  assert.ok(Math.abs(a.getBoundingClientRect().width - layout.width * 1.5) < 0.01, 'the stretch is in the document');
  r.layer.applyGeometry(a, { transform: specMatrix(new DOMMatrix(), a), clip: null }, null); // the redraw at the right size: stored now, written by the microtask
  const during = r.layer.borderBoxSize(a); // no microtask checkpoint in between
  near(during.width, layout.width, 0.01, 'width measured before the flush');
  near(during.height, layout.height, 0.01, 'height measured before the flush');
  near(r.layer.frameRect(a).width, layout.width, 0.01, 'frame width measured before the flush');
  flushGeometryWrites();
  near(r.layer.borderBoxSize(a).width, layout.width, 0.01, 'and after it');
});

test('the measured size of an element under a correction carries no float noise (resize residual: a 4e-5 px excess made the surface one device pixel wider)', async (t) => {
  // the layout size lives on a 1/64 px grid; the bounding box of a scaled element is float32, so width / scale was 1400.00004 and ceil((w + 2 * ink) * 2) rounded UP to a surface one pixel too wide
  const { managed } = setup({ t });
  order_.length = 0;
  const { canvas } = page(KIDS, CANVAS);
  const r = managed(canvas);
  const a = canvas.querySelector('#a');
  let worst = 0;
  for (const k of [0.9826, 0.9997, 1.0177, 1.0167, 0.999, 1.0004]) {
    await draw(r, a, new DOMMatrix().scale(k, 1));
    for (let w = 1213; w <= 1400; w += 7) {
      a.style.width = `${w}px`;
      worst = Math.max(worst, Math.abs(r.layer.borderBoxSize(a).width - w));
    }
  }
  assert.ok(worst < 1e-6, `worst deviation from the layout width: ${worst}`);
});

test('measuring an element that carries a correction still returns its layout size', async (t) => {
  const { managed } = setup({ t });
  order_.length = 0;
  const { canvas } = page(KIDS, CANVAS);
  const r = managed(canvas);
  const a = canvas.querySelector('#a');
  const before = r.layer.borderBoxSize(a);
  await draw(r, a, new DOMMatrix().translate(100, 100).scale(1.5, 2));
  const after = r.layer.borderBoxSize(a);
  near(after.width, before.width, 0.01, 'width');
  near(after.height, before.height, 0.01, 'height');
  const frame = r.layer.frameRect(a);
  near(frame.width, before.width, 0.01, 'frame width');
});

test('ink-overflow: inkOverflow measures box-shadow, outline, overflowing descendants and the own CSS transform of a drawable (not the polyfill correction)', async (t) => {
  const { managed } = setup({ t });
  order_.length = 0;
  const { canvas } = page('<div id="s" drawable style="width:50px;height:50px;box-shadow:5px 0 20px 10px red"></div>'
    + '<div id="o" drawable style="width:50px;height:50px;outline:5px solid;outline-offset:3px"></div>'
    + '<div id="d" drawable style="width:50px;height:50px"><div style="width:180px;height:10px;margin-top:60px"></div></div>'
    + '<div id="x" drawable style="width:100px;height:100px;transform:translateX(100px)"></div>'
    + '<div id="m" drawable style="width:50px;height:50px"></div>', CANVAS);
  const r = managed(canvas);
  const ink = (/** @type {string} */ id) => r.layer.inkOverflow(canvas.querySelector('#' + id));
  const s = ink('s');
  assert.equal(s.left, 10 + 30 - 5); assert.equal(s.right, 10 + 30 + 5); assert.equal(s.top, 40);
  assert.deepEqual(ink('o'), { left: 8, top: 8, right: 8, bottom: 8 });
  const d = ink('d');
  assert.ok(d.right >= 130 && d.right <= 131 && d.bottom >= 20 && d.bottom <= 21 && d.left === 0, JSON.stringify(d));
  const x = ink('x');
  assert.ok(Math.abs(x.right - 100) < 0.01 && x.left === 0, JSON.stringify(x));
  const m = canvas.querySelector('#m');
  await draw(r, m, new DOMMatrix().translate(300, 200).scale(2));
  assert.deepEqual(ink('m'), { left: 0, top: 0, right: 0, bottom: 0 }, 'the geometry correction is not ink');
});

test('css zoom on a drawable: the canvas transform lands in canvas px (the zoom multiplies px lengths, so the correction divides its translation by it), both placement schemes', async (t) => {
  const { managed } = setup({ t });
  order_.length = 0;
  const { canvas } = page('<div id="a" drawable style="width:50px;height:50px;zoom:2"></div><section style="zoom:1.5"><div id="b" drawable style="width:50px;height:50px"></div></section>', CANVAS);
  const r = managed(canvas);
  const a = canvas.querySelector('#a'); const b = canvas.querySelector('#b');
  const o = contentRect(canvas);
  await draw(r, a, new DOMMatrix().translate(30, 40));
  await draw(r, b, new DOMMatrix().translate(70, 10).scale(2));
  const ra = a.getBoundingClientRect(); const rb = b.getBoundingClientRect();
  const near = (/** @type {number} */ v, /** @type {number} */ e, /** @type {string} */ m) => assert.ok(Math.abs(v - e) < 0.02, `${m}: ${v} vs ${e}`);
  near(ra.x - o.x, 30, 'shift x'); near(ra.y - o.y, 40, 'shift y'); near(ra.width, 100, 'zoomed width');
  near(rb.x - o.x, 70, 'matrix x'); near(rb.y - o.y, 10, 'matrix y'); near(rb.width, 150, 'zoomed width x scale 2');
});
