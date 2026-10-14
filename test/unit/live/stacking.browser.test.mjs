import { test, assert, frames } from '/test/unit/lib/t.js';
import { setup, page } from '/test/unit/live/lib.mjs';
import { flushGeometryWrites } from '/src/live/geometry-apply.js';
import { auditStacking } from '/src/live/stacking-audit.js';

const DRAWABLE = '<div id="d" drawable style="width:100%;height:100%;background:#369"></div>';
const CANVAS = 'display:block;width:400px;height:200px';

function drawAll(r) {
  const d = r.canvas.querySelector('#d');
  r.layer.setHitTestOrder([d]);
  r.layer.applyGeometry(d, { transform: new DOMMatrix(), clip: null }, { x: 0, y: 0 });
  flushGeometryWrites();
  return d;
}

test('a positioned overlay before a non-positioned canvas is found even when it is smaller than the sample grid', async (t) => {
  const { managed, reports } = setup({ t });
  const { canvas } = page(DRAWABLE, CANVAS, '<div id="ov" style="position:absolute;left:150px;top:50px;width:20px;height:10px;background:red"></div>', '', { position: 'relative' });
  const r = managed(canvas);
  r.canvas = canvas;
  drawAll(r);
  await frames(1);
  const findings = r.layer.stackingAudit();
  assert.equal(findings.length, 1, JSON.stringify(findings.map((f) => f.covered.id)));
  assert.equal(findings[0].covered.id, 'ov');
  assert.equal(findings[0].drawable.id, 'd');
  assert.equal(reports.unsupported.filter((e) => e.feature === 'stacking-overlap').length, 1);
  r.layer.stackingAudit();
  assert.equal(reports.unsupported.filter((e) => e.feature === 'stacking-overlap').length, 1, 'reported once per element');
});

test('silent on a clean page, on a positioned stacking context canvas, and for overlays after the canvas', async (t) => {
  const { managed } = setup({ t });
  const clean = page(DRAWABLE, CANVAS);
  const a = managed(clean.canvas);
  drawAll(a);
  assert.deepEqual(a.layer.stackingAudit(), []);
  clean.root.remove();

  const ctx = page(DRAWABLE, `${CANVAS};position:relative;z-index:0`, '<div style="position:absolute;left:10px;top:10px;width:60px;height:30px;background:red"></div>', '', { position: 'relative' });
  const b = managed(ctx.canvas);
  drawAll(b);
  assert.deepEqual(b.layer.stackingAudit(), [], 'workaround: the canvas is a positioned stacking context');
  ctx.root.remove();

  const after = page(DRAWABLE, CANVAS, '', '<div style="position:absolute;left:10px;top:10px;width:60px;height:30px;background:red"></div>', { position: 'relative' });
  const c = managed(after.canvas);
  drawAll(c);
  assert.deepEqual(c.layer.stackingAudit(), [], 'overlay after the canvas is above the layer too: they agree');
});

test('a float/in-flow element is not reported, a sticky header is', async (t) => {
  const { managed } = setup({ t });
  const { canvas } = page(DRAWABLE, CANVAS, '<div id="hd" style="position:sticky;top:0;height:30px;margin-bottom:-30px;background:#999"></div>', '');
  const r = managed(canvas);
  drawAll(r);
  await frames(1);
  const f = r.layer.stackingAudit();
  assert.deepEqual(f.map((x) => x.covered.id), ['hd']);
});

test('canvas missing from the hit list (an unclipped scroller) is a finding naming the canvas', async (t) => {
  const { managed } = setup({ t });
  const { canvas, root } = page(DRAWABLE, 'display:block;width:300px;height:400px', '<div style="overflow:auto;height:200px">', '</div>');
  const r = managed(canvas);
  const d = drawAll(r);
  await frames(1);
  assert.deepEqual(r.layer.stackingAudit(), [], 'the ancestor clip keeps the layer inside the scroller: no finding');
  r.layer.element.style.setProperty('clip-path', 'none', 'important');
  const findings = auditStacking(r, r.layer.element, [d]);
  assert.ok(findings.some((f) => f.covered === canvas), 'positive control: without the clip the canvas is missing at points of the layer');
  assert.ok(root);
});

test('stackingAudit is rate limited, and option off disables it', async (t) => {
  const s = setup({ t });
  let now = 1000;
  s.env.now = () => now;
  const { canvas } = page(DRAWABLE, CANVAS, '<div id="ov" style="position:absolute;left:150px;top:50px;width:20px;height:10px"></div>', '', { position: 'relative' });
  const r = s.managed(canvas);
  drawAll(r);
  const first = r.layer.stackingAudit();
  assert.equal(first.length, 1);
  canvas.previousElementSibling.remove();
  assert.equal(r.layer.stackingAudit(), first, 'inside the window the cached result is returned');
  now += 600;
  assert.deepEqual(r.layer.stackingAudit(), [], 'after the window the page is audited again');
  const off = setup({ t, options: { stackingAudit: 'off' } });
  const p = page(DRAWABLE, CANVAS);
  const r2 = off.managed(p.canvas);
  assert.deepEqual(r2.layer.stackingAudit(), []);
});
