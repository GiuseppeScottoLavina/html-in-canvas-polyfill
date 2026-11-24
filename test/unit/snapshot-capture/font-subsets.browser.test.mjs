import { test, assert } from '/test/unit/lib/t.js';
import { mount } from './_support.mjs';

const css = '@font-face{font-family:Split;src:local(Arial);unicode-range:U+0000-00FF}'
  + '@font-face{font-family:Split;src:local(Arial);unicode-range:U+0E01-0E5B}'
  + '.d{font-family:Split;display:block;width:180px;height:80px}.d *{font:inherit}';
const faces = result => (decodeURIComponent(result.url).match(/@font-face/gi) || []).length;

test('the current field value and flattened shadow text determine the faces of each newly captured tile', () => {
  const m = mount('<div class="d" lang="en" drawable><input value="first"><span class="host"></span></div>', { css });
  const root = m.layerEl.firstElementChild, input = root.querySelector('input');
  const shadow = root.querySelector('.host').attachShadow({ mode: 'open' });
  shadow.textContent = 'ASCII';
  const grab = () => faces(m.capture(m.request(root, { rect: {x:0, y:0, width:180, height:70} })));
  assert.equal(grab(), 1);
  root.lang = 'it';
  input.value = 'È già pronto';
  assert.equal(grab(), 1);
  input.value = 'ชุด';
  assert.equal(grab(), 2);
  input.value = 'Scout';
  assert.equal(grab(), 1);
  shadow.textContent = 'ภาษาไทย';
  assert.equal(grab(), 2);
});

test('generated characters not present as DOM text retain their font range', () => {
  const m = mount('<p drawable class="d" lang="en">ASCII</p>', {css: css + '.d::after{content:"\\e01"}'});
  assert.equal(faces(m.capture(m.request(m.layerEl.firstElementChild))), 2);
});
