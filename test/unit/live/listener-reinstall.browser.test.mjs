// What a reinstall restores (event-bridge.js reregister): the polyfill sees nothing while it is not installed, and native listeners cannot be read, so the canvas
// listeners are restored as they were at the uninstall; on* handlers are read from the canvas. The listener matrix compares the uninstalled window itself with a
// native element; this file holds the restoration with explicit expectations (the tree-identity row of src/contracts/features.js).
import { test, assert } from '/test/unit/lib/t.js';
import { setupPair } from '/test/unit/live/listener-matrix.mjs';

/** @param {any} t */
async function rig(t) {
  const pair = await setupPair(t);
  const { target: canvas, child } = pair.canvas;
  const toCanvas = (/** @type {string} */ type) => canvas.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
  const toChild = (/** @type {string} */ type) => child.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
  return { pair, canvas, child, toCanvas, toChild };
}

test('a listener removed while the polyfill was not installed is registered again by the reinstall, on both routes, once per event', async (t) => {
  const { pair, canvas, toCanvas, toChild } = await rig(t);
  let n = 0;
  const fn = () => { n++; };
  canvas.addEventListener('rr1', fn);
  await pair.canvas.uninstall();
  canvas.removeEventListener('rr1', fn);
  toCanvas('rr1');
  assert.equal(n, 0, 'removed: not called while uninstalled');
  await pair.canvas.install();
  toCanvas('rr1'); toChild('rr1');
  assert.equal(n, 2, 'registered again: the canvas route and the child route');
  canvas.removeEventListener('rr1', fn);
  toCanvas('rr1'); toChild('rr1');
  assert.equal(n, 2, 'and removable again');
});

test('a once listener run while the polyfill was not installed is registered again by the reinstall and runs once more, once across the two routes', async (t) => {
  const { pair, canvas, toCanvas, toChild } = await rig(t);
  let n = 0;
  canvas.addEventListener('rr2', () => { n++; }, { once: true });
  await pair.canvas.uninstall();
  toCanvas('rr2');
  assert.equal(n, 1, 'run natively while uninstalled');
  await pair.canvas.install();
  toCanvas('rr2'); toChild('rr2'); toCanvas('rr2');
  assert.equal(n, 2, 'once more after the reinstall, and only once');
});

test('a listener added while the polyfill was not installed is not bridged after the reinstall: it gets the events aimed at the canvas, not the children\'s', async (t) => {
  const { pair, canvas, toCanvas, toChild } = await rig(t);
  let n = 0;
  await pair.canvas.uninstall();
  canvas.addEventListener('rr3', () => { n++; });
  await pair.canvas.install();
  toChild('rr3');
  assert.equal(n, 0, 'no child route');
  toCanvas('rr3');
  assert.equal(n, 1, 'the canvas route, natively');
});

test('on* handlers are read from the canvas at the reinstall: one cleared while uninstalled stays cleared, one set meanwhile is bridged, and return false still cancels', async (t) => {
  const { pair, canvas, child, toChild } = await rig(t);
  let a = 0, b = 0;
  canvas.onclick = () => { a++; };
  await pair.canvas.uninstall();
  canvas.onclick = null;
  canvas.onkeydown = () => { b++; return false; };
  await pair.canvas.install();
  child.dispatchEvent(new Event('click', { bubbles: true }));
  assert.equal(a, 0, 'cleared while uninstalled: not called');
  const ret = child.dispatchEvent(new Event('keydown', { bubbles: true, cancelable: true }));
  assert.equal(b, 1, 'set while uninstalled: bridged');
  assert.equal(ret, false, 'its false return cancels the event of the child');
  canvas.onkeydown = null;
  assert.ok(toChild);
});

test('after a reinstall the bridged listeners of a type keep their order among themselves and after one registered before the polyfill, on both routes', async (t) => {
  const { pair, canvas, toCanvas, toChild } = await rig(t);
  /** @type {string[]} */ const order = [];
  await pair.canvas.uninstall();
  const before = () => order.push('native-before');
  canvas.addEventListener('rr5', before);
  await pair.canvas.install();
  canvas.addEventListener('rr5', () => order.push('one'), { once: true });
  canvas.onclick = null;
  canvas.addEventListener('rr5', () => order.push('two'));
  canvas.addEventListener('rr5', () => order.push('three'), { passive: true });
  await pair.canvas.uninstall();
  await pair.canvas.install();
  toCanvas('rr5');
  assert.deepEqual(order, ['native-before', 'one', 'two', 'three'], 'the canvas route');
  order.length = 0;
  toChild('rr5');
  assert.deepEqual(order, ['two', 'three'], 'the child route (the one before the polyfill is not bridged; the once listener already ran)');
  canvas.removeEventListener('rr5', before);
});
