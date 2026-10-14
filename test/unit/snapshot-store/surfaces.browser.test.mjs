import { test, assert } from '/test/unit/lib/t.js';
import { allocateSurface, forkSurface, isSurfaceLost, surfaceBytes, watchSurfaceLoss } from '/src/snapshot/store/surfaces.js';
import { fill, forceContextLoss, pixel, RGBA, until } from './helpers.mjs';

test('allocateSurface: whole-pixel 2D surface; a non-integer size rounds up', () => {
  const s = allocateSurface(10.2, 20);
  assert.equal(s.width, 11);
  assert.equal(s.height, 20);
  assert.ok(s.getContext('2d'));
  assert.equal(surfaceBytes(s), 11 * 20 * 4);
});

test('allocateSurface: beyond the canvas dimension limit throws HicUnsupportedError surface-size', () => {
  let err = null;
  try { allocateSurface(40000, 10); } catch (e) { err = e; }
  assert.ok(err);
  assert.equal(err.name, 'NotSupportedError');
  assert.equal(err.feature, 'surface-size');
});

test('forkSurface: an independent full copy; the original is not touched by writes to the fork', () => {
  const a = allocateSurface(20, 20);
  fill(a, 'red');
  const b = forkSurface(a);
  assert.notEqual(a, b);
  assert.deepEqual(pixel(b, 5, 5), RGBA.red);
  fill(b, 'blue');
  assert.deepEqual(pixel(a, 5, 5), RGBA.red);
  assert.deepEqual(pixel(b, 5, 5), RGBA.blue);
});

// Headless Chrome 154 delivers contextlost for a forced loss but never contextrestored (probed: 4 s, 40 frames), so the loss half is driven by the platform
// recipe and the restore half by a synthetic event on the same EventTarget. The real restore is a headed gate (G-context-loss).
test('watchSurfaceLoss: a forced real loss is reported, cancelled (that asks for a restore) and read as lost', async () => {
  const s = allocateSurface(30, 30);
  fill(s, 'red');
  const events = [];
  let cancelled = null;
  const off = watchSurfaceLoss(s, () => events.push(['lost', isSurfaceLost(s)]), () => events.push(['restored']));
  s.addEventListener('contextlost', (e) => { cancelled = e.defaultPrevented; });
  forceContextLoss(s);
  await until(() => events.length >= 1, 3000, 'contextlost');
  assert.deepEqual(events[0], ['lost', true]);
  assert.equal(cancelled, true, 'preventDefault() on contextlost is what asks the browser to restore');
  off();
});

test('watchSurfaceLoss: restored clears the lost state; the remover detaches both listeners', () => {
  const s = allocateSurface(30, 30);
  const events = [];
  const off = watchSurfaceLoss(s, () => events.push('lost'), () => events.push(['restored', isSurfaceLost(s)]));
  s.dispatchEvent(new Event('contextlost', { cancelable: true }));
  assert.equal(isSurfaceLost(s), true);
  s.dispatchEvent(new Event('contextrestored'));
  assert.equal(isSurfaceLost(s), false);
  assert.deepEqual(events, ['lost', ['restored', false]]);
  off();
  s.dispatchEvent(new Event('contextlost', { cancelable: true }));
  s.dispatchEvent(new Event('contextrestored'));
  assert.equal(events.length, 2, 'detached');
});

test('forkSurface refuses a surface whose context is lost', () => {
  const s = allocateSurface(30, 30);
  const off = watchSurfaceLoss(s, () => {}, () => {});
  s.dispatchEvent(new Event('contextlost', { cancelable: true }));
  let err = null;
  try { forkSurface(s); } catch (e) { err = e; }
  assert.equal(err?.feature, 'context-loss');
  off();
});
