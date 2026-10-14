// Browser test rig for the effects module: a real <canvas> (WebGPU), a fake live layer with real DOM controls, a fake store that serves a 2D
// surface the test paints, and a manually ticked scheduler. Everything the host depends on is faked; the GPU, the DOM and the host are real.
import { fixture } from '/test/unit/lib/t.js';
import { createBus } from '/src/util/bus.js';
import { BUS } from '/src/contracts/events.js';

export async function gpuAvailable() {
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) return false;
    (await adapter.requestDevice()).destroy();
    return true;
  } catch { return false; }
}

/**
 * @param {{w?: number, h?: number, html?: string, paint?: (ctx: CanvasRenderingContext2D, w: number, h: number) => void}} [opts]
 */
export function makeRig({ w = 480, h = 320, html = '', paint } = {}) {
  const root = fixture(`<canvas id="c" width="${w}" height="${h}" style="display:block;width:${w}px;height:${h}px"></canvas><div id="layer" style="position:absolute;left:0;top:0;width:${w}px;height:${h}px">${html}</div>`, { position: 'relative', width: `${w}px`, height: `${h}px` });
  const canvas = /** @type {HTMLCanvasElement} */ (root.querySelector('#c'));
  const layerEl = /** @type {HTMLElement} */ (root.querySelector('#layer'));
  const source = layerEl;
  const surface = document.createElement('canvas');
  surface.width = w; surface.height = h;
  const ctx = /** @type {CanvasRenderingContext2D} */ (surface.getContext('2d'));
  const bus = createBus();
  const reports = [];
  const reporter = { caught: (error, where) => reports.push({ error, where }), unsupported: (entry) => reports.push({ unsupported: entry }) };
  const layer = {
    element: layerEl,
    isMounted: () => true,
    drawableElements: () => [source],
    elementAtPoint: (p) => document.elementFromPoint(p.x, p.y)?.closest('#layer *') ?? null,
  };
  const record = { id: 1, canvas, layer, contentBox: { width: w, height: h, gridScaleX: 1, gridScaleY: 1 } };
  let version = null;
  let versionId = 0;
  const store = {
    version: () => version,
    rasterSource: (v, r) => {
      const x0 = Math.max(0, r.sx), y0 = Math.max(0, r.sy), x1 = Math.min(v.width, r.sx + r.sw), y1 = Math.min(v.height, r.sy + r.sh);
      return x1 > x0 && y1 > y0 ? { source: v.surface, sx: x0, sy: y0, sw: x1 - x0, sh: y1 - y0 } : null;
    },
  };
  const env = {
    window, document, options: { maxDpr: 1, defaultFrameCap: 0 }, bus, reporter, store,
    registry: { get: (c) => (c === canvas ? record : undefined) },
    now: () => performance.now(),
  };
  const hooks = [];
  const scheduler = {
    wakes: 0,
    addFrameHook: (rec, hook) => { hooks.push(hook); return () => { const i = hooks.indexOf(hook); if (i >= 0) hooks.splice(i, 1); }; },
    wake() { scheduler.wakes += 1; },
    requestPaint() { scheduler.wakes += 1; },
  };
  const geometry = { calls: [], update: (rec, el, o) => geometry.calls.push(['update', o]), clear: () => geometry.calls.push(['clear']), get: () => new DOMMatrix() };
  const tracker = { mapped: [], snapshot: () => ({}), setMappedTarget: (rec, el) => tracker.mapped.push(el), onChange: () => () => {} };
  const deps = { store, scheduler, geometry, tracker };

  const rig = {
    root, canvas, layerEl, source, surface, ctx, bus, reports, record, store, env, deps, scheduler, geometry, tracker, w, h,
    /** repaint the surface and publish a new SnapshotVersion */
    commit(dirty = null, draw = paint) {
      if (dirty) { ctx.save(); ctx.beginPath(); ctx.rect(dirty.x, dirty.y, dirty.width, dirty.height); ctx.clip(); }
      else ctx.clearRect(0, 0, w, h);
      draw?.(ctx, w, h);
      if (dirty) ctx.restore();
      version = { id: ++versionId, element: new WeakRef(source), width: w, height: h, surface, dirty };
      bus.emit(BUS.SOURCE_VERSION, { record, version });
      return version;
    },
    /** run the host's frame hook once; returns its result */
    tick(now = performance.now(), due = true, frameCap = 0) {
      let result;
      for (const hook of [...hooks]) result = hook(now, { frameCap, due });
      return result;
    },
    hookCount: () => hooks.length,
    /**
     * The canvas as ImageData. MUST run in the same task as the submit that rendered it: a WebGPU canvas reads back blank once its
     * texture has been presented (verified: drawImage after a rendering update returns transparent black).
     */
    snap() {
      const c = document.createElement('canvas');
      c.width = canvas.width; c.height = canvas.height;
      const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d', { willReadFrequently: true }));
      g.drawImage(canvas, 0, 0);
      return g.getImageData(0, 0, c.width, c.height);
    },
  };
  return rig;
}

/** Share of pixels that are not (almost) the same colour as the most common one: 0 for a blank/flat canvas. @param {ImageData} img */
export function nonDominantShare(img) {
  const counts = new Map();
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const top = Math.max(...counts.values());
  return 1 - top / (d.length / 4);
}

/** Pixel at (x, y) as [r, g, b, a]. @param {ImageData} img @param {number} x @param {number} y */
export function px(img, x, y) {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}
