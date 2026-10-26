// A canvas in a shadow tree whose child is a <slot>: the light-DOM drawable assigned to it is a child of the canvas in the flat tree, so it is a drawable of that
// canvas (WPT shadow-dom-slot-canvas-child); it stops being one when it is no longer assigned.
import { test, assert } from '/test/unit/lib/t.js';
import { inst, sleep, thrown } from './_real.mjs';

test('a drawable slotted into a canvas of a shadow tree is drawn with its ::slotted style; unassigned, it is no drawable of that canvas (InvalidStateError)', async (t) => {
  const i = inst(t);
  const host = document.createElement('div');
  host.innerHTML = '<div id="slotted" slot="s" drawable></div><div id="other" drawable></div>';
  document.body.append(host);
  t.cleanup(() => host.remove());
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<style>::slotted(div){width:100px;height:100px;background:rgb(0,128,0)}</style>'
    + '<canvas id="c" width="200" height="200" content="drawable"><slot name="s"></slot></canvas>';
  const canvas = /** @type {HTMLCanvasElement} */ (root.getElementById('c'));
  const slotted = /** @type {Element} */ (host.querySelector('#slotted'));
  const other = /** @type {Element} */ (host.querySelector('#other'));
  canvas.requestPaint();
  await i.whenPainted(canvas);
  await sleep(200);
  const ctx = /** @type {any} */ (canvas.getContext('2d'));
  ctx.drawElementImage(slotted, 20, 30);
  assert.deepEqual(Array.from(ctx.getImageData(70, 80, 1, 1).data), [0, 128, 0, 255], 'drawn with its ::slotted style');
  assert.equal(thrown(() => ctx.drawElementImage(other, 0, 0))?.name, 'InvalidStateError', 'control: a light-DOM element that no slot of the canvas shows');
  // a change inside the slotted drawable (outside the layer subtree) repaints it
  let paints = 0;
  canvas.onpaint = () => { paints++; ctx.clearRect(0, 0, 200, 200); ctx.drawElementImage(slotted, 20, 30); };
  /** @type {HTMLElement} */ (slotted).style.background = 'rgb(0, 0, 255)';
  await sleep(400);
  assert.ok(paints >= 1, 'a paint follows the change');
  assert.deepEqual(Array.from(ctx.getImageData(70, 80, 1, 1).data), [0, 0, 255, 255], 'the new colour is drawn');
  canvas.onpaint = null;
  slotted.removeAttribute('slot');
  await sleep(100);
  assert.equal(thrown(() => canvas.getElementTransform(slotted))?.name, 'InvalidStateError', 'no longer assigned: no longer a drawable of the canvas');
});
