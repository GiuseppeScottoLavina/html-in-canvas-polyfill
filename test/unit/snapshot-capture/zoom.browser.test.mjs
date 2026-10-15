// A page that zooms the canvas (CSS `zoom` on html / body, on a wrapper, on the canvas itself) while the canvas grid is NOT at that zoom: the tile is planned in the canvas's
// css px at the grid scale, and the zoom the collected CSS gives the clone root (`body` is rewritten onto it) or an ancestor shell scaled it a second time (WPT basic-rect-zoom
// when its first snapshot landed before the test wrote canvas.width: the green square was drawn twice too large, only its corner visible). Native (Canary) draws 50 px here.
import { test, assert } from '/test/unit/lib/t.js';
import { inst, sleep } from '../api-core/_real.mjs';

/** @param {any} t @param {string} css @param {number} w canvas grid width (css width 100) @returns {Promise<string>} the x range of green canvas pixels */
async function greenRange(t, css, w) {
  inst(t);
  const host = document.createElement('div');
  host.innerHTML = `<style>${css}</style><div id="zw"><canvas id="zc" width="${w}" height="${w}" content="drawable" style="width:100px;height:100px;display:block">`
    + '<div drawable id="zk" style="width:50px;height:50px;background:rgb(0,128,0)"></div></canvas></div>';
  document.body.append(host);
  t.cleanup(() => host.remove());
  const c = /** @type {HTMLCanvasElement} */ (host.querySelector('canvas'));
  await new Promise((r) => { c.addEventListener('paint', r, { once: true }); /** @type {any} */ (c).requestPaint(); });
  await sleep(150);
  const ctx = /** @type {any} */ (c.getContext('2d'));
  ctx.reset();
  ctx.drawElementImage(host.querySelector('#zk'), 0, 0);
  const d = ctx.getImageData(0, 0, c.width, 1 + Math.floor(c.height / 4)).data;
  let lo = Infinity; let hi = -1;
  const y = Math.floor(c.height / 8);
  for (let x = 0; x < c.width; x++) { const i = (y * c.width + x) * 4; if (d[i + 1] > 100 && d[i] < 50) { lo = Math.min(lo, x); hi = Math.max(hi, x); } }
  return `${lo}..${hi}`;
}

test('a zoomed wrapper does not zoom the tile again (grid at 1 css px per canvas px)', async (t) => {
  assert.equal(await greenRange(t, '#zw{zoom:2}', 100), '0..49');
});

test('a zoomed canvas does not zoom its drawables in the tile', async (t) => {
  assert.equal(await greenRange(t, '#zc{zoom:2}', 100), '0..49');
});

test('a zoomed wrapper at a grid of 2 canvas px per css px (root zoom 2 times the shell zoom 2 was 4), and an unzoomed page', async (t) => {
  assert.equal(await greenRange(t, '#zw{zoom:2}', 200), '0..99');
  assert.equal(await greenRange(t, '', 100), '0..49');
});
