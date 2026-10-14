import { test, assert, microtasks } from '/test/unit/lib/t.js';
import { setup, page } from '/test/unit/live/lib.mjs';

test('drawables are the [drawable] descendants in tree order; nearestDrawable walks up to the layer', async (t) => {
  const { managed } = setup({ t });
  const { canvas } = page('<section id="s"><div id="a" drawable><i id="ai">x</i></div></section><div id="b" drawable>b<div id="nested" drawable></div></div><div id="plain"></div>');
  const r = managed(canvas);
  assert.deepEqual(r.layer.drawableElements().map((e) => e.id), ['a', 'b', 'nested']);
  const ai = canvas.querySelector('#ai');
  assert.equal(r.layer.nearestDrawable(ai).id, 'a');
  assert.equal(r.layer.nearestDrawable(canvas.querySelector('#nested')).id, 'nested');
  assert.equal(r.layer.nearestDrawable(canvas.querySelector('#plain')), null);
  assert.equal(r.layer.nearestDrawable(canvas.querySelector('#s')), null);
  assert.equal(r.layer.nearestDrawable(ai.firstChild).id, 'a', 'text nodes resolve through their parent');
});

test('legacy mode: every direct child element is a drawable, nothing deeper', async (t) => {
  const { managed } = setup({ t });
  const { canvas } = page('<div id="a"><i id="deep" drawable></i></div>text<p id="b"></p>');
  const r = managed(canvas, true);
  assert.deepEqual(r.layer.drawableElements().map((e) => e.id), ['a', 'b']);
});

test('adding, removing and flipping the drawable attribute updates the set and emits DRAWABLES_CHANGED', async (t) => {
  const { managed, bus } = setup({ t });
  const { canvas } = page('<div id="a" drawable></div><div id="b"></div>');
  const r = managed(canvas);
  const events = [];
  bus.on('drawables:changed', (e) => events.push({ added: e.added.map((x) => x.id), removed: e.removed.map((x) => x.id) }));
  const b = canvas.querySelector('#b');
  b.setAttribute('drawable', '');
  assert.deepEqual(r.layer.drawableElements().map((e) => e.id), ['a', 'b'], 'synchronous at the API boundary, no microtask needed');
  const c = document.createElement('div');
  c.id = 'c';
  c.setAttribute('drawable', '');
  canvas.append(c);
  canvas.querySelector('#a').removeAttribute('drawable');
  await microtasks();
  assert.deepEqual(r.layer.drawableElements().map((e) => e.id), ['b', 'c']);
  assert.equal(events.length >= 2, true);
  assert.deepEqual(events.flatMap((e) => e.added).sort(), ['b', 'c']);
  assert.deepEqual(events.flatMap((e) => e.removed), ['a']);
});

test('layout queries: isLaidOut, borderBoxSize, borderBoxRectInLayer, frameRect', async (t) => {
  const { managed } = setup({ t });
  const { canvas } = page('<div id="a" drawable style="margin:10px 0 0 6px;width:80.5px;height:30.25px;border:1px solid"><span id="s" style="display:inline-block;vertical-align:top;margin-left:4px;width:20px;height:10px"></span></div><div id="h" drawable style="display:none"></div>', 'display:block;width:300px;height:150px');
  const r = managed(canvas);
  const a = canvas.querySelector('#a');
  assert.equal(r.layer.isLaidOut(a), true);
  assert.equal(r.layer.isLaidOut(canvas.querySelector('#h')), false);
  assert.equal(r.layer.borderBoxSize(canvas.querySelector('#h')), null);
  const size = r.layer.borderBoxSize(a);
  assert.ok(Math.abs(size.width - 82.5) < 0.01 && Math.abs(size.height - 32.25) < 0.01, JSON.stringify(size));
  const rect = r.layer.borderBoxRectInLayer(a);
  assert.ok(Math.abs(rect.x) < 0.01 && Math.abs(rect.y) < 0.01, `margins of the canvas children are ignored and every child sits at the origin, as natively: ${JSON.stringify(rect)}`);
  const frame = r.layer.frameRect(canvas.querySelector('#s'));
  assert.ok(Math.abs(frame.x - 5) < 0.01 && Math.abs(frame.y - 1) < 0.01 && Math.abs(frame.width - 20) < 0.01, JSON.stringify(frame));
  assert.equal(r.layer.frameRect(canvas.querySelector('#h')), null);
});

test('elementAtPoint finds hit-testable layer content and ignores the rest', async (t) => {
  const { managed } = setup({ t });
  const { canvas } = page('<div id="a" drawable style="width:100px;height:40px"></div>', 'display:block;width:300px;height:150px');
  const r = managed(canvas);
  const a = canvas.querySelector('#a');
  const box = a.getBoundingClientRect();
  assert.equal(r.layer.elementAtPoint({ x: box.x + 5, y: box.y + 5 }), null, 'not drawn: falls through to the canvas');
  r.layer.setHitTestOrder([a]);
  r.layer.applyGeometry(a, { transform: null, clip: null }, null);
  await microtasks();
  assert.equal(r.layer.elementAtPoint({ x: canvas.getBoundingClientRect().x + 5, y: canvas.getBoundingClientRect().y + 5 }), a);
});
