import { test, assert, fixture } from '/test/unit/lib/t.js';
import { installFullscreenGuard, refusePopoverCanvas } from '/src/api/fullscreen-guard.js';
import { installWorkerGuard } from '/src/api/worker-guard.js';
import { installCanvasPatches } from '/src/api/canvas-patch.js';
import { HicUnsupportedError } from '/src/contracts/errors.js';
import { arrange, rejectsDom } from './fakes.mjs';

// ---------------------------------------------------------------------------------------------- fullscreen
test('requestFullscreen on a managed canvas reaches the browser (no refusal); entering fullscreen reports the input limit once per path (X-13)', async (t) => {
  const calls = [];
  for (const name of ['requestFullscreen', 'webkitRequestFullscreen']) {
    const original = Element.prototype[name];
    if (typeof original !== 'function') continue;
    Element.prototype[name] = function (...a) { calls.push([name, this, a]); return Promise.resolve('native'); };
    t.cleanup(() => { Element.prototype[name] = original; });
  }
  let fsElement = null;
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fsElement });
  t.cleanup(() => { delete document.fullscreenElement; });
  const removers = [];
  const install = (env, ledger) => { removers.push(installFullscreenGuard(env, ledger)); };
  const { world, canvas, root } = await arrange(t, fixture, { patches: [install] });
  t.cleanup(() => removers.forEach((r) => r()));
  assert.equal(await canvas.requestFullscreen({ navigationUI: 'hide' }), 'native', 'the managed canvas goes fullscreen: it draws as natively (WPT fullscreen-canvas)');
  assert.deepEqual(calls.map((c) => c[1]), [canvas]);
  assert.deepEqual(calls[0][2], [{ navigationUI: 'hide' }], 'arguments are forwarded unchanged');
  assert.equal(world.reports.unsupported.length, 0, 'nothing is reported before the canvas is fullscreen');

  fsElement = canvas;
  document.dispatchEvent(new Event('fullscreenchange'));
  assert.equal(world.reports.unsupported.length, 1);
  assert.equal(world.reports.unsupported[0].feature, 'top-layer-canvas');
  assert.equal(world.reports.unsupported[0].canvas, canvas);
  assert.ok(world.reports.unsupported[0].message.includes('no pointer, focus or keyboard input'));

  const div = document.createElement('div');
  root.append(div);
  fsElement = div;
  document.dispatchEvent(new Event('fullscreenchange'));
  fsElement = null;
  document.dispatchEvent(new Event('fullscreenchange'));
  assert.equal(world.reports.unsupported.length, 1, 'other fullscreen elements and leaving fullscreen report nothing');

  removers.forEach((r) => r());
  fsElement = canvas;
  document.dispatchEvent(new Event('fullscreenchange'));
  assert.equal(world.reports.unsupported.length, 1, 'the remover detaches the listener');
});

test('refusePopoverCanvas reports a canvas with a popover attribute', async (t) => {
  const { world, canvas } = await arrange(t, fixture, { patches: [] });
  assert.equal(refusePopoverCanvas(world.env, canvas), false);
  assert.equal(world.reports.unsupported.length, 0);
  canvas.setAttribute('popover', '');
  assert.equal(refusePopoverCanvas(world.env, canvas), true);
  assert.equal(world.reports.unsupported.length, 1);
  assert.equal(world.reports.unsupported[0].feature, 'top-layer-canvas');
});

// ---------------------------------------------------------------------------------------------- worker
const receive = (port) => new Promise((ok) => { port.onmessage = (e) => ok(e.data); });

