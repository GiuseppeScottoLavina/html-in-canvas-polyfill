import { test, assert, fixture } from '/test/unit/lib/t.js';
import { installTexturePatches } from '/src/api/texture-patch.js';
import { installCanvasPatches } from '/src/api/canvas-patch.js';
import { installOffscreenPatches } from '/src/api/offscreen-patch.js';
import { createElementImage } from '/src/api/element-image.js';
import { COLORS, arrange, assertStockBrowser, throwsDom } from './fakes.mjs';

const near = (rgba, rgb) => rgb.every((v, i) => Math.abs(rgba[i] - v) <= 2) && rgba[3] >= 253;

/** Spies on texSubImage2D / texImage2D BEFORE the patch captures them. */
function spyGl(t) {
  const calls = [];
  for (const C of [WebGLRenderingContext, WebGL2RenderingContext]) {
    for (const name of ['texSubImage2D', 'texImage2D']) {
      const original = C.prototype[name];
      C.prototype[name] = function (...args) { calls.push({ name, args }); return original.apply(this, args); };
      t.cleanup(() => { C.prototype[name] = original; });
    }
  }
  return calls;
}

async function setup(t, o = {}) {
  const calls = spyGl(t);
  const a = await arrange(t, fixture, { patches: [], ...o });
  installTexturePatches(a.env, a.ledger);
  return { ...a, calls };
}

function makeTexture(gl, w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  if (w) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  return tex;
}

function readGl(gl, tex, x, y) {
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const out = new Uint8Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return Array.from(out);
}

test('baseline: a stock browser has no texElementSubImage2D', () => {
  assertStockBrowser(assert);
  assert.ok(!('texElementSubImage2D' in WebGL2RenderingContext.prototype));
});

for (const kind of ['webgl', 'webgl2']) {
  test(`${kind}: the natural size upload puts the four quadrants in the right texels`, async (t) => {
    const { canvas, el } = await setup(t);
    const gl = canvas.getContext(kind);
    const tex = makeTexture(gl, 40, 20);
    assert.equal(gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, el), undefined);
    assert.equal(gl.getError(), 0);
    assert.ok(near(readGl(gl, tex, 5, 5), COLORS.tl), 'tl');
    assert.ok(near(readGl(gl, tex, 30, 5), COLORS.tr), 'tr');
    assert.ok(near(readGl(gl, tex, 5, 15), COLORS.bl), 'bl');
    assert.ok(near(readGl(gl, tex, 30, 15), COLORS.br), 'br');
  });

  test(`${kind}: UNPACK_FLIP_Y_WEBGL applies as for texSubImage2D(canvas)`, async (t) => {
    const { canvas, el } = await setup(t);
    const gl = canvas.getContext(kind);
    const tex = makeTexture(gl, 40, 20);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, el);
    assert.ok(near(readGl(gl, tex, 5, 5), COLORS.bl), 'row 5 from the bottom is a bottom-left texel');
    assert.ok(near(readGl(gl, tex, 30, 5), COLORS.br));
    assert.ok(near(readGl(gl, tex, 5, 15), COLORS.tl));
  });

  test(`${kind}: xoffset/yoffset place the upload inside a larger texture`, async (t) => {
    const { canvas, el } = await setup(t);
    const gl = canvas.getContext(kind);
    const tex = makeTexture(gl, 64, 32);
    gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 10, 4, el);
    assert.ok(near(readGl(gl, tex, 15, 9), COLORS.tl));
    assert.equal(readGl(gl, tex, 5, 9)[3], 0);
  });

  for (const [scale, w, h] of [[2, 80, 40], [0.5, 20, 10], [3, 120, 60]]) {
    test(`${kind}: grid scale ${scale} uploads ${w}x${h} texels (ElementImage natural size), same colors`, async (t) => {
      const { canvas, el } = await setup(t, { version: { scale: Math.min(scale, 2.5) } });
      canvas.width = 100 * scale;
      canvas.height = 100 * scale;
      const gl = canvas.getContext(kind);
      const tex = makeTexture(gl, w, h);
      gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, el);
      assert.equal(gl.getError(), 0);
      assert.ok(near(readGl(gl, tex, Math.round(w * 0.25), Math.round(h * 0.25)), COLORS.tl), 'tl');
      assert.ok(near(readGl(gl, tex, Math.round(w * 0.75), Math.round(h * 0.25)), COLORS.tr), 'tr');
      assert.ok(near(readGl(gl, tex, Math.round(w * 0.25), Math.round(h * 0.75)), COLORS.bl), 'bl');
      assert.ok(near(readGl(gl, tex, Math.round(w * 0.75), Math.round(h * 0.75)), COLORS.br), 'br');
    });
  }

  test(`${kind}: config width/height and a source sub-rect`, async (t) => {
    const { canvas, el } = await setup(t);
    const gl = canvas.getContext(kind);
    const tex = makeTexture(gl, 10, 5);
    gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, el, { width: 10, height: 5 });
    assert.equal(gl.getError(), 0);
    assert.ok(near(readGl(gl, tex, 2, 1), COLORS.tl));
    assert.ok(near(readGl(gl, tex, 8, 1), COLORS.tr));
    const sub = makeTexture(gl, 20, 10);
    gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, el, { sx: 20, sy: 0, swidth: 20, sheight: 10 });
    assert.ok(near(readGl(gl, sub, 10, 5), COLORS.tr), 'only the top-right quadrant');
    assert.ok(near(readGl(gl, sub, 1, 1), COLORS.tr));
  });

  test(`${kind}: missing or too small storage is a GL error, never an exception`, async (t) => {
    const { canvas, el } = await setup(t);
    const gl = canvas.getContext(kind);
    makeTexture(gl, 0, 0);
    gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, el);
    assert.equal(gl.getError(), gl.INVALID_OPERATION, 'no storage');
    makeTexture(gl, 10, 10);
    gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, el);
    assert.equal(gl.getError(), gl.INVALID_VALUE, 'storage 10x10 for a 40x20 upload');
  });

  test(`${kind}: legacy texElementImage2D allocates the level`, async (t) => {
    const { canvas, el } = await setup(t);
    const gl = canvas.getContext(kind);
    const tex = makeTexture(gl, 0, 0);
    gl.texElementImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el);
    assert.equal(gl.getError(), 0);
    assert.ok(near(readGl(gl, tex, 5, 5), COLORS.tl));
    assert.ok(near(readGl(gl, tex, 30, 15), COLORS.br));
  });

  test(`${kind}: errors, ElementImage targets and the method shape`, async (t) => {
    const { canvas, el, store, record, env, root } = await setup(t);
    const gl = canvas.getContext(kind);
    makeTexture(gl, 40, 20);
    assert.throws(() => gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0), TypeError);
    assert.throws(() => gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, {}), TypeError);
    assert.throws(() => gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, el, 5), TypeError);
    assert.throws(() => gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, el, { swidth: NaN }), TypeError);
    assert.throws(() => gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, el, { sheight: -1 }), TypeError);
    const image = createElementImage(env, record, store.version(el));
    gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, image);
    assert.equal(gl.getError(), 0);
    image.close();
    throwsDom(() => gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, image), 'InvalidStateError');
    store.drop(el);
    throwsDom(() => gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, el), 'InvalidStateError');
    const proto = Object.getPrototypeOf(gl);
    assert.deepEqual([proto.texElementSubImage2D.name, proto.texElementSubImage2D.length, proto.texElementImage2D.length], ['texElementSubImage2D', 5, 6]);
    assert.throws(() => proto.texElementSubImage2D.call({}, 0, 0, 0, 0, el), TypeError);
    assert.ok(root);
  });
}

