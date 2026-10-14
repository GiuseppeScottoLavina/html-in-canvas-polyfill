// GPU time of ONE plugin pass, measured outside the effects host (so the number is the plugin's pass alone, not the upload or the
// presentation), on a private WebGPU device, at the size of the gallery canvas (1100 x 620 CSS px at DPR 2) by default. Browser only
// (plugins/*/test/*.browser.test.mjs). Two measurements:
//
//   measureGpuTime(plugin, options)      frames rendered back to back from a source with text and shapes; the time from the first submit to
//                                        onSubmittedWorkDone divided by the frame count (GPU throughput per frame, an upper bound: it
//                                        includes submission overhead), with `baselineMs`, the same measurement for a pass that only clears.
//   measurePassGpuTime(plugin, options)  timestamp queries around each render pass (median, p95, max) plus the same back-to-back
//                                        throughput, on a 120 Hz frame clock; null where timestamp queries are not available.
//
// Timestamp queries on Chrome / Metal (Apple M1 Max) come in steps of about 66 us and returned negative values for an empty pass and
// values that grew with the queue depth, so the throughput is the number to compare with the 8.33 ms frame of a 120 Hz display.

/** A pass that only clears its target: the floor of the measurement. */
const CLEAR_ONLY = {
  create: async () => ({
    render(/** @type {any} */ f) {
      f.encoder.beginRenderPass({ colorAttachments: [{ view: f.destinationView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] }).end();
    },
  }),
};

/**
 * @param {any} device @param {string} format @param {any} plugin @param {Record<string, unknown>} options
 * @param {{w: number, h: number, dpr: number, frames: number, warmup: number}} o
 */
async function run(device, format, plugin, options, { w, h, dpr, frames, warmup }) {
  const T = GPUTextureUsage;
  const paint = new OffscreenCanvas(w, h);
  const g = /** @type {OffscreenCanvasRenderingContext2D} */ (paint.getContext('2d'));
  g.fillStyle = '#081a2c'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#e8f6ff'; g.font = `${14 * dpr}px system-ui`;
  for (let y = 30 * dpr; y < h; y += 34 * dpr) g.fillText('The form stays usable through the effect: 0123456789 abcdefghijklmnopqrstuvwxyz', 20 * dpr, y);
  g.fillStyle = '#4fd1ff'; for (let i = 0; i < 40; i += 1) g.fillRect((i * 97 * dpr) % w, (i * 53 * dpr) % h, 30 * dpr, 15 * dpr);
  const source = device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: T.TEXTURE_BINDING | T.COPY_DST | T.RENDER_ATTACHMENT });
  device.queue.copyExternalImageToTexture({ source: paint }, { texture: source }, [w, h]);
  const target = device.createTexture({ size: [w, h], format, usage: T.RENDER_ATTACHMENT });
  const sourceView = source.createView();
  const targetView = target.createView();
  const canvas = document.createElement('canvas');
  const context = { apiVersion: 2, device, format, canvas, source: canvas, requestRender() {}, viewport: () => ({}), listen: () => () => {} };
  const instance = await plugin.create(context, options);
  const frame = (/** @type {number} */ k, /** @type {any} */ encoder) => ({
    now: k * 8.333, delta: 8.333, frameIndex: k, frameCap: 0, sourceVersion: 1, sourceReady: true, encoder,
    sourceTexture: source, sourceView, destinationTexture: target, destinationView: targetView,
    width: w, height: h, cssWidth: w / dpr, cssHeight: h / dpr, dpr,
  });
  let t0 = 0;
  for (let k = 0; k < warmup + frames; k += 1) {
    if (k === warmup) { await device.queue.onSubmittedWorkDone(); t0 = performance.now(); }
    const encoder = device.createCommandEncoder();
    instance.render(frame(k, encoder));
    device.queue.submit([encoder.finish()]);
  }
  await device.queue.onSubmittedWorkDone();
  const ms = (performance.now() - t0) / frames;
  instance.destroy?.();
  source.destroy(); target.destroy();
  return ms;
}

/**
 * @param {any} plugin  the plugin definition
 * @param {Record<string, unknown>} options
 * @param {{w?: number, h?: number, dpr?: number, frames?: number, warmup?: number}} [o]
 * @returns {Promise<{meanMs: number, baselineMs: number, w: number, h: number, frames: number}>}
 */
export async function measureGpuTime(plugin, options, { w = 2200, h = 1240, dpr = 2, frames = 600, warmup = 30 } = {}) {
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const format = navigator.gpu.getPreferredCanvasFormat();
  try {
    const o = { w, h, dpr, frames, warmup };
    const baselineMs = await run(device, format, CLEAR_ONLY, {}, o);
    const meanMs = await run(device, format, plugin, options, o);
    return { meanMs, baselineMs, w, h, frames };
  } finally {
    device.destroy();
  }
}

const U = () => /** @type {any} */ (globalThis).GPUTextureUsage;
const B = () => /** @type {any} */ (globalThis).GPUBufferUsage;

