// The scroll compositor's cover tiles (CaptureRequest.scroll shape 'cover', ScrollPlan.cover): one capture renders the scroller without its content in each colour of
// `fills`, one tile each (CaptureResult.urls). The tile of each further colour comes from the same clone with only the scroller's background colour changed, so it must
// be exactly the tile a capture of its own with that one colour makes: the same markup, whatever the scroller declares itself (its own background, an inline
// !important one, a classic bar painted as background images after the fill, a rounded corner).
import { test, assert, frames } from '/test/unit/lib/t.js';
import { mount, rasterize } from './_support.mjs';

const A = 'rgb(1,254,3)';
const B = 'rgb(254,1,252)';
const rows = Array.from({ length: 80 }, (_, i) => `<div class="row">Row ${i} amber fjord kelp</div>`).join('');

/** @param {any} m @param {Element} list @param {string[]} fills */
const coverOf = (m, list, fills) => m.capture({ ...m.request(m.layerEl.firstElementChild, { scale: 2, prune: true }), scroll: { el: list, top: list.scrollTop, hide: [], shape: 'cover', fills } });

for (const [what, listCss, attr] of [
  ['a list without a background of its own', 'scrollbar-width:none', ''],
  ['a list with its own background and a rounded corner', 'scrollbar-width:none;background:linear-gradient(#123,#456);border-radius:12px', ''],
  ['a list with an inline !important background', 'scrollbar-width:none', ' style="background:rgb(9,9,9)!important"'],
  ['a list with a classic bar (painted as background images after the fill)', 'scrollbar-width:auto;scrollbar-color:#888 #ddd', ''],
]) {
  test(`cover fills, ${what}: each further tile is byte for byte the tile of a capture with that colour alone, and shows it`, async () => {
    const m = mount(`<div class="d" drawable><div class="bar">bar</div><div class="list"${attr}>${rows}</div></div>`, {
      css: `.d{width:300px;height:220px;background:#fff;font:14px Arial}.bar{height:20px}.list{height:200px;overflow:auto;${listCss}}.row{height:30px}`, width: 320, height: 240,
    });
    await frames(2);
    const list = /** @type {HTMLElement} */ (m.layerEl.querySelector('.list'));
    list.scrollTop = 45;
    const both = coverOf(m, list, [A, B]);
    assert.equal(both.urls?.length, 2, 'a tile per fill');
    assert.equal(both.urls[0], both.url, 'the first is the url');
    assert.ok(both.urls[0] !== both.urls[1], 'control: the two tiles differ');
    assert.equal(both.urls[0], coverOf(m, list, [A]).url, 'the first colour, as captured alone');
    assert.equal(both.urls[1], coverOf(m, list, [B]).url, 'the second colour, as captured alone');
    assert.equal(coverOf(m, list, [B, A]).urls[1], both.urls[0], 'and in the other order');
    // the port shows each colour where nothing else paints (its centre)
    const r = list.getBoundingClientRect(), d = m.layerEl.firstElementChild.getBoundingClientRect();
    const at = [Math.round((r.left - d.left + r.width / 2) * 2), Math.round((r.top - d.top + r.height / 2) * 2)];
    const px = async (/** @type {string} */ url) => [...(await rasterize({ ...both, url })).getImageData(at[0], at[1], 1, 1).data];
    // (the fill is declared after the scroller's own inline declarations: it wins over an !important one too)
    assert.deepEqual(await px(both.urls[0]), [1, 254, 3, 255]);
    assert.deepEqual(await px(both.urls[1]), [254, 1, 252, 255]);
  });
}

test('cover fills: a request that is not a cover gives no urls; a cover of one colour gives one', async () => {
  const m = mount(`<div class="d" drawable><div class="list">${rows}</div></div>`, { css: '.d{width:300px;height:200px}.list{height:200px;overflow:auto}.row{height:30px}', width: 320, height: 220 });
  await frames(2);
  const list = /** @type {HTMLElement} */ (m.layerEl.querySelector('.list'));
  assert.equal(m.capture({ ...m.request(m.layerEl.firstElementChild, { scale: 1 }), scroll: { el: list, top: 0, hide: [], shape: 'backdrop' } }).urls, undefined);
  assert.equal(coverOf(m, list, [A]).urls?.length, 1);
});
