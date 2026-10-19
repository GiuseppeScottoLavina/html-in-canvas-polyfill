// Scroll synchronisation (live/scroll-sync.js, wired by the scroll observer): a live scroller inside a drawable carries data-hic-scroll while the pointer is over it or it
// scrolls; the polyfill rule gives it a transparent inset shadow and a transparent local image AFTER the author's own values, nothing reaches the author's style
// attribute or a snapshot, and everything is gone after uninstall. (That the compositor then waits for the main frame is measured by G-scroll-cadence.)
import { test, assert } from '/test/unit/lib/t.js';
import { inst, sleep } from '../api-core/_real.mjs';

async function page(t, listStyle = '', css = '') {
  const i = inst(t);
  const host = document.createElement('div');
  host.innerHTML = `${css ? `<style>${css}</style>` : ''}<canvas content="drawable" width="300" height="200" style="display:block;width:300px;height:200px"><div id="sd" drawable style="width:300px;height:200px">`
    + `<div id="sl" style="height:150px;overflow:auto;${listStyle}">${'<p style="margin:0;height:30px">row</p>'.repeat(30)}</div></div></canvas>`;
  document.body.append(host);
  t.cleanup(() => host.remove());
  const canvas = /** @type {HTMLCanvasElement} */ (host.querySelector('canvas'));
  const ctx = /** @type {any} */ (canvas.getContext('2d'));
  canvas.onpaint = () => { ctx.reset(); ctx.drawElementImage(host.querySelector('#sd'), 0, 0); };
  canvas.requestPaint();
  await sleep(150);
  return { i, canvas, ctx, list: /** @type {HTMLElement} */ (host.querySelector('#sl')) };
}

const over = (el) => el.firstElementChild.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, composed: true }));
const out = (el) => el.firstElementChild.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, composed: true, relatedTarget: document.body }));
/** @param {HTMLElement} el @returns {string[]} the transition events el receives from now on */
function transitionEvents(el) {
  const seen = [];
  for (const n of ['transitionrun', 'transitionstart', 'transitionend', 'transitioncancel']) el.addEventListener(n, (e) => seen.push(`${n}:${/** @type {TransitionEvent} */ (e).propertyName}`));
  return seen;
}

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

test('an author transition on all (or box-shadow) sees no transition from the synchronisation, neither when it starts nor when it ends', async (t) => {
  const { list } = await page(t, 'transition:all .2s');
  const seen = transitionEvents(list);
  over(list);
  assert.ok(list.hasAttribute('data-hic-scroll'), 'marked');
  assert.equal(list.getAnimations().length, 0, 'no transition runs');
  await sleep(300);
  out(list);
  assert.equal(list.hasAttribute('data-hic-scroll'), false, 'released');
  assert.equal(list.getAnimations().length, 0, 'none on release either');
  await sleep(300);
  assert.deepEqual(seen, []);
  // the author's own transitions still run (positive control: the listener sees them)
  list.style.opacity = '0.5';
  await sleep(300);
  assert.ok(seen.includes('transitionend:opacity'), seen.join());
});

test('the added bottom layer keeps the clip of the background colour', async (t) => {
  const gif = 'url(data:image/gif;base64,R0lGODlhAQABAAAAACw=)';
  const { list } = await page(t, `background:${gif} no-repeat, ${gif} no-repeat rgb(0, 128, 0);background-clip:content-box, padding-box;padding:6px;border:4px solid transparent`);
  over(list);
  assert.ok(list.hasAttribute('data-hic-scroll'));
  // the colour is clipped by the bottom layer: the second (padding-box), not the first that a cycled list would give the added third layer
  assert.equal(getComputedStyle(list).backgroundClip, 'content-box, padding-box, padding-box');
});

test('a scroller whose shadow or background is animated is not synchronised; an animation that starts while synchronised ends it at the next pointer or scroll step', async (t) => {
  const css = '@keyframes hic-glow{from{box-shadow:0 0 0 0 rgb(255, 0, 0)}to{box-shadow:0 0 8px 2px rgb(255, 0, 0)}}.glow{animation:hic-glow 1s infinite alternate}';
  const { list } = await page(t, '', css);
  list.classList.add('glow');
  over(list);
  assert.equal(list.hasAttribute('data-hic-scroll'), false, 'animated: left alone');
  list.classList.remove('glow');
  over(list);
  assert.ok(list.hasAttribute('data-hic-scroll'), 'the animation is gone: synchronised');
  list.classList.add('glow');
  over(list);
  assert.equal(list.hasAttribute('data-hic-scroll'), false, 'released: the rule would hold the animation still');
});

test('a shadow host or a slotted scroller is not synchronised (the snapshot copies their computed style)', async (t) => {
  const { list } = await page(t);
  list.attachShadow({ mode: 'open' }).innerHTML = '<slot></slot>';
  over(list);
  assert.equal(list.hasAttribute('data-hic-scroll'), false);
});

test('the canvas pixels are the same with and without the synchronisation; an author change of the same properties is seen (positive control)', async (t) => {
  const { i, canvas, ctx, list } = await page(t, 'box-shadow:0 0 6px rgb(255, 0, 0);background:linear-gradient(#eef, #fee);border-radius:8px;border:2px solid #888', '.inset{box-shadow:inset 0 0 0 6px rgb(0, 0, 255)!important}');
  const row = /** @type {HTMLElement} */ (list.children[3]);
  /** a new snapshot of the current state: a content change, the build, a paint */
  const shot = async (text) => { row.textContent = text; await sleep(250); canvas.requestPaint(); await i.whenPainted(canvas); return ctx.getImageData(0, 0, 300, 200).data; };
  const diff = (a, b) => { let n = 0; for (let k = 0; k < a.length; k += 4) if (Math.abs(a[k] - b[k]) + Math.abs(a[k + 1] - b[k + 1]) + Math.abs(a[k + 2] - b[k + 2]) + Math.abs(a[k + 3] - b[k + 3]) > 8) n++; return n; };
  list.scrollTop = 40;
  const plain = await shot('row A');
  over(list);
  assert.ok(list.hasAttribute('data-hic-scroll'));
  assert.ok(diff(plain, await shot('row B')) > 0, 'a rebuild while synchronised is drawn (the changed row)');
  const synced = await shot('row A');
  let ink = 0; for (let k = 3; k < synced.length; k += 4) if (synced[k]) ink++;
  assert.ok(ink > 40000, `the canvas shows the scroller (${ink} px)`);
  assert.equal(diff(plain, synced), 0, 'nothing of the synchronisation reaches the canvas');
  list.classList.add('inset');
  assert.ok(diff(plain, await shot('row A')) > 500, 'an author inset shadow added while synchronised is seen');
});
