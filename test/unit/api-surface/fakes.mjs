// Fake env / store / layer / registry / scheduler for the api-surface browser tests, built from the contracts in src/contracts/types.js.
// A real window, real DOM and real canvases; only the neighbours of the module (store, layer, scheduler, registry) are fakes that record their calls.
import { assert } from '/test/unit/lib/t.js';
import { createPatchLedger } from '/src/api/patch.js';
import { createBus } from '/src/util/bus.js';
import { resolveOptions } from '/src/api/options.js';
import { createGeometryApi } from '/src/api/geometry.js';

export const COLORS = { tl: [255, 0, 0], tr: [0, 200, 0], bl: [0, 0, 255], br: [255, 255, 0], ink: [255, 0, 255] };

/** @returns {HTMLCanvasElement} a 2D canvas */
function canvas2d(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Surface of a version: border box w x h css px at `scale`, `ink` css px of magenta around it; the border box is four quadrants (tl red, tr green, bl blue, br yellow).
 * @param {number} w @param {number} h @param {number} scale @param {number} ink @param {boolean} [solid] one solid red color instead
 */
export function makeSurface(w, h, scale, ink, solid = false) {
  const surface = canvas2d(Math.ceil((w + 2 * ink) * scale), Math.ceil((h + 2 * ink) * scale));
  const ctx = surface.getContext('2d');
  const css = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
  ctx.fillStyle = css(COLORS.ink);
  ctx.fillRect(0, 0, surface.width, surface.height);
  const quad = (c, x, y, qw, qh) => { ctx.fillStyle = css(c); ctx.fillRect(Math.round((ink + x) * scale), Math.round((ink + y) * scale), Math.round(qw * scale), Math.round(qh * scale)); };
  if (solid) { ctx.fillStyle = css(COLORS.tl); ctx.fillRect(Math.floor(ink * scale), Math.floor(ink * scale), surface.width - Math.floor(ink * scale), surface.height - Math.floor(ink * scale)); return surface; }
  quad(COLORS.tl, 0, 0, w / 2, h / 2);
  quad(COLORS.tr, w / 2, 0, w / 2, h / 2);
  quad(COLORS.bl, 0, h / 2, w / 2, h / 2);
  quad(COLORS.br, w / 2, h / 2, w / 2, h / 2);
  return surface;
}

/** The newest-version map and pin counters of the SnapshotStore contract. */
function createFakeStore() {
  let serial = 0;
  /** @type {Map<Element, any>} */
  const versions = new Map();
  const store = {
    calls: { rasterSource: /** @type {any[]} */ ([]) },
    /** Commit a version for `el` (replaces the previous one). */
    commit(el, o = {}) {
      const width = o.width ?? 40;
      const height = o.height ?? 20;
      const scale = o.scale ?? 1;
      const ink = o.ink ?? 4;
      const v = {
        id: ++serial,
        element: new WeakRef(el),
        canvasId: o.canvasId ?? 1,
        width,
        height,
        canvasWidth: o.canvasWidth ?? 100,
        canvasHeight: o.canvasHeight ?? 100,
        translation: new DOMMatrixReadOnly([1, 0, 0, 1, o.originX ?? width / 2, o.originY ?? height / 2]),
        blend: o.blend ?? 'normal',
        scale,
        ink: { left: ink, top: ink, right: ink, bottom: ink },
        layoutOffset: o.layoutOffset ?? { x: 3, y: 4 },
        surface: o.surface ?? makeSurface(width, height, scale, ink, o.solid),
        pinned: false,
        refs: 0,
        committedAt: 0,
      };
      versions.set(el, v);
      return v;
    },
    drop(el) { versions.delete(el); },
    version: (el) => versions.get(el) ?? null,
    pin(el) {
      const v = versions.get(el);
      if (!v) throw new DOMException('no snapshot', 'InvalidStateError');
      v.refs++;
      v.pinned = true;
      return v;
    },
    unpin(v) { v.refs--; v.pinned = v.refs > 0; },
    rasterSource(v, r) {
      store.calls.rasterSource.push({ version: v, rect: { ...r } });
      const s = v.scale;
      const x0 = Math.max(0, Math.floor((r.sx + v.ink.left) * s + 1e-9));
      const y0 = Math.max(0, Math.floor((r.sy + v.ink.top) * s + 1e-9));
      const x1 = Math.min(v.surface.width, Math.ceil((r.sx + r.sw + v.ink.left) * s - 1e-9));
      const y1 = Math.min(v.surface.height, Math.ceil((r.sy + r.sh + v.ink.top) * s - 1e-9));
      if (!(x1 > x0) || !(y1 > y0)) return null;
      return { source: v.surface, sx: x0, sy: y0, sw: x1 - x0, sh: y1 - y0 };
    },
  };
  return store;
}

/**
 * A complete fake world.
 * @param {{options?: object}} [opts]
 */
export function createWorld(opts = {}) {
  const options = resolveOptions(opts.options);
  const reports = { unsupported: /** @type {any[]} */ ([]), deviation: /** @type {any[]} */ ([]), caught: /** @type {any[]} */ ([]) };
  const reporter = {
    unsupported: (entry, canvas) => { reports.unsupported.push({ ...entry, canvas }); },
    deviation: (id, detail) => { reports.deviation.push({ id, detail }); },
    caught: (err, where) => { reports.caught.push({ err, where }); },
    entries: () => reports.unsupported,
  };
  /** @type {Map<HTMLCanvasElement, any>} */
  const records = new Map();
  const calls = { adopt: /** @type {HTMLCanvasElement[]} */ ([]), requestPaint: /** @type {any[]} */ ([]), paintNow: /** @type {any[]} */ ([]) };
  const store = createFakeStore();
  const scheduler = {
    requestPaint: (record) => { calls.requestPaint.push(record); },
    paintNow: (record) => { calls.paintNow.push(record); return true; },
  };
  const registry = {
    get: (canvas) => records.get(canvas),
    all: () => [...records.values()],
    ownerOfDrawable: (el) => [...records.values()].find((r) => r.layer.nearestDrawable(el) === el),
    logicalCanvasAncestor: (node) => (node instanceof Element ? node.closest('canvas') : null),
  };
  const world = {
    options, reports, calls, store, records,
    ledger: createPatchLedger(window),
    env: /** @type {any} */ (null),
    geometry: /** @type {any} */ (null),
    /** What env.adopt does for a canvas the registry has not seen: create a record when the attributes ask for management. */
    adoptCreates: false,
    /**
     * Register a managed canvas record. `drawables` are the eligible elements (the fake layer's membership).
     * @param {HTMLCanvasElement} canvas
     * @param {{drawables?: Element[], legacy?: boolean, state?: string}} [o]
     */
    addCanvas(canvas, o = {}) {
      const drawables = new Set(o.drawables ?? []);
      const layerCalls = { applyGeometry: /** @type {any[]} */ ([]), setHitTestOrder: /** @type {any[]} */ ([]), syncPresentation: 0 };
      const record = {
        id: records.size + 1,
        canvas,
        state: o.state ?? 'active',
        legacy: o.legacy ?? false,
        root: document,
        store: null,
        frameCap: 0,
        dpr: 1,
        offscreen: new Set(),
        geometry: { byElement: new WeakMap(), order: [] },
        paint: { force: false, serial: 0, lastFireAt: 0, everFired: false, microtaskFrame: -1, waitingSince: null, gateReason: null },
        contentBox: { width: 100, height: 100, gridScaleX: 1, gridScaleY: 1 },
        layerCalls,
        drawables,
        layer: {
          nearestDrawable(node) {
            for (let n = node; n && n !== canvas; n = n.parentNode) if (drawables.has(n)) return n;
            return null;
          },
          applyGeometry: (el, geometry, layoutOffset) => { layerCalls.applyGeometry.push({ el, geometry, layoutOffset }); },
          setHitTestOrder: (order) => { layerCalls.setHitTestOrder.push(order); },
          syncPresentation: () => { layerCalls.syncPresentation++; return record.contentBox; },
        },
      };
      records.set(canvas, record);
      return record;
    },
  };
  world.env = {
    window, document, options, bus: createBus(), reporter, now: () => performance.now(),
    registry, isManagedLayerNode: () => false, store, scheduler, roots: {},
    adopt: (canvas) => { calls.adopt.push(canvas); world.onAdopt?.(canvas); },
  };
  world.geometry = createGeometryApi(world.env);
  return world;
}

/** @param {HTMLCanvasElement|OffscreenCanvas} canvas @param {number} x @param {number} y @returns {number[]} rgba */
export function pixel(canvas, x, y) {
  const ctx = canvas.getContext('2d');
  return Array.from(ctx.getImageData(x, y, 1, 1).data);
}

/** @param {number[]} rgba @param {number[]} rgb @returns {boolean} opaque pixel of that color */
export function isColor(rgba, rgb) {
  return rgba[0] === rgb[0] && rgba[1] === rgb[1] && rgba[2] === rgb[2] && rgba[3] === 255;
}

/** A canvas with one drawable child, both attached to a fixture. */
export function canvasWithChild(root, attrs = 'content="drawable"', size = 100) {
  root.innerHTML = `<canvas id="c" width="${size}" height="${size}" style="width:${size}px;height:${size}px" ${attrs}><div id="el" drawable style="width:40px;height:20px"></div></canvas>`;
  const canvas = /** @type {HTMLCanvasElement} */ (root.querySelector('#c'));
  return { canvas, el: /** @type {HTMLElement} */ (root.querySelector('#el')) };
}

/** Baseline guard: the polyfilled names must be absent from a stock Chrome, or the tests would exercise the native implementation. */
export function assertStockBrowser(assert) {
  assert.ok(!('requestPaint' in HTMLCanvasElement.prototype) && !('drawElementImage' in CanvasRenderingContext2D.prototype),
    'this Chrome has the native HTML-in-Canvas API enabled; run the unit tests on a stock build');
}

/**
 * The common arrangement: fixture with a managed canvas (record + committed version) and the patches installed.
 * @param {any} t test context @param {Function} fixture @param {{options?: object, legacy?: boolean, version?: object, canvasAttrs?: string, size?: number, patches?: Function[]}} [o]
 */
export async function arrange(t, fixture, o = {}) {
  const world = createWorld({ options: o.options });
  const root = fixture('');
  const { canvas, el } = canvasWithChild(root, o.canvasAttrs, o.size);
  const record = world.addCanvas(canvas, { drawables: [el], legacy: o.legacy });
  const version = o.version === null ? null : world.store.commit(el, { canvasId: record.id, ...o.version });
  t.cleanup(() => { world.ledger.restoreAll(); });
  for (const install of o.patches ?? []) install(world.env, world.ledger, world.geometry);
  return { world, root, canvas, el, record, version, env: world.env, ledger: world.ledger, geometry: world.geometry, store: world.store };
}

/** @param {() => any} fn @param {string} name DOMException name; returns the exception */
export function throwsDom(fn, name) {
  try { fn(); } catch (e) {
    assert.ok(e instanceof DOMException && e.name === name, `expected a ${name} DOMException, got ${e?.name}: ${e?.message}`);
    return e;
  }
  return assert.fail(`expected a ${name} DOMException, nothing was thrown`);
}

/** @param {() => Promise<any>} fn @param {string} name rejects with a DOMException of that name */
export async function rejectsDom(fn, name) {
  try { await fn(); } catch (e) {
    assert.ok(e instanceof DOMException && e.name === name, `expected a ${name} DOMException, got ${e?.name}: ${e?.message}`);
    return e;
  }
  return assert.fail(`expected a ${name} rejection`);
}
