// Regression tests of the correctness review (M1, M3): real install, real scheduler.
import { test, assert } from '/test/unit/lib/t.js';
import { inst, mk, sleep, frames, thrown, drawableDiv } from '../api-core/_real.mjs';

test('M1: a drawable appended to an already painted canvas is built and painted without any other damage', async t => {
  const i = inst(t);
  const c = await mk(t, i);
  const log = /** @type {string[]} */ ([]);
  c.addEventListener('paint', (e) => log.push([...(/** @type {any} */ (e)).changedElements].map((x) => x.id).join('+') || '[]'));
  await sleep(200);
  log.length = 0;
  const d = drawableDiv('late', 'blue');
  c.append(d);
  await sleep(600);
  assert.ok(log.some((l) => l.includes('late')), `paint events after the append: ${JSON.stringify(log)}`);
  assert.equal(thrown(() => /** @type {any} */ (c.getContext('2d')).drawElementImage(d, 0, 0)), null, 'the new drawable can be drawn');
});

test('M1: the first drawable added to an EMPTY managed canvas is painted', async t => {
  const i = inst(t);
  const c = await mk(t, i, { inner: '' });
  await sleep(200);
  const d = drawableDiv('first', 'green');
  c.append(d);
  await sleep(600);
  assert.equal(thrown(() => /** @type {any} */ (c.getContext('2d')).drawElementImage(d, 0, 0)), null);
});

test('M1: setAttribute(drawable) on an existing child is painted', async t => {
  const i = inst(t);
  const c = await mk(t, i);
  const plain = document.createElement('div');
  plain.style.cssText = 'width:30px;height:20px;background:red';
  c.append(plain);
  await sleep(300);
  plain.setAttribute('drawable', '');
  await sleep(600);
  assert.equal(thrown(() => /** @type {any} */ (c.getContext('2d')).drawElementImage(plain, 0, 0)), null);
});

test('M3: an unconditional canvas.width write inside onpaint does not start a paint loop', async t => {
  const i = inst(t);
  const c = await mk(t, i);
  const a = /** @type {Element} */ (c.querySelector('#a'));
  let n = 0;
  c.onpaint = () => {
    n++;
    c.width = 200;
    /** @type {any} */ (c.getContext('2d')).drawElementImage(a, 0, 0);
  };
  c.requestPaint();
  await sleep(1200);
  c.onpaint = null;
  assert.ok(n < 5, `paints in 1.2 s: ${n}`);
  const px = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d')).getImageData(90, 40, 1, 1).data;
  assert.equal(px[0], 255, 'the drawable is on the bitmap after the write');
});

test('M3 control: a width write OUTSIDE a paint handler still repaints in the same frame', async t => {
  const i = inst(t);
  const c = await mk(t, i);
  const a = /** @type {Element} */ (c.querySelector('#a'));
  c.onpaint = () => /** @type {any} */ (c.getContext('2d')).drawElementImage(a, 0, 0);
  await frames(3);
  c.width = 200;
  await Promise.resolve();
  await frames(2);
  c.onpaint = null;
  const px = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d')).getImageData(90, 40, 1, 1).data;
  assert.equal(px[0], 255, 'the cleared bitmap was redrawn');
});
