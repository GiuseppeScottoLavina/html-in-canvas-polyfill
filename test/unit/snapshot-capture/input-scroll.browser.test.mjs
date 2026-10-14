// Gate finding (G-explainer / G-f1-form typing latency): once typing scrolled the text inside a field, the tile still showed the START of the value, so a keystroke changed no pixel until the next caret blink.
import { test, assert, frames } from '/test/unit/lib/t.js';
import { mount, rasterize, diffFraction, inkFraction } from './_support.mjs';

const css = '.d{width:200px;height:40px;background:#fff}.i{width:100px;font:20px "Courier New",monospace;box-sizing:border-box;margin:4px;padding:2px 4px}';
const html = (v) => `<div class="d" drawable><input class="i" value="${v}"></div>`;
const charWidth = () => { const c = document.createElement('canvas').getContext('2d'); c.font = '20px "Courier New", monospace'; return c.measureText('W').width; };
const tileOf = async (m) => rasterize(m.capture(m.request(m.layerEl.firstElementChild)));

test('a scrolled text field is drawn scrolled: the tile equals the field holding only the visible tail', async () => {
  const head = 'W'.repeat(12);
  const tail = 'wiiw'.repeat(8);
  const m = mount(html(head + tail), { css });
  const input = m.layerEl.querySelector('input');
  input.scrollLeft = Math.round(charWidth() * head.length);
  await frames(2);
  assert.ok(input.scrollLeft > 100, `live scrollLeft ${input.scrollLeft}`);
  const got = await tileOf(m);
  const ref = await tileOf(mount(html(tail), { css }));
  assert.ok(inkFraction(got) > 0.02);
  assert.ok(diffFraction(got, ref) <= 0.02, `scrolled tile differs from the tail-only field by ${(diffFraction(got, ref) * 100).toFixed(2)} %`);
  const unscrolled = await tileOf(mount(html(head + tail), { css }));
  assert.ok(diffFraction(got, unscrolled) > 0.03, 'control: the unscrolled field looks different');
});

test('typing while the text scrolls changes the pixels of every capture (the caret alone is not the only change)', async () => {
  const m = mount(html('x'.repeat(20)), { css });
  const input = m.layerEl.querySelector('input');
  const frameOf = async () => { input.scrollLeft = input.scrollWidth; await frames(2); return tileOf(m); };
  const a = await frameOf();
  input.value += 'Q';
  const b = await frameOf();
  assert.ok(diffFraction(a, b) > 0.005, `a keystroke at the scrolled end changed ${(diffFraction(a, b) * 100).toFixed(2)} %`);
});
