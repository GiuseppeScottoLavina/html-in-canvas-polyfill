// ElementImage in a dedicated worker (worker-transfer.js on the page, worker-scope.js in the worker): WPT offscreen/*-worker, draw-element-image-different-canvas.
import { test, assert } from '/test/unit/lib/t.js';
import { inst, mk } from '/test/unit/api-core/_real.mjs';

/** @param {any} t */
function probe(t) {
  const worker = new Worker('/test/unit/api-surface/worker-probe.mjs', { type: 'module' });
  t.cleanup(() => worker.terminate());
  /** @param {any} msg @param {Transferable[]} [transfer] @returns {Promise<any>} */
  const ask = (msg, transfer = []) => new Promise((ok) => { worker.onmessage = (e) => ok(e.data); worker.postMessage(msg, transfer); });
  return { worker, ask };
}

/** @param {HTMLCanvasElement} canvas @returns {Promise<Event>} */
const geometryEvent = (canvas) => new Promise((ok) => canvas.addEventListener('elementgeometryupdate', ok, { once: true }));

test('a worker draws a transferred ElementImage on the OffscreenCanvas of its canvas; the draw updates the element geometry on the page (one event); the transferred image is closed', async (t) => {
  const i = inst(t);
  const canvas = await mk(t, i);
  const a = /** @type {HTMLElement} */ (canvas.querySelector('#a') ?? document.getElementById('a'));
  const { ask } = probe(t);
  const oc = canvas.transferControlToOffscreen();
  assert.deepEqual(await ask({ canvas: oc, name: 'main' }, [oc]), { ok: true });
  const image = canvas.captureElementImage(a);
  const got = await ask({ image }, [image]);
  assert.deepEqual(got, { ok: true, isImage: true, tag: '[object ElementImage]' }, 'the worker sees an ElementImage');
  assert.throws(() => canvas.getElementImageDefaultSize(image), /closed/);
  const event = geometryEvent(canvas);
  const drawn = await ask({ cmd: 'draw', on: 'main', args: [10, 5], at: [20, 10] });
  assert.deepEqual(drawn.px, [255, 0, 0, 255], 'the red drawable is drawn at (10, 5)');
  const e = /** @type {any} */ (await event);
  assert.deepEqual([...e.elements], [a]);
  const m = canvas.getElementTransform(a);
  assert.deepEqual([m.e, m.f], [10, 5], 'the canvas transform of the draw');
  assert.deepEqual((await ask({ cmd: 'size', on: 'main' })).size, { width: 100, height: 50 });
  assert.deepEqual((await ask({ cmd: 'transform', on: 'main' })).m.slice(12, 14), [5, 6], 'the two-argument getElementTransform of the earlier draft');
  const cleared = geometryEvent(canvas);
  await ask({ cmd: 'clear', on: 'main' });
  await cleared;
  assert.ok(canvas.getElementTransform(a).isIdentity, 'clearElementGeometry from the worker');
});

test('in the worker: another canvas, a standalone OffscreenCanvas and a closed image throw InvalidStateError (WPT draw-element-image-different-canvas); control: the own canvas draws', async (t) => {
  const i = inst(t);
  const c1 = await mk(t, i);
  const c2 = await mk(t, i, { inner: '<div id="b" drawable style="width:10px;height:10px;background:blue"></div>' });
  const { ask } = probe(t);
  const o1 = c1.transferControlToOffscreen();
  const o2 = c2.transferControlToOffscreen();
  await ask({ canvas: o1, name: 'one' }, [o1]);
  await ask({ canvas: o2, name: 'two' }, [o2]);
  const image = c1.captureElementImage(/** @type {Element} */ (c1.querySelector('#a') ?? document.querySelectorAll('#a')[0]));
  await ask({ image }, [image]);
  assert.deepEqual(await ask({ cmd: 'draw', on: 'two', args: [0, 0], at: [1, 1] }), { error: 'InvalidStateError' }, 'another canvas');
  assert.deepEqual(await ask({ cmd: 'standalone' }), { error: 'InvalidStateError' }, 'standalone');
  assert.deepEqual((await ask({ cmd: 'draw', on: 'one', args: [0, 0], at: [1, 1] })).px, [255, 0, 0, 255], 'control: its own canvas');
  assert.deepEqual(await ask({ cmd: 'close', on: 'one' }), { error: 'InvalidStateError' }, 'closed');
});

