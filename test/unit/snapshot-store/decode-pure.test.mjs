import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeDataUrl, drawTileAtomic, releaseImage } from '../../../src/snapshot/store/decode.js';

/** A recording fake 2D context; `drawImage` can be made to throw. */
function fakeSurface({ throwOnDraw = false, lost = false } = {}) {
  const calls = [];
  const ctx = {
    isContextLost: () => lost,
    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
    beginPath: () => calls.push('beginPath'),
    rect: (...a) => calls.push(['rect', ...a]),
    clip: () => calls.push('clip'),
    set globalCompositeOperation(v) { calls.push(['op', v]); },
    drawImage: (...a) => { calls.push(['drawImage', ...a.slice(1)]); if (throwOnDraw) throw new Error('boom'); },
  };
  return { calls, getContext: () => ctx };
}
const goodImg = { complete: true, naturalWidth: 10, naturalHeight: 10, src: 'data:x' };
const crop = { x: 4, y: 6, width: 20, height: 10 };

test('decodeDataUrl accepts data: URLs only (blob: would taint the surface)', async () => {
  await assert.rejects(() => decodeDataUrl('blob:https://x/1'), /data: URLs only/);
  await assert.rejects(() => decodeDataUrl('https://example.com/a.svg'), /data: URLs only/);
  await assert.rejects(() => decodeDataUrl(null), /data: URLs only/);
});

test('decodeDataUrl: a stuck decode times out and releases the image; success returns the image', async () => {
  let released = null;
  const stuck = { set src(v) { if (v === '') released = true; }, decode: () => new Promise(() => {}), decoding: '' };
  await assert.rejects(() => decodeDataUrl('data:image/svg+xml,x', { timeoutMs: 20, create: () => stuck }), /timed out/);
  assert.equal(released, true);
  const ok = { src: '', decoding: '', decode: async () => {} };
  assert.equal(await decodeDataUrl('data:image/svg+xml,x', { create: () => ok }), ok);
  assert.equal(ok.decoding, 'async');
  const bad = { src: '', decode: async () => { throw new DOMException('broken', 'EncodingError'); } };
  await assert.rejects(() => decodeDataUrl('data:image/svg+xml,x', { create: () => bad }), /broken/);
  assert.equal(bad.src, '', 'a failed decode frees the image');
});

test('drawTileAtomic: save, rect, clip, copy, draw, restore, in this order, bounded to the crop', () => {
  const s = fakeSurface();
  assert.equal(drawTileAtomic(s, goodImg, crop), true);
  assert.deepEqual(s.calls, ['save', 'beginPath', ['rect', 4, 6, 20, 10], 'clip', ['op', 'copy'], ['drawImage', 4, 6, 20, 10], 'restore']);
});

test('drawTileAtomic: guard refuses an incomplete or empty image before touching the surface', () => {
  for (const img of [{ complete: false, naturalWidth: 10 }, { complete: true, naturalWidth: 0 }]) {
    const s = fakeSurface();
    assert.equal(drawTileAtomic(s, img, crop), false);
    assert.deepEqual(s.calls, []);
  }
});

test('drawTileAtomic: a throwing drawImage returns false and still restores the context state', () => {
  const s = fakeSurface({ throwOnDraw: true });
  assert.equal(drawTileAtomic(s, goodImg, crop), false);
  assert.equal(s.calls.at(-1), 'restore');
});

test('drawTileAtomic: a lost context is refused untouched', () => {
  const s = fakeSurface({ lost: true });
  assert.equal(drawTileAtomic(s, goodImg, crop), false);
  assert.deepEqual(s.calls, []);
});

test('releaseImage clears the source', () => {
  const img = { src: 'data:x' };
  releaseImage(img);
  assert.equal(img.src, '');
});
