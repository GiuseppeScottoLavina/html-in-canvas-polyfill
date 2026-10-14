// Optimistic text overlay fidelity (snapshot/capture/text-overlay.js + snapshot/store/text-paint.js): an overlay of the new value painted over the tile of the OLD value must look
// like the tile of the new value (the snapshot that replaces it one or two frames later), and every field state it cannot reproduce must give no plan.
import { test, assert, frames } from '/test/unit/lib/t.js';
import { mount, rasterize, diffFraction } from './_support.mjs';
import { planTextOverlay } from '/src/snapshot/capture/text-overlay.js';
import { overlayRectPx, paintTextOverlay } from '/src/snapshot/store/text-paint.js';

const S = 2;
const css = '.d{width:320px;height:60px;background:#fff;padding:8px;box-sizing:border-box}.i{width:220px;font:16px Arial,sans-serif;padding:4px 6px;border:1px solid #888;background:#fff;color:#123}'
  + '.dark{background:#1d2330;color:#e8ecf5;border-color:#445}';
const html = (v, extra = '', cls = 'i') => `<div class="d" drawable><input class="${cls}" value="${v}" ${extra}></div>`;

/** tile of the drawable at scale 2 */
const tileOf = async (m) => rasterize(m.capture(m.request(m.layerEl.firstElementChild, { scale: S })));

/** overlay of the CURRENT value painted over `old` (a tile context) */
function overlayOver(m, old, input) {
  const drawable = m.layerEl.firstElementChild;
  const plan = planTextOverlay(document, input, drawable, m.layer.frameRect(input));
  if (!plan) return null;
  const size = m.layer.borderBoxSize(drawable);
  const geo = { bw: size.width, bh: size.height, scale: S, reduced: false, ink: { left: 0, top: 0, right: 0, bottom: 0 }, widthPx: old.canvas.width, heightPx: old.canvas.height };
  assert.ok(paintTextOverlay(old.canvas, geo, plan));
  return plan;
}

async function fidelity(value, next, { cls = 'i', scroll = false } = {}) {
  const m = mount(html(value, '', cls), { css });
  const input = m.layerEl.querySelector('input');
  input.focus();
  if (scroll) input.setSelectionRange(input.value.length, input.value.length);
  await frames(2);
  const old = await tileOf(m);
  input.value = next;
  if (scroll) { input.setSelectionRange(next.length, next.length); input.scrollLeft = input.scrollWidth; }
  await frames(2);
  const want = await tileOf(m);
  const before = diffFraction(old, want);
  const plan = overlayOver(m, old, input);
  assert.ok(plan, 'a plain focused text field has a plan');
  return { got: diffFraction(old, want), before, plan, input };
}

test('appending text: the overlay matches the next tile (<= 0.5 % of the tile differs by > 16 levels)', async () => {
  const r = await fidelity('Hello wor', 'Hello world, typed');
  assert.ok(r.before > 0.003, `control: the old tile differs from the new one (${(r.before * 100).toFixed(2)} %)`);
  assert.ok(r.got <= 0.005, `overlay vs new tile ${(r.got * 100).toFixed(3)} % (old tile ${(r.before * 100).toFixed(2)} %)`);
});

test('dark field: the backdrop is the field background', async () => {
  const r = await fidelity('night', 'night mode on', { cls: 'i dark' });
  assert.ok(r.got <= 0.005, `overlay vs new tile ${(r.got * 100).toFixed(3)} %`);
  assert.equal(r.plan.fill, 'rgba(29,35,48,1)');
});

test('scrolled text: the overlay follows scrollLeft', async () => {
  const long = 'The quick brown fox jumps over the lazy dog and keeps running';
  const r = await fidelity(long, long + ' far away', { scroll: true });
  assert.ok(r.input.scrollLeft > 50, `the text scrolls (${r.input.scrollLeft})`);
  assert.ok(r.got <= 0.006, `overlay vs new tile ${(r.got * 100).toFixed(3)} % (old ${(r.before * 100).toFixed(2)} %)`);
});

