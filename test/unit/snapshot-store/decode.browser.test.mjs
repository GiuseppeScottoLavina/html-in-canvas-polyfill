import { test, assert } from '/test/unit/lib/t.js';
import { decodeDataUrl, drawTileAtomic, releaseImage } from '/src/snapshot/store/decode.js';
import { allocateSurface } from '/src/snapshot/store/surfaces.js';
import { allPixels, fill, pixel, RGBA, samePixels, solidUrl, svgUrl } from './helpers.mjs';

const loaded = (url) => decodeDataUrl(url);

test('decodeDataUrl: a real SVG data: URL decodes to a complete image of its size', async () => {
  const img = await loaded(solidUrl(24, 12, 'red'));
  assert.equal(img.complete, true);
  assert.equal(img.naturalWidth, 24);
  assert.equal(img.naturalHeight, 12);
  releaseImage(img);
});

test('decodeDataUrl: a broken SVG rejects (the pump keeps the previous version)', async () => {
  await assert.rejects(() => loaded('data:image/svg+xml,%3Csvg%20not-closed'));
});

// WebKit rejects a malformed SVG with the 'Loading error.' of a failed load (iPadOS 27.2): the rejection must say which it was
test('decodeDataUrl: a malformed SVG rejects with the parser error and the generated markup around it', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml"><b>x</i></div></foreignObject></svg>';
  let err = null;
  try { await loaded('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)); } catch (e) { err = e; }
  assert.ok(err, 'rejected');
  assert.equal(err.name, 'EncodingError', 'the engine error name is kept');
  assert.ok(/The SVG is not well-formed XML \(\d+ chars\): .*(mismatch|closing tag).* at \d+: /i.test(err.message), err.message);
  assert.ok(err.message.includes('<b>x</i>') && !err.message.includes('Below is a rendering'), `the markup around the error, no parser boilerplate: ${err.message}`);
  assert.equal(err.cause?.name, 'EncodingError', 'the engine error is the cause');
});

test('decodeDataUrl: a well-formed SVG whose decode fails keeps the engine error as it is (control)', async () => {
  const engineError = new DOMException('Loading error.', 'EncodingError');
  const fake = /** @type {any} */ ({ src: '', decoding: '', complete: false, naturalWidth: 0, decode: () => Promise.reject(engineError) });
  let err = null;
  try { await decodeDataUrl(solidUrl(4, 4, 'red'), { create: () => fake }); } catch (e) { err = e; }
  assert.equal(err, engineError, 'the same error, no XML note');
  assert.equal(fake.src, '', 'the image was released');
});

test('decodeDataUrl: a timed-out decode of a well-formed SVG is reported as a timeout', async () => {
  const fake = /** @type {any} */ ({ src: '', decoding: '', complete: false, naturalWidth: 0, decode: () => new Promise(() => {}) });
  await assert.rejects(() => decodeDataUrl(solidUrl(4, 4, 'red'), { create: () => fake, timeoutMs: 20 }), /timed out after 20 ms$/);
});

test('drawTileAtomic: replaces ONLY the crop; pixels outside never change', async () => {
  const s = allocateSurface(40, 40);
  fill(s, 'red');
  const img = await loaded(solidUrl(10, 10, 'blue'));
  assert.equal(drawTileAtomic(s, img, { x: 10, y: 10, width: 10, height: 10 }), true);
  assert.deepEqual(pixel(s, 15, 15), RGBA.blue);
  assert.deepEqual(pixel(s, 9, 15), RGBA.red);
  assert.deepEqual(pixel(s, 20, 15), RGBA.red);
  assert.deepEqual(pixel(s, 15, 9), RGBA.red);
  assert.deepEqual(pixel(s, 15, 20), RGBA.red);
});

test('drawTileAtomic: copy semantics, a transparent tile replaces the old pixels inside the crop', async () => {
  const s = allocateSurface(40, 40);
  fill(s, 'red');
  const img = await loaded(svgUrl(10, 10, ''));
  assert.equal(drawTileAtomic(s, img, { x: 10, y: 10, width: 10, height: 10 }), true);
  assert.equal(pixel(s, 15, 15)[3], 0);
  assert.deepEqual(pixel(s, 5, 5), RGBA.red);
});

test('G-atomic-commit: a broken image (complete but naturalWidth 0) is refused and the previous pixels survive', async () => {
  const s = allocateSurface(40, 40);
  fill(s, 'red');
  const before = allPixels(s);
  const broken = new Image();
  broken.src = 'data:image/svg+xml,%3Csvg%20not-closed';
  await broken.decode().catch(() => {});
  assert.equal(drawTileAtomic(s, broken, { x: 10, y: 10, width: 10, height: 10 }), false);
  assert.ok(samePixels(before, allPixels(s)), 'untouched');
});

test('G-atomic-commit: a throwing drawImage keeps the previous pixels; the clear-then-draw control loses them', async () => {
  const img = await loaded(solidUrl(10, 10, 'blue'));
  const proto = OffscreenCanvasRenderingContext2D.prototype;
  const real = proto.drawImage;
  proto.drawImage = function () { throw new DOMException('simulated', 'InvalidStateError'); };
  try {
    const s = allocateSurface(40, 40);
    fill(s, 'red');
    assert.equal(drawTileAtomic(s, img, { x: 10, y: 10, width: 10, height: 10 }), false);
    assert.deepEqual(pixel(s, 15, 15), RGBA.red, 'atomic: old pixels kept');

    // Control: the pre-fix recipe (clearRect, then draw) leaves a hole when the draw throws.
    const c = allocateSurface(40, 40);
    fill(c, 'red');
    const ctx = c.getContext('2d');
    ctx.clearRect(10, 10, 10, 10);
    try { ctx.drawImage(img, 10, 10); } catch { /* the failure being modelled */ }
    assert.equal(pixel(c, 15, 15)[3], 0, 'control: the non-atomic recipe leaves alpha 0');
  } finally {
    proto.drawImage = real;
  }
});

test('drawTileAtomic leaves the context state clean (clip and composite op restored)', async () => {
  const s = allocateSurface(40, 40);
  fill(s, 'red');
  const img = await loaded(solidUrl(10, 10, 'blue'));
  drawTileAtomic(s, img, { x: 0, y: 0, width: 10, height: 10 });
  const ctx = s.getContext('2d');
  assert.equal(ctx.globalCompositeOperation, 'source-over');
  ctx.fillStyle = 'lime';
  ctx.fillRect(30, 30, 5, 5);
  assert.deepEqual(pixel(s, 32, 32), RGBA.lime, 'no leftover clip');
});