/**
 * @param {any} plugin  the definition
 * @param {Record<string, unknown>} options
 * @param {{cssWidth?: number, cssHeight?: number, dpr?: number, frames?: number, clockMs?: number, before?: (canvas: HTMLCanvasElement, instance: any) => void}} [o]
 */
export async function measurePassGpuTime(plugin, options, { cssWidth = 1100, cssHeight = 620, dpr = 2, frames = 240, clockMs = 1000 / 120, before } = {}) {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter || !adapter.features.has('timestamp-query')) return null;
  const device = await adapter.requestDevice({ requiredFeatures: ['timestamp-query'] });
  const width = Math.round(cssWidth * dpr);
  const height = Math.round(cssHeight * dpr);
  const format = navigator.gpu.getPreferredCanvasFormat();
  const source = device.createTexture({ size: [width, height], format: 'rgba8unorm', usage: U().TEXTURE_BINDING | U().COPY_DST });
  const pixels = new Uint8Array(width * 4 * height);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 2654435761) >>> 24;   // busy content, not a flat colour
  device.queue.writeTexture({ texture: source }, pixels, { bytesPerRow: width * 4 }, [width, height]);
  const destination = device.createTexture({ size: [width, height], format, usage: U().RENDER_ATTACHMENT });
  const canvas = document.createElement('canvas');
  canvas.style.cssText = `position:fixed;left:0;top:0;width:${cssWidth}px;height:${cssHeight}px`;
  document.body.append(canvas);
  const sourceEl = document.createElement('div');
  const context = {
    apiVersion: 2, adapter, device, format, canvas, source: sourceEl, requestRender() {}, listen: () => () => {},
    viewport: () => ({ width, height, cssWidth, cssHeight, dpr }),
  };
  const instance = await plugin.create(context, options);
  const querySet = device.createQuerySet({ type: 'timestamp', count: 2 * frames });
  const resolveBuffer = device.createBuffer({ size: 16 * frames, usage: B().QUERY_RESOLVE | B().COPY_SRC });
  const readBuffer = device.createBuffer({ size: 16 * frames, usage: B().COPY_DST | B().MAP_READ });
  try {
    before?.(canvas, instance);
    const sourceView = source.createView();
    const destinationView = destination.createView();
    const t0 = performance.now();
    for (let i = 0; i < frames; i += 1) {
      const encoder = device.createCommandEncoder();
      const timed = {
        beginRenderPass: (/** @type {any} */ d) => encoder.beginRenderPass({ ...d, timestampWrites: { querySet, beginningOfPassWriteIndex: 2 * i, endOfPassWriteIndex: 2 * i + 1 } }),
      };
      instance.render({
        now: t0 + i * clockMs, delta: clockMs, frameIndex: i, frameCap: 120, sourceVersion: 1, sourceReady: true,
        encoder: timed, sourceTexture: source, sourceView, destinationTexture: destination, destinationView, width, height, cssWidth, cssHeight, dpr,
      });
      device.queue.submit([encoder.finish()]);
    }
    // throughput: the same frames back to back without timestamps, wall time until the GPU is done (an upper bound of the GPU time
    // per frame that does not depend on how the GPU reports pass timestamps; Apple GPUs report them in ~66 us steps)
    await device.queue.onSubmittedWorkDone();
    const t1 = performance.now();
    for (let i = 0; i < frames; i += 1) {
      const enc = device.createCommandEncoder();
      instance.render({
        now: t0 + i * clockMs, delta: clockMs, frameIndex: i, frameCap: 120, sourceVersion: 1, sourceReady: true,
        encoder: enc, sourceTexture: source, sourceView, destinationTexture: destination, destinationView, width, height, cssWidth, cssHeight, dpr,
      });
      device.queue.submit([enc.finish()]);
    }
    await device.queue.onSubmittedWorkDone();
    const throughputMs = (performance.now() - t1) / frames;
    const encoder = device.createCommandEncoder();
    encoder.resolveQuerySet(querySet, 0, 2 * frames, resolveBuffer, 0);
    encoder.copyBufferToBuffer(resolveBuffer, 0, readBuffer, 0, 16 * frames);
    device.queue.submit([encoder.finish()]);
    await readBuffer.mapAsync(1 /* GPUMapMode.READ */);
    const stamps = new BigInt64Array(readBuffer.getMappedRange().slice(0));
    readBuffer.unmap();
    const ms = [];
    for (let i = 0; i < frames; i += 1) ms.push(Number(stamps[2 * i + 1] - stamps[2 * i]) / 1e6);
    ms.sort((a, b) => a - b);
    const at = (/** @type {number} */ q) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))];
    const info = /** @type {any} */ (adapter).info ?? {};
    return { width, height, frames, throughputMs, medianMs: at(0.5), p95Ms: at(0.95), maxMs: ms[ms.length - 1], budgetMs: 1000 / 120, adapter: `${info.vendor ?? '?'} ${info.architecture ?? ''}`.trim() };
  } finally {
    instance.destroy?.();
    canvas.remove();
    device.destroy();
  }
}