test('the retained surface is handed over directly only when it IS the rect; otherwise a cached scratch canvas', async (t) => {
  const direct = await setup(t, { version: { ink: 0 } });
  const gl = direct.canvas.getContext('webgl2');
  makeTexture(gl, 40, 20);
  gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, direct.el);
  assert.equal(direct.calls.filter((c) => c.name === 'texSubImage2D').at(-1).args.at(-1), direct.version.surface, 'ink 0, scale 1: no copy');
});

test('with ink around the border box a scratch canvas is used and cached per version', async (t) => {
  const { canvas, el, calls, store, version } = await setup(t);
  const gl = canvas.getContext('webgl2');
  makeTexture(gl, 40, 20);
  gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, el);
  gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, el);
  const uploads = calls.filter((c) => c.name === 'texSubImage2D').map((c) => c.args.at(-1));
  assert.notEqual(uploads[0], version.surface);
  assert.equal(uploads[0], uploads[1], 'same scratch for the same version and rect');
  assert.equal(store.calls.rasterSource.length, 1, 'cropped once');
  const next = store.commit(el);
  gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, el);
  const third = calls.filter((c) => c.name === 'texSubImage2D').at(-1).args.at(-1);
  assert.notEqual(third, uploads[0], 'a new version gets a new scratch');
  assert.ok(next.id > version.id);
});

test('a WebGL context of a transferred canvas resolves through the placeholder; a free OffscreenCanvas is a TypeError', async (t) => {
  const { canvas, el, env, ledger, geometry } = await setup(t);
  installOffscreenPatches(env, ledger, geometry);
  const oc = canvas.transferControlToOffscreen();
  const gl = oc.getContext('webgl2');
  const tex = makeTexture(gl, 40, 20);
  gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, el);
  assert.equal(gl.getError(), 0);
  assert.ok(near(readGl(gl, tex, 30, 5), COLORS.tr));
  const free = new OffscreenCanvas(10, 10).getContext('webgl2');
  assert.throws(() => free.texElementSubImage2D(free.TEXTURE_2D, 0, 0, 0, el), TypeError);
});

test('legacyNames:false: no texElementImage2D / copyElementImageToTexture', async (t) => {
  const { canvas } = await setup(t, { options: { legacyNames: false } });
  const gl = canvas.getContext('webgl2');
  assert.equal(typeof gl.texElementSubImage2D, 'function');
  assert.equal('texElementImage2D' in gl, false);
  assert.equal('copyElementImageToTexture' in GPUQueue.prototype, false);
});