for (const type of ['email', 'password', 'url', 'tel']) {
  test(`type=${type}: planned and faithful`, async () => {
    const m = mount(html('ab', `type="${type}"`), { css });
    const input = m.layerEl.querySelector('input');
    input.focus();
    await frames(2);
    const old = await tileOf(m);
    input.value = 'abc.def@example';
    await frames(2);
    const want = await tileOf(m);
    const plan = overlayOver(m, old, input);
    assert.ok(plan, `type=${type} has a plan`);
    assert.ok(diffFraction(old, want) <= 0.006, `type=${type}: overlay vs new tile ${(diffFraction(old, want) * 100).toFixed(3)} %`);
  });
}

const refusals = [
  ['an empty value (the placeholder shows)', (i) => { i.value = ''; }],
  ['a non-collapsed selection', (i) => { i.setSelectionRange(0, 3); }],
  ['right-to-left text', (i) => { i.value = 'abc אב'; }],
  ['a text shadow', (i) => { i.style.textShadow = '1px 1px red'; }],
  ['a filtered field', (i) => { i.style.filter = 'blur(1px)'; }],
  ['a rotated ancestor', (i) => { i.parentElement.style.transform = 'rotate(1deg)'; }],
  ['a field that is not focused', (i) => { i.blur(); }],
  ['a translucent field', (i) => { i.style.opacity = '0.5'; }],
  ['something painted over the text', (i) => { const d = document.createElement('span'); d.style.cssText = 'position:absolute;left:20px;top:14px;width:30px;height:12px;background:red'; i.parentElement.append(d); }],
  ['a number field (spin buttons in the content box)', (i) => { i.type = 'number'; i.value = '12'; }],
  ['a search field (its cancel button cannot be measured)', (i) => { i.type = 'search'; }],
  ['a read-only field', (i) => { i.readOnly = true; }],
];
for (const [what, change] of refusals) {
  test(`no plan for ${what}`, async () => {
    const m = mount(html('typed text'), { css });
    const input = m.layerEl.querySelector('input');
    input.focus();
    await frames(1);
    assert.ok(planTextOverlay(document, input, m.layerEl.firstElementChild, m.layer.frameRect(input)), 'control: planned before the change');
    change(input);
    await frames(1);
    assert.equal(planTextOverlay(document, input, m.layerEl.firstElementChild, m.layer.frameRect(input), 1), null);
  });
}

test('glass field over a gradient (F1 look): no solid colour, the backdrop tile (text made transparent) makes the overlay exact', async () => {
  const glass = css + '.g{background:linear-gradient(150deg,rgba(8,25,48,.82),rgba(4,13,28,.66))}.i.glass{background:rgba(1,10,23,.55);color:#effcff;border-radius:13px;box-shadow:inset 0 1px 0 rgba(255,255,255,.025)}';
  const m = mount('<div class="d g" drawable><input class="i glass" value="WebGPU inter"></div>', { css: glass });
  const input = m.layerEl.querySelector('input');
  const drawable = m.layerEl.firstElementChild;
  input.focus();
  await frames(2);
  const old = await tileOf(m);
  input.value = 'WebGPU interface typed';
  await frames(2);
  const want = await tileOf(m);
  const plan = planTextOverlay(document, input, drawable, m.layer.frameRect(input));
  assert.ok(plan, 'planned');
  assert.equal(plan.fill, null, 'not a solid backdrop');
  const size = m.layer.borderBoxSize(drawable);
  const geo = { bw: size.width, bh: size.height, scale: S, reduced: false, ink: { left: 0, top: 0, right: 0, bottom: 0 }, widthPx: old.canvas.width, heightPx: old.canvas.height };
  const r = overlayRectPx(plan, geo);
  assert.equal(paintTextOverlay(old.canvas, geo, plan, null), false, 'no backdrop yet: nothing painted');
  const pad = await rasterize(m.capture({ ...m.request(drawable, { scale: S, rect: { x: r.x / S, y: r.y / S, width: r.width / S, height: r.height / S } }), hideText: input }));
  const before = diffFraction(old, want);
  assert.ok(paintTextOverlay(old.canvas, geo, plan, pad.canvas));
  const got = diffFraction(old, want);
  assert.ok(before > 0.003, `control ${(before * 100).toFixed(2)} %`);
  assert.ok(got <= 0.005, `overlay vs new tile ${(got * 100).toFixed(3)} % (old ${(before * 100).toFixed(2)} %)`);
});
