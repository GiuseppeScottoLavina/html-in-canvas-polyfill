// Gate finding (G-explainer / G-f1-form typing latency): once typing scrolled the text inside a field, the tile still showed the START of the value, so a keystroke changed no pixel until the next caret blink.
import { test, assert, frames } from '/test/unit/lib/t.js';
import { mount, rasterize, diffFraction, inkFraction } from './_support.mjs';
import { planTextOverlay } from '/src/snapshot/capture/text-overlay.js';

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

// Chrome 157 reports an input's client box as its CONTENT box on the inline axis (clientWidth 88, clientLeft 6, scrollWidth 240 for a 100 px border box with 2 px borders,
// 4 px padding and 240 px of text; Chrome 156 and earlier: the padding box, 96, 2, 248). The capture read the difference as a scrollbar gutter (the scrolled clone got 8 px more right padding and clipped
// the last glyph) and the text overlay planned a content box 12 px too narrow. The tests below make any engine report the content box, so the case runs everywhere.
/** @param {HTMLInputElement} el @returns {boolean} true when the client box had to be emulated (the engine reports the padding box) */
function reportContentBox(el) {
  const cs = getComputedStyle(el);
  const p = (/** @type {string} */ v) => parseFloat(v) || 0;
  const padX = p(cs.paddingLeft) + p(cs.paddingRight);
  if (Math.abs(el.clientWidth - (el.offsetWidth - p(cs.borderLeftWidth) - p(cs.borderRightWidth))) > 0.5) return false;
  const native = (/** @type {string} */ k) => Object.getOwnPropertyDescriptor(Element.prototype, k).get.call(el);
  // the inline axis only: Chrome 157 keeps clientHeight / clientTop the padding box's (measured: 100 x 29 field, 2 px borders, 3 px / 4 px padding: client 88 x 25 at 6, 2)
  for (const [k, d] of [['clientWidth', -padX], ['scrollWidth', -padX], ['clientLeft', p(cs.paddingLeft)]]) Object.defineProperty(el, k, { configurable: true, get: () => native(k) + d });
  return true;
}

/** fraction of differing pixels inside columns [x0, x1) of two tiles */
function stripDiff(a, b, x0, x1) {
  const crop = (x) => { const c = document.createElement('canvas').getContext('2d', { willReadFrequently: true }); c.canvas.width = x1 - x0; c.canvas.height = x.canvas.height; c.drawImage(x.canvas, -x0, 0); return c; };
  return diffFraction(crop(a), crop(b));
}

test('an engine reporting the content box as an input\'s client box (Chrome 157): the scrolled clone gets no gutter, the glyph at the right edge is drawn', async () => {
  // 20 W of 12 px, scrolled by 12 of them: the 88 px content box shows exactly the last 8 (the last one up to its 4th px), like a field holding only those 8
  const head = 'W'.repeat(12), tail = 'W'.repeat(8);
  const m = mount(html(head + tail), { css });
  const input = m.layerEl.querySelector('input');
  const emulated = reportContentBox(input);
  assert.equal(input.clientWidth, 88, `content box reported (emulated: ${emulated})`);
  input.scrollLeft = Math.round(charWidth() * head.length);
  await frames(2);
  const got = await tileOf(m);
  const ref = await tileOf(mount(html(tail), { css }));
  // the right 12 px of the content box (the field's content ends at 4 + 2 + 4 + 88 = 98 px of the tile)
  const edge = [86, 98];
  assert.ok(inkFraction(got) > 0.02);
  const clipped = await tileOf(mount(html(tail), { css: css + '.i{padding-right:12px}' }));
  assert.ok(stripDiff(clipped, ref, ...edge) > 0.05, `control: an 8 px gutter at the right edge is seen (${(stripDiff(clipped, ref, ...edge) * 100).toFixed(1)} %)`);
  assert.ok(stripDiff(got, ref, ...edge) <= 0.01, `right edge of the scrolled field vs the tail-only field ${(stripDiff(got, ref, ...edge) * 100).toFixed(2)} %`);
});

test('an engine reporting the content box as an input\'s client box (Chrome 157): the text overlay plans the real content box, caret and baseline', async () => {
  const css2 = '.d{width:320px;height:60px;background:#fff;padding:8px;box-sizing:border-box}.i{width:220px;font:16px Arial,sans-serif;padding:4px 6px;border:1px solid #888;background:#fff;color:#123}';
  const long = 'The quick brown fox jumps over the lazy dog and keeps running far away';
  const plan = async (emulate) => {
    const m = mount(`<div class="d" drawable><input class="i" value="${long}"></div>`, { css: css2 });
    const input = m.layerEl.querySelector('input');
    if (emulate) assert.equal((reportContentBox(input), input.clientWidth), 220, 'content box reported');
    input.focus();
    input.setSelectionRange(long.length, long.length);
    input.scrollLeft = input.scrollWidth;
    await frames(2);
    return planTextOverlay(document, input, m.layerEl.firstElementChild, m.layer.frameRect(input));
  };
  const got = await plan(true);
  const native = await plan(false);
  assert.ok(got && native, 'planned');
  assert.deepEqual(got.box, { x: 8 + 1 + 6, y: native.box.y, width: 220, height: native.box.height }, 'the content box: 220 px wide, as high as the engine\'s own');
  assert.ok(Math.abs(native.box.width - 220) < 0.01 && native.box.height > 16, `the engine's own plan: ${JSON.stringify(native.box)}`);
  assert.ok(Math.abs(got.caret.rect.y - native.caret.rect.y) < 0.01 && Math.abs(got.baseline - native.baseline) < 0.01, `caret ${got.caret.rect.y} / ${native.caret.rect.y}, baseline ${got.baseline} / ${native.baseline}`);
  assert.ok(Math.abs(got.x - native.x) < 0.01 && Math.abs(got.caret.rect.x - native.caret.rect.x) < 0.01, 'same scroll offset and caret x');
});