test('preserveElementGeometry: a worker draw leaves the geometry alone (no event)', async (t) => {
  const i = inst(t);
  const canvas = await mk(t, i);
  const a = /** @type {HTMLElement} */ (canvas.querySelector('#a') ?? document.getElementById('a'));
  const { ask } = probe(t);
  const oc = canvas.transferControlToOffscreen();
  await ask({ canvas: oc, name: 'main' }, [oc]);
  const image = canvas.captureElementImage(a);
  await ask({ image }, [image]);
  let fired = 0;
  canvas.addEventListener('elementgeometryupdate', () => fired++);
  await ask({ cmd: 'draw', on: 'main', args: [10, 5, { preserveElementGeometry: true }], at: [20, 10] });
  await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(fired, 0);
  assert.ok(canvas.getElementTransform(a).isIdentity);
});

test('a message that cannot be delivered (DataCloneError) leaves no trace: the next one still names the canvases and opens the geometry channel', async (t) => {
  const i = inst(t);
  const canvas = await mk(t, i);
  const a = /** @type {HTMLElement} */ (canvas.querySelector('#a') ?? document.getElementById('a'));
  const { worker, ask } = probe(t);
  const oc = canvas.transferControlToOffscreen();
  const bad = canvas.captureElementImage(a);
  assert.throws(() => worker.postMessage({ canvas: oc, name: 'main', image: bad, f: () => 1 }, [oc, bad]), DOMException);
  assert.equal(canvas.getElementImageDefaultSize(bad).width, 100, 'not transferred: still usable on the page');
  assert.deepEqual(await ask({ canvas: oc, name: 'main' }, [oc]), { ok: true });
  const image = canvas.captureElementImage(a);
  await ask({ image }, [image]);
  const event = new Promise((ok) => canvas.addEventListener('elementgeometryupdate', ok, { once: true }));
  assert.deepEqual((await ask({ cmd: 'draw', on: 'main', args: [10, 5], at: [20, 10] })).px, [255, 0, 0, 255]);
  await event;
  assert.deepEqual([canvas.getElementTransform(a).e, canvas.getElementTransform(a).f], [10, 5]);
});

test('the geometry channel applies only well-formed operations on elements posted to that worker: malformed ones and another worker\'s element are ignored without an error; control: its own element moves', async (t) => {
  const i = inst(t);
  const canvas = await mk(t, i, { inner: '<div id="a" drawable style="width:100px;height:50px;background:rgb(255,0,0)"></div><div id="b" drawable style="width:20px;height:20px;background:blue"></div>' });
  const a = /** @type {Element} */ (canvas.querySelector('#a'));
  const b = /** @type {Element} */ (canvas.querySelector('#b'));
  const other = probe(t);
  const ib = canvas.captureElementImage(b);
  await other.ask({ image: ib }, [ib]);
  const raw = new Worker('/test/unit/api-surface/worker-raw-probe.mjs', { type: 'module' });
  t.cleanup(() => raw.terminate());
  const ask = (/** @type {any} */ msg, /** @type {Transferable[]} */ transfer = []) => new Promise((ok) => { raw.onmessage = (e) => ok(e.data); raw.postMessage(msg, transfer); });
  const ia = canvas.captureElementImage(a);
  const got = /** @type {any} */ (await ask(ia, [ia]));
  assert.equal(got.ok, true, 'the raw worker sees the wire record');
  let fired = 0;
  canvas.addEventListener('elementgeometryupdate', () => fired++);
  const move = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 7, 8, 0, 1];
  const forged = [null, 5, 'x', { kind: 'update' }, { kind: 'update', canvas: got.canvas, element: got.element, values: 'x', is2D: true },
    { kind: 'update', canvas: got.canvas, element: got.element, values: move.map(() => NaN), is2D: true }, { kind: 'bogus', canvas: got.canvas, element: got.element }];
  for (let token = 1; token < got.element + 20; token++) if (token !== got.element) forged.push({ kind: 'update', canvas: got.canvas, element: token, values: move, is2D: true, clip: null });
  await ask({ forge: forged });
  await ask({ forge: { kind: 'clear', canvas: got.canvas, element: got.element } });
  await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(fired, 0, 'nothing applied');
  assert.ok(canvas.getElementTransform(b).isIdentity, 'the element of the other worker did not move');
  const event = geometryEvent(canvas);
  await ask({ own: move });
  const e = /** @type {any} */ (await event);
  assert.deepEqual([...e.elements], [a], 'control: its own element');
  assert.deepEqual([canvas.getElementTransform(a).e, canvas.getElementTransform(a).f], [7, 8]);
});
