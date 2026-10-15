// A sticky drawable nested in a drawable moves inside the live layer when the PAGE scrolls; the hit-test correction is re-measured from the scroll event (live-layer.js
// syncScrollWatch), so elementsFromPoint at the place the app draws it keeps returning it. The trusted-input version is the G-regress-pagescroll gate.
import { test, assert } from '/test/unit/lib/t.js';
import { inst, sleep } from '../api-core/_real.mjs';

/** @param {any} t @param {boolean} sticky */
async function page(t, sticky) {
  inst(t);
  const host = document.createElement('div');
  host.innerHTML = '<div style="height:100px"></div><canvas content="drawable" width="400" height="600" style="display:block;width:400px;height:600px"><div id="po" drawable style="width:400px;height:600px;background:#eee">'
    + `<button id="ps" drawable style="display:block;width:120px;height:40px;margin:0;top:0;${sticky ? 'position:sticky' : ''}">s</button></div></canvas><div style="height:3000px"></div>`;
  document.body.append(host);
  t.cleanup(() => { host.remove(); window.scrollTo(0, 0); });
  const canvas = /** @type {HTMLCanvasElement} */ (host.querySelector('canvas'));
  const ctx = /** @type {any} */ (canvas.getContext('2d'));
  const s = /** @type {HTMLElement} */ (host.querySelector('#ps'));
  canvas.onpaint = () => { ctx.reset(); ctx.drawElementImage(host.querySelector('#po'), 0, 0); ctx.drawElementImage(s, 20, 300); };
  canvas.requestPaint();
  await sleep(150);
  const at = () => { const r = canvas.getBoundingClientRect(); return document.elementsFromPoint(r.left + 80, r.top + 320)[0]; };
  return { canvas, s, at };
}

test('a sticky drawable stays hit-testable at its drawn place when the page scrolls', async (t) => {
  const { s, at } = await page(t, true);
  assert.equal(at(), s, 'at rest');
  const top = document.querySelector('canvas').getBoundingClientRect().top + window.scrollY;
  window.scrollTo(0, top + 100);
  await sleep(100);
  assert.equal(at(), s, 'after the page scrolled the sticky box 100 px down inside the layer');
  window.scrollTo(0, 0);
  await sleep(100);
  assert.equal(at(), s, 'back at the top');
});
