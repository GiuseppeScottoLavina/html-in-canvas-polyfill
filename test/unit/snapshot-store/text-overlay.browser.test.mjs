// Optimistic text overlay (store.overlayText, docs/PERFORMANCE-COMPARISON.md optimization 1): painted at the next commit, painted AGAIN after a tile that was built before the
// request (an older value must not come back for a frame), retired by the first tile built after it.
import { test, assert } from '/test/unit/lib/t.js';
import { RGBA, makeRig } from './helpers.mjs';

const BOX = { x: 10, y: 10, width: 40, height: 20 };
const plan = (fill) => ({ box: BOX, fill, text: '', color: 'black', x: 10, baseline: 25, font: '10px sans-serif', letterSpacing: '0px', wordSpacing: '0px', kerning: 'auto', caret: { rect: { x: 30, y: 12, width: 1, height: 16 }, color: 'rgb(0, 0, 0)' } });

async function rigWith(t, planned) {
  const control = document.createElement('input');
  const rig = await makeRig(t, { textOverlay: () => planned.value, frameRect: () => ({ x: 8, y: 8, width: 44, height: 24 }) });
  const a = rig.add('a', 100, 60);
  await rig.build(a);
  return { rig, a, control };
}

test('the overlay is painted by the next commit, inside the content box only, with the re-measured caret', async (t) => {
  const planned = { value: plan('rgb(0, 0, 255)') };
  const { rig, a, control } = await rigWith(t, planned);
  const v1 = rig.store.version(a);
  rig.store.overlayText(a, control);
  assert.equal(rig.store.hasLanded(rig.record), true, 'a queued overlay is work for the next commit');
  const cs = rig.store.commitLanded();
  assert.deepEqual(cs.changed, [a]);
  assert.notEqual(rig.store.version(a).id, v1.id);
  assert.deepEqual(rig.css(a, 20, 15), RGBA.blue);
  assert.deepEqual(rig.css(a, 5, 5), RGBA.red, 'outside the content box nothing changed');
  assert.deepEqual(rig.css(a, 30, 20), RGBA.black, 'the caret of the plan is shown');
  assert.equal(rig.calls.length, 1, 'no build was needed for the overlay');
});

test('an older tile landing after the overlay is covered again; the first newer tile is the authority', async (t) => {
  const planned = { value: plan('rgb(0, 0, 255)') };
  const { rig, a, control } = await rigWith(t, planned);
  rig.deferDecode = true;
  rig.color = 'lime';
  rig.store.markDamage(a, null, 'input');
  rig.pump();
  rig.store.overlayText(a, control);
  rig.store.commitLanded();
  assert.deepEqual(rig.css(a, 20, 15), RGBA.blue);
  await rig.release();
  rig.store.commitLanded();
  assert.deepEqual(rig.css(a, 5, 5), RGBA.lime, 'the older tile was drawn');
  assert.deepEqual(rig.css(a, 20, 15), RGBA.blue, 'and the overlay painted again over its stale value');
  rig.color = 'red';
  rig.store.markDamage(a, null, 'input');
  rig.pump();
  await rig.release();
  rig.store.commitLanded();
  assert.deepEqual(rig.css(a, 20, 15), RGBA.red, 'a tile built after the request replaces the overlay');
  assert.equal(rig.store.hasLanded(rig.record), false);
});

test('no plan (unsupported field state): nothing is painted and the tiles stay the only source', async (t) => {
  const planned = { value: null };
  const { rig, a, control } = await rigWith(t, planned);
  const v1 = rig.store.version(a);
  rig.store.overlayText(a, control);
  const cs = rig.store.commitLanded();
  assert.deepEqual(cs.changed, []);
  assert.equal(rig.store.version(a), v1);
  assert.deepEqual(rig.css(a, 20, 15), RGBA.red);
});

test('a pinned surface is never written by the overlay (copy-on-write)', async (t) => {
  const planned = { value: plan('rgb(0, 0, 255)') };
  const { rig, a, control } = await rigWith(t, planned);
  const pinnedV = rig.store.pin(a);
  rig.store.overlayText(a, control);
  rig.store.commitLanded();
  assert.notEqual(rig.store.version(a).surface, pinnedV.surface);
  assert.deepEqual(rig.css(a, 20, 15), RGBA.blue);
  const ctx = pinnedV.surface.getContext('2d');
  assert.deepEqual([...ctx.getImageData(24, 19, 1, 1).data], RGBA.red);
});

test('optimization 5: the caret follows the focus at the next commit (measured from the live field), moves, and goes on blur', async (t) => {
  let at = { x: 20, y: 12, width: 1, height: 16 };
  const control = document.createElement('input');
  document.body.append(control);
  t.cleanup(() => control.remove());
  control.focus();
  const rig = await makeRig(t, { caretOf: () => ({ rect: at, color: 'rgb(0, 0, 255)' }), frameRect: () => ({ x: 8, y: 8, width: 44, height: 24 }) });
  const a = rig.add('a', 100, 60);
  await rig.build(a);
  rig.store.caretNow(a, control);
  assert.equal(rig.store.hasLanded(rig.record), true, 'a caret request is work for the next commit');
  rig.store.commitLanded();
  assert.deepEqual(rig.css(a, 20, 18), RGBA.blue, 'caret shown');
  at = { x: 40, y: 12, width: 1, height: 16 };
  rig.store.caretNow(a, control);
  rig.store.commitLanded();
  assert.deepEqual(rig.css(a, 40, 18), RGBA.blue, 'caret moved');
  assert.deepEqual(rig.css(a, 20, 18), RGBA.red, 'the old caret was lifted');
  rig.store.caretNow(a, null);
  rig.store.commitLanded();
  assert.deepEqual(rig.css(a, 40, 18), RGBA.red, 'blur: no caret');
});

test('typing pause: a field may defer its snapshot only after its overlay worked; a deferred overlay that fails damages the field at once', async (t) => {
  const planned = { value: plan('rgb(0, 0, 255)') };
  const { rig, a, control } = await rigWith(t, planned);
  assert.equal(rig.store.overlayText(a, control), false, 'first edit: not known to work yet, build as usual');
  rig.store.commitLanded();
  assert.equal(rig.store.overlayText(a, control), true, 'the overlay worked: the snapshot may wait for the pause');
  rig.store.commitLanded();
  assert.equal(rig.store.isSettled(a), true, 'nothing pending while the overlay serves');
  planned.value = null;
  assert.equal(rig.store.overlayText(a, control), true);
  rig.store.commitLanded();
  assert.equal(rig.store.isSettled(a), false, 'the failed overlay damaged the field: a build is due now');
  assert.equal(rig.store.overlayText(a, control), false, 'and the field is no longer trusted');
});
