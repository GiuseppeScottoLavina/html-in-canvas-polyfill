// Scroll synchronisation (live/scroll-sync.js, wired by the scroll observer): a live scroller inside a drawable carries data-hic-scroll while the pointer is over it or it
// scrolls; the polyfill rule gives it a transparent inset shadow and a transparent local image AFTER the author's own values, nothing reaches the author's style
// attribute or a snapshot, and everything is gone after uninstall. (That the compositor then waits for the main frame is measured by G-scroll-cadence.)
import { test, assert } from '/test/unit/lib/t.js';
import { inst, sleep } from '../api-core/_real.mjs';

async function page(t, listStyle = '') {
  const i = inst(t);
  const host = document.createElement('div');
  host.innerHTML = `<canvas content="drawable" width="300" height="200" style="display:block;width:300px;height:200px"><div id="sd" drawable style="width:300px;height:200px">`
    + `<div id="sl" style="height:150px;overflow:auto;${listStyle}">${'<p style="margin:0;height:30px">row</p>'.repeat(30)}</div></div></canvas>`;
  document.body.append(host);
  t.cleanup(() => host.remove());
  const canvas = /** @type {HTMLCanvasElement} */ (host.querySelector('canvas'));
  const ctx = /** @type {any} */ (canvas.getContext('2d'));
  canvas.onpaint = () => { ctx.reset(); ctx.drawElementImage(host.querySelector('#sd'), 0, 0); };
  canvas.requestPaint();
  await sleep(150);
  return { i, list: /** @type {HTMLElement} */ (host.querySelector('#sl')) };
}

const over = (el) => el.firstElementChild.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, composed: true }));

test('a scroller under the pointer is synchronised; the author values come first; released when the pointer leaves', async (t) => {
  const { list } = await page(t, 'box-shadow:0 0 4px rgb(255, 0, 0);background-image:linear-gradient(red, blue)');
  const before = getComputedStyle(list);
  const author = { shadow: before.boxShadow, image: before.backgroundImage };
  over(list);
  assert.ok(list.hasAttribute('data-hic-scroll'), 'marked');
  assert.equal(list.getAttribute('style').includes('inset'), false, 'never through the style attribute');
  const cs = getComputedStyle(list);
  assert.ok(cs.boxShadow.startsWith(author.shadow) && / inset$/.test(cs.boxShadow), cs.boxShadow);
  assert.ok(cs.backgroundImage.startsWith(author.image + ', linear-gradient'), cs.backgroundImage);
  assert.equal(cs.backgroundAttachment, 'scroll, local');
  list.firstElementChild.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, composed: true, relatedTarget: document.body }));
  assert.equal(list.hasAttribute('data-hic-scroll'), false, 'released');
  assert.equal(getComputedStyle(list).boxShadow, author.shadow);
});

test('a scroll event synchronises the scroller until the scrolling settles; uninstall leaves nothing', async (t) => {
  const { i, list } = await page(t);
  list.scrollTop = 60;
  await sleep(30);
  assert.ok(list.hasAttribute('data-hic-scroll'), 'marked by its scroll event');
  await sleep(250);
  assert.equal(list.hasAttribute('data-hic-scroll'), false, 'released once settled (the pointer is not over it)');
  over(list);
  assert.ok(list.hasAttribute('data-hic-scroll'));
  i.uninstall();
  assert.equal(list.hasAttribute('data-hic-scroll'), false, 'uninstall removed the attribute');
  assert.equal(getComputedStyle(list).boxShadow, 'none');
});

test('an element that does not scroll is left alone', async (t) => {
  const { list } = await page(t, 'height:auto');
  over(list);
  assert.equal(list.hasAttribute('data-hic-scroll'), false, 'not a scroller: nothing to synchronise');
});