test('postMessage of an ElementImage throws worker-element-image with the toImageBitmap hint (message, array, plain object, transfer list)', async (t) => {
  const { world, canvas, el } = await arrange(t, fixture, { patches: [installCanvasPatches, installWorkerGuard] });
  const image = canvas.captureElementImage(el);
  const { port1, port2 } = new MessageChannel();
  t.cleanup(() => { port1.close(); port2.close(); });
  const attempts = [
    ['message', () => port1.postMessage(image)],
    ['array item', () => port1.postMessage([1, image])],
    ['object property', () => port1.postMessage({ a: 1, picture: image })],
    ['transfer array', () => port1.postMessage('x', [image])],
    ['transfer option', () => port1.postMessage('x', { transfer: [image] })],
  ];
  for (const [what, call] of attempts) {
    let err;
    try { call(); } catch (e) { err = e; }
    assert.ok(err instanceof HicUnsupportedError, what);
    assert.equal(err.feature, 'worker-element-image', what);
    assert.equal(err.name, 'NotSupportedError');
    assert.ok(err.hint.includes('toImageBitmap()'));
  }
  assert.equal(world.reports.unsupported.length, attempts.length);
  assert.equal(world.reports.unsupported[0].feature, 'worker-element-image');
});

test('postMessage of anything else passes through with identical arguments (MessagePort and Worker)', async (t) => {
  const { canvas, el } = await arrange(t, fixture, { patches: [installCanvasPatches, installWorkerGuard] });
  const { port1, port2 } = new MessageChannel();
  t.cleanup(() => { port1.close(); port2.close(); });
  const got = receive(port2);
  const buffer = new ArrayBuffer(8);
  port1.postMessage({ n: 1, list: [1, 2, { deep: { image: null } }], buffer }, [buffer]);
  assert.deepEqual(await got, { n: 1, list: [1, 2, { deep: { image: null } }], buffer: new ArrayBuffer(8) });
  assert.equal(buffer.byteLength, 0, 'the transfer list was honoured');

  const bitmapSource = canvas.captureElementImage(el);
  const bitmap = await bitmapSource.toImageBitmap();
  const got2 = receive(port2);
  port1.postMessage(bitmap, [bitmap]);
  assert.ok((await got2) instanceof ImageBitmap, 'the documented alternative works');

  const worker = new Worker('data:text/javascript,onmessage=e=>postMessage(e.data*2)');
  t.cleanup(() => worker.terminate());
  const reply = new Promise((ok) => { worker.onmessage = (e) => ok(e.data); });
  worker.postMessage(21);
  assert.equal(await reply, 42);
  let refused;
  try { worker.postMessage(bitmapSource); } catch (e) { refused = e; }
  assert.equal(refused?.feature, 'worker-element-image');
});

test('the guard walk is shallow and never invokes getters', async (t) => {
  const { canvas, el } = await arrange(t, fixture, { patches: [installCanvasPatches, installWorkerGuard] });
  const image = canvas.captureElementImage(el);
  const { port1, port2 } = new MessageChannel();
  t.cleanup(() => { port1.close(); port2.close(); });
  let touched = 0;
  const trap = { get secret() { touched++; return image; } };
  // The platform clone does invoke the getter, so the guard must not be the one that reads it.
  let err;
  try { port1.postMessage(trap); } catch (e) { err = e; }
  assert.equal(err?.name, 'DataCloneError', 'the platform error: not a polyfill error, because accessors are not inspected');
  assert.equal(err instanceof HicUnsupportedError, false);
  assert.equal(touched, 1, 'only the platform clone read it');
  let deep;
  try { port1.postMessage({ a: { b: image } }); } catch (e) { deep = e; }
  assert.equal(deep?.name, 'DataCloneError', 'nested values are left to the platform (documented)');
});

test('an ElementImage never survives a structured clone silently (DataCloneError at any depth)', async (t) => {
  const { canvas, el } = await arrange(t, fixture, { patches: [installCanvasPatches] });
  const image = canvas.captureElementImage(el);
  for (const value of [image, [image], { a: { b: image } }]) {
    let err;
    try { structuredClone(value); } catch (e) { err = e; }
    assert.equal(err?.name, 'DataCloneError');
  }
});
