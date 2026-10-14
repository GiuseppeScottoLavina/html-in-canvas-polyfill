// Review M4: a <canvas> inside a drawable that script redraws must produce damage (nothing in the DOM changes).
import { test, assert } from '/test/unit/lib/t.js';
import { inst, sleep } from '../api-core/_real.mjs';

/** managed canvas whose only drawable holds a 60x30 child canvas filled with `first` */
async function setup(/** @type {any} */ t, /** @type {string} */ first) {
  const i = inst(t);
  const host = document.createElement('div');
  host.innerHTML = '<canvas content="drawable" width="200" height="100" style="display:block;width:200px;height:100px"><div id="d" drawable style="width:200px;height:100px;background:#fff"><canvas id="ic" width="60" height="30" style="display:block"></canvas></div></canvas>';
  document.body.append(host);
  t.cleanup(() => host.remove());
  const c = /** @type {HTMLCanvasElement} */ (host.firstElementChild);
  const ic = /** @type {HTMLCanvasElement} */ (host.querySelector('#ic'));
  const fill = (/** @type {string} */ color) => { const x = /** @type {CanvasRenderingContext2D} */ (ic.getContext('2d')); x.fillStyle = color; x.fillRect(0, 0, 60, 30); };
  fill(first);
  const d = host.querySelector('#d');
  /** @type {Element[][]} */
  const paints = [];
  c.onpaint = (e) => { paints.push([.../** @type {any} */ (e).changedElements]); /** @type {any} */ (c.getContext('2d')).drawElementImage(d, 0, 0); };
  c.requestPaint();
  await i.whenPainted(c);
  await sleep(300);
  const px = () => Array.from(/** @type {CanvasRenderingContext2D} */ (c.getContext('2d')).getImageData(30, 15, 1, 1).data.slice(0, 3));
  return { c, ic, d, fill, paints, px };
}

test('M4: redrawing a child canvas of a drawable repaints the managed canvas', async t => {
  const { fill, paints, px, d } = await setup(t, 'rgb(255,0,0)');
  assert.deepEqual(px(), [255, 0, 0], 'precondition: the red child canvas is on the managed canvas');
  paints.length = 0;
  fill('rgb(0,0,255)');
  await sleep(700);
  assert.ok(paints.some((p) => p.includes(/** @type {Element} */ (d))), 'a paint event lists the drawable');
  assert.deepEqual(px(), [0, 0, 255], 'the new child bitmap reached the managed canvas');
});

test('M4: a canvas outside any drawable causes no damage', async t => {
  const { paints } = await setup(t, 'rgb(255,0,0)');
  const stray = document.createElement('canvas');
  document.body.append(stray);
  t.cleanup(() => stray.remove());
  paints.length = 0;
  const x = /** @type {CanvasRenderingContext2D} */ (stray.getContext('2d'));
  for (let k = 0; k < 20; k++) { x.fillRect(0, 0, 5, 5); await sleep(20); }
  await sleep(300);
  assert.equal(paints.length, 0);
});

test('a canvas that was drawn on OUTSIDE a drawable and is then moved into one is noticed at once (no 100 ms of "not in a layer" memory), WPT moved-webgl-canvas', async t => {
  const { c, d, paints } = await setup(t, 'rgb(255,0,0)');
  const moved = document.createElement('canvas');
  moved.width = 60; moved.height = 30;
  moved.style.display = 'block';
  document.body.append(moved);
  t.cleanup(() => moved.remove());
  const x = /** @type {CanvasRenderingContext2D} */ (moved.getContext('2d'));
  x.fillStyle = 'rgb(0,255,0)'; x.fillRect(0, 0, 60, 30); // resolved now: not in any layer
  const second = document.createElement('div');
  second.setAttribute('drawable', '');
  second.style.cssText = 'width:60px;height:30px';
  c.append(second);
  second.append(moved);
  await sleep(300);
  paints.length = 0;
  x.fillStyle = 'rgb(0,0,255)'; x.fillRect(0, 0, 60, 30); // immediately after the move
  await sleep(700);
  assert.ok(paints.some((p) => p.includes(second)), 'a paint event lists the drawable that now holds the canvas');
  assert.ok(d);
});