// ---------------------------------------------------------------------------------------------- WebGPU
async function gpu() {
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();
  return device;
}

function gpuTexture(device, w, h) {
  return device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
}

async function readGpu(device, texture, w, h) {
  const bytesPerRow = Math.ceil(w * 4 / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [w, h]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const data = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  return (x, y) => Array.from(data.subarray(y * bytesPerRow + x * 4, y * bytesPerRow + x * 4 + 4));
}

test('webgpu drawElementImageToTexture: natural size, size override, source rect, resample', async (t) => {
  const { el, version } = await setup(t);
  const device = await gpu();
  const q = device.queue;
  assert.equal(q.drawElementImageToTexture.length, 2);
  const natural = gpuTexture(device, 40, 20);
  assert.equal(q.drawElementImageToTexture({ source: el }, { texture: natural }), undefined);
  let px = await readGpu(device, natural, 40, 20);
  assert.ok(near(px(5, 5), COLORS.tl) && near(px(30, 5), COLORS.tr) && near(px(5, 15), COLORS.bl) && near(px(30, 15), COLORS.br), 'quadrants');

  const small = gpuTexture(device, 10, 5);
  q.drawElementImageToTexture({ source: el }, { texture: small, size: [10, 5] });
  px = await readGpu(device, small, 10, 5);
  assert.ok(near(px(2, 1), COLORS.tl) && near(px(8, 1), COLORS.tr) && near(px(8, 4), COLORS.br), 'size override resamples');

  const sub = gpuTexture(device, 20, 10);
  q.drawElementImageToTexture({ source: el, sourceX: 20, sourceY: 10, sourceWidth: 20, sourceHeight: 10 }, { texture: sub });
  px = await readGpu(device, sub, 20, 10);
  assert.ok(near(px(10, 5), COLORS.br) && near(px(1, 1), COLORS.br), 'sub rect');

  const placed = gpuTexture(device, 64, 32);
  q.drawElementImageToTexture({ source: el }, { texture: placed, origin: [10, 4], size: { width: 40, height: 20 } });
  px = await readGpu(device, placed, 64, 32);
  assert.ok(near(px(15, 9), COLORS.tl));
  assert.equal(px(5, 9)[3], 0);
  assert.ok(version);
});

test('webgpu: a direct source with an origin when the surface has no ink, grid scale 2 and 0.5', async (t) => {
  const { canvas, el, store } = await setup(t, { version: { ink: 0 } });
  const device = await gpu();
  const tex = gpuTexture(device, 40, 20);
  device.queue.drawElementImageToTexture({ source: el }, { texture: tex });
  const px = await readGpu(device, tex, 40, 20);
  assert.ok(near(px(5, 5), COLORS.tl) && near(px(30, 15), COLORS.br));
  store.commit(el, { scale: 2 });
  canvas.width = 50;
  canvas.height = 50;
  const half = gpuTexture(device, 20, 10);
  device.queue.drawElementImageToTexture({ source: el }, { texture: half });
  const h = await readGpu(device, half, 20, 10);
  assert.ok(near(h(3, 2), COLORS.tl) && near(h(15, 7), COLORS.br), 'grid scale 0.5 over a 2x surface');
});

test('webgpu legacy copyElementImageToTexture({source,sx,sy,swidth,sheight},{destination:{texture},width,height})', async (t) => {
  const { el } = await setup(t);
  const device = await gpu();
  const tex = gpuTexture(device, 20, 10);
  device.queue.copyElementImageToTexture({ source: el, sx: 0, sy: 10, swidth: 20, sheight: 10 }, { destination: { texture: tex }, width: 20, height: 10 });
  const px = await readGpu(device, tex, 20, 10);
  assert.ok(near(px(10, 5), COLORS.bl));
});

test('webgpu errors: argument shape, element not drawable, no snapshot, closed ElementImage', async (t) => {
  const { el, store, record, env, root } = await setup(t);
  const device = await gpu();
  const q = device.queue;
  const tex = gpuTexture(device, 40, 20);
  assert.throws(() => q.drawElementImageToTexture({ source: el }), TypeError);
  assert.throws(() => q.drawElementImageToTexture(null, { texture: tex }), TypeError);
  assert.throws(() => q.drawElementImageToTexture({ source: {} }, { texture: tex }), TypeError);
  const loose = document.createElement('div');
  root.append(loose);
  throwsDom(() => q.drawElementImageToTexture({ source: loose }, { texture: tex }), 'InvalidStateError');
  const image = createElementImage(env, record, store.version(el));
  q.drawElementImageToTexture({ source: image }, { texture: tex });
  image.close();
  throwsDom(() => q.drawElementImageToTexture({ source: image }, { texture: tex }), 'InvalidStateError');
  store.drop(el);
  throwsDom(() => q.drawElementImageToTexture({ source: el }, { texture: tex }), 'InvalidStateError');
});
