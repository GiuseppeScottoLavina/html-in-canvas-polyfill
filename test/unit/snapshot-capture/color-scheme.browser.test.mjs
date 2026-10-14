// Gate finding (G-f1-form after interaction): a page that is dark through <meta name="color-scheme"> drew light form controls in the clone.
import { test, assert } from '/test/unit/lib/t.js';
import { mount, rasterize } from './_support.mjs';

const centre = async (m) => {
  const box = m.layerEl.querySelector('input').getBoundingClientRect();
  const base = m.layerEl.getBoundingClientRect();
  const x = await rasterize(m.capture(m.request(m.layerEl.firstElementChild)));
  return [...x.getImageData(Math.round(box.left - base.left + 6), Math.round(box.top - base.top + 6), 1, 1).data].slice(0, 3);
};
const html = '<div class="s" drawable><input type="checkbox" style="margin:4px"></div>';
const css = '.s{width:60px;height:30px;background:#222}';

test('a meta color-scheme dark page draws an unchecked checkbox dark in the clone (control: without the meta it is light)', async (t) => {
  const light = await centre(mount(html, { css }));
  assert.ok(light.every((v) => v > 200), `control: light checkbox expected, got ${light}`);
  const meta = document.createElement('meta');
  meta.name = 'color-scheme';
  meta.content = 'dark';
  document.head.append(meta);
  t.cleanup(() => meta.remove());
  const dark = await centre(mount(html, { css }));
  assert.ok(dark.every((v) => v < 120), `dark checkbox expected, got ${dark}`);
});

test('an explicit computed color-scheme wins over the meta', async (t) => {
  const meta = document.createElement('meta');
  meta.name = 'color-scheme';
  meta.content = 'dark';
  document.head.append(meta);
  t.cleanup(() => meta.remove());
  const m = mount(html, { css, layerStyle: 'color-scheme:light' });
  const c = await centre(m);
  assert.ok(c.every((v) => v > 200), `light expected, got ${c}`);
});

test('a hovered range slider is drawn with the engine hover accent (lightened ~42 % towards white); at rest with the plain accent', async (t) => {
  const meta = document.createElement('meta');
  meta.name = 'color-scheme';
  meta.content = 'dark';
  document.head.append(meta);
  t.cleanup(() => meta.remove());
  const m = mount('<div class="s" drawable><input type="range" min="0" max="100" value="90" style="width:160px;margin:6px;accent-color:#79efff"></div>', { css: '.s{width:200px;height:40px;background:#06101e}' });
  const input = m.layerEl.querySelector('input');
  const box = input.getBoundingClientRect();
  const base = m.layerEl.getBoundingClientRect();
  const at = { x: Math.round(box.left - base.left + 30), y: Math.round(box.top - base.top + box.height / 2) };
  const sample = async (hover) => {
    const r = m.capture(m.request(m.layerEl.firstElementChild, { interaction: { hover, active: new Set(), focus: null, focusVisible: false, caretVisible: true } }));
    return [...(await rasterize(r)).getImageData(at.x, at.y, 1, 1).data].slice(0, 3);
  };
  const rest = await sample(new Set());
  const hover = await sample(new Set([input]));
  assert.ok(rest.every((v, i) => Math.abs(v - [121, 239, 255][i]) <= 8), `rest accent ${rest}`);
  assert.ok(hover.every((v, i) => Math.abs(v - [177, 246, 255][i]) <= 8), `hover accent ${hover}`);
});
