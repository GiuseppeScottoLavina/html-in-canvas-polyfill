import { test, assert, frames } from '/test/unit/lib/t.js';
import { setup, page, rect, closeRect } from '/test/unit/live/lib.mjs';
import { flushGeometryWrites } from '/src/live/geometry-apply.js';

const DRAWABLE = '<div id="d" drawable style="width:100%;height:100%;background:#369"><input id="in" style="margin-top:250px"></div>';

/** Draw the single drawable at its layout position so it is hit-testable. */
function drawAll(r) {
  const d = r.canvas.querySelector('#d');
  r.layer.setHitTestOrder([d]);
  r.layer.applyGeometry(d, { transform: new DOMMatrix(), clip: null }, { x: 0, y: 0 });
  flushGeometryWrites();
  return d;
}

const hit = (x, y) => document.elementFromPoint(x, y);

test('fixed canvas: the layer is fixed and stays glued while the page scrolls', async (t) => {
  const { managed } = setup({ t });
  const { canvas, root } = page(DRAWABLE, 'position:fixed;left:40px;top:30px;width:200px;height:120px', '<div style="height:3000px"></div>');
  const r = managed(canvas);
  r.canvas = canvas;
  assert.equal(getComputedStyle(r.layer.element).position, 'fixed');
  window.scrollTo(0, 400);
  t.cleanup(() => window.scrollTo(0, 0));
  await frames(2);
  assert.ok(closeRect(rect(r.layer.element), rect(canvas), 0.5), `${JSON.stringify(rect(r.layer.element))} vs ${JSON.stringify(rect(canvas))}`);
  assert.ok(root);
});

test('sticky, relative scroller, transformed ancestor: layer rect equals canvas rect', async (t) => {
  const { managed } = setup({ t });
  const cases = {
    sticky: ['position:sticky;top:0;display:block;width:200px;height:100px', '', ''],
    'relative scroller': ['display:block;width:200px;height:100px', '<div style="position:relative;overflow:auto;height:300px"><div style="height:20px"></div>', '</div>'],
    'transformed ancestor': ['display:block;width:200px;height:100px', '<div style="transform:translate(7px,9px) scale(1.2);transform-origin:0 0">', '</div>'],
    'static scroller (scrolled)': ['display:block;width:200px;height:100px', '<div id="sc" style="overflow:auto;height:300px"><div style="height:20px"></div>', '<div style="height:600px"></div></div>'],
  };
  for (const [name, [style, open, close]] of Object.entries(cases)) {
    const { canvas, root } = page(DRAWABLE, style, open, close);
    const r = managed(canvas);
    const scroller = root.querySelector('#sc');
    if (scroller) { scroller.scrollTop = 17; await frames(2); }
    await frames(1);
    assert.ok(closeRect(rect(r.layer.element), rect(canvas), 0.5), `${name}: ${JSON.stringify(rect(r.layer.element))} vs ${JSON.stringify(rect(canvas))}`);
    r.layer.dispose();
    root.remove();
  }
});

test('non-positioned scroller: no ghost hit target outside the clip, at any scroll position', async (t) => {
  const { managed } = setup({ t });
  const { canvas, root } = page(DRAWABLE, 'display:block;width:300px;height:400px', '<div id="sc" style="overflow:auto;height:200px;width:320px"><div style="height:10px"></div>', '<div style="height:500px"></div></div><div id="below" style="height:300px;background:#ccc"></div>');
  const r = managed(canvas);
  assert.equal(r.layer.element.style.position, 'absolute');
  const d = drawAll(r);
  const sc = root.querySelector('#sc');
  const sr = sc.getBoundingClientRect();
  assert.ok(r.layer.element.style.clipPath.startsWith('inset('), `clip-path: ${r.layer.element.style.clipPath}`);
  for (const top of [0, 100]) {
    sc.scrollTop = top;
    await frames(2);
    assert.equal(hit(sr.x + 50, sr.y + 50), d, `scrollTop ${top}: inside the scroller the drawable is hit`);
    assert.notEqual(hit(sr.x + 50, sr.bottom + 20), d, `scrollTop ${top}: below the scroller edge nothing of the layer is hit`);
    assert.equal(hit(sr.x + 50, sr.bottom + 20)?.id, 'below');
  }
  // positive control: without the clip the failure of the measured design shows
  r.layer.element.style.setProperty('clip-path', 'none', 'important');
  assert.equal(hit(sr.x + 50, sr.bottom + 20), d, 'control: the unclipped layer is a ghost target below the scroller');
});

test('ancestor clip is computed from the canvas rect (correct after the scroller scrolled)', async (t) => {
  const { managed } = setup({ t });
  const { canvas, root } = page(DRAWABLE, 'display:block;width:300px;height:400px', '<div id="sc" style="overflow:auto;height:200px"><div style="height:10px"></div>', '<div style="height:900px"></div></div>');
  const r = managed(canvas);
  const sc = root.querySelector('#sc');
  sc.scrollTop = 120;
  await frames(3);
  const vis = sc.getBoundingClientRect();
  const lr = r.layer.element.getBoundingClientRect();
  const nums = (r.layer.element.style.clipPath.match(/[\d.]+(?=px)/g) ?? []).map(Number);
  assert.ok(nums.length >= 3, r.layer.element.style.clipPath);
  const top = nums[0];
  const bottom = nums.length === 3 ? nums[2] : nums[2];
  assert.ok(Math.abs(lr.top + top - vis.top) < 0.6, `top inset ${top}`);
  assert.ok(Math.abs(lr.bottom - bottom - vis.bottom) < 0.6, `bottom inset ${bottom}`);
});

test('focus inside the layer reveals the element in the canvas scrollers (nearest)', async (t) => {
  const { managed } = setup({ t });
  const { canvas, root } = page(DRAWABLE, 'display:block;width:300px;height:400px', '<div id="sc" style="overflow:auto;height:200px"><div style="height:10px"></div>', '<div style="height:900px"></div></div>');
  const r = managed(canvas);
  const sc = root.querySelector('#sc');
  const input = canvas.querySelector('#in');
  assert.equal(sc.scrollTop, 0);
  input.focus();
  await frames(2);
  const ir = input.getBoundingClientRect();
  const vis = sc.getBoundingClientRect();
  assert.ok(sc.scrollTop > 0, 'scroller moved');
  assert.ok(ir.bottom <= vis.bottom + 0.5 && ir.top >= vis.top - 0.5, `input visible: ${ir.top}..${ir.bottom} in ${vis.top}..${vis.bottom}`);
  assert.ok(Math.abs(ir.bottom - vis.bottom) < 1, 'nearest semantics: aligned to the near edge');
  assert.ok(r);
});

test('kind() reports what was found and unsupported shapes are reported once', async (t) => {
  const { managed, reports } = setup({ t });
  const plain = page('', 'display:block;width:50px;height:50px');
  assert.equal(managed(plain.canvas).layer && true, true);
  const shaped = page('', 'display:block;width:50px;height:50px', '<div style="overflow:hidden;clip-path:circle(40%);height:30px">', '</div>');
  const r2 = managed(shaped.canvas);
  r2.layer.syncPresentation();
  r2.layer.syncPresentation();
  assert.equal(reports.unsupported.filter((e) => e.feature === 'layer-containing-block').length, 1);
});
