// The focus ring of a focused image-map <area> is painted over the <img> of a drawable that uses the map, in the area's (unvisited) outline colour, and goes when the
// area loses focus (WPT privacy/visited-link/image-map-area-visited-color-ignored).
import { test, assert } from '/test/unit/lib/t.js';
import { inst, sleep } from './_real.mjs';

test('a focused <area> draws its outline over the <img> that uses its map; blurred, the image is plain again', async (t) => {
  const i = inst(t);
  const host = document.createElement('div');
  host.innerHTML = '<style>area{outline:solid 6px rgb(0,128,0)}</style>'
    + '<canvas content="drawable" width="100" height="100"><div drawable id="d"><img usemap="#m" src="/test/vendor/wpt/images/blue.png" width="100" height="100" style="display:block"></div></canvas>'
    + '<map name="m"><area id="ar" href="#x" shape="rect" coords="20,20,80,80"></map>';
  document.body.append(host);
  t.cleanup(() => host.remove());
  const c = /** @type {HTMLCanvasElement} */ (host.querySelector('canvas'));
  const ctx = /** @type {any} */ (c.getContext('2d'));
  c.onpaint = () => { ctx.clearRect(0, 0, 100, 100); ctx.drawElementImage(host.querySelector('#d'), 0, 0); };
  c.requestPaint();
  await i.whenPainted(c);
  await sleep(300);
  const px = (/** @type {number} */ x, /** @type {number} */ y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
  assert.deepEqual(px(17, 50), [0, 0, 255, 255], 'control: no ring before the focus');
  /** @type {HTMLElement} */ (host.querySelector('#ar')).focus();
  await sleep(400);
  assert.deepEqual(px(17, 50), [0, 128, 0, 255], 'the outline, outside the area rect (6 px wide)');
  assert.deepEqual(px(50, 50), [0, 0, 255, 255], 'the image inside');
  /** @type {HTMLElement} */ (host.querySelector('#ar')).blur();
  await sleep(400);
  assert.deepEqual(px(17, 50), [0, 0, 255, 255], 'blurred: the ring is gone');
});
