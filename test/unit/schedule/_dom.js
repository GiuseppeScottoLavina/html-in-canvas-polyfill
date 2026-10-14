// Browser-test helpers: a real env (real window/document) with recording stand-ins for the parts other modules own
// (scheduler sink, store, live layer built on plain DOM). Served from the repo root like everything else.
import { createBus } from '/src/util/bus.js';
import { fixture } from '/test/unit/lib/t.js';

export function createReporter() {
  return {
    deviations: [],
    errors: [],
    deviation(id, detail) { this.deviations.push([id, detail]); },
    caught(err, where) { this.errors.push([err, where]); },
    unsupported() {},
    entries: () => [],
  };
}

/** Scheduler stand-in that records what the observers publish. */
export function createSink() {
  const sink = {
    damage: [],
    caps: [],
    hooks: new Set(),
    wakes: 0,
    damageFn(record, cause, drawable = null, rect = null) { sink.damage.push({ record, cause, drawable, rect }); },
    setFrameCap(record, fps) { sink.caps.push(fps); },
    addFrameHook(record, hook) { sink.hooks.add(hook); return () => sink.hooks.delete(hook); },
    wake() { sink.wakes++; },
    causes: () => sink.damage.map((d) => d.cause),
    clear() { sink.damage.length = 0; },
  };
  sink.api = { damage: sink.damageFn, setFrameCap: sink.setFrameCap, addFrameHook: sink.addFrameHook, wake: sink.wake };
  return sink;
}

/** A LiveLayer over plain DOM: drawables are the elements with a `drawable` attribute; frameRect is relative to the nearest drawable's border box. */
export function createDomLayer(layerEl, canvas) {
  const layer = {
    element: layerEl,
    mounted: true,
    isMounted: () => layer.mounted,
    drawableElements: () => [...layerEl.querySelectorAll('[drawable]')],
    nearestDrawable(node) {
      const el = node.nodeType === 1 ? node : node.parentElement;
      const d = el?.closest('[drawable]');
      return d && layerEl.contains(d) ? d : null;
    },
    frameRect(el) {
      const d = layer.nearestDrawable(el);
      if (!d || !el.getClientRects().length) return null;
      const r = el.getBoundingClientRect();
      const o = d.getBoundingClientRect();
      return { x: r.left - o.left, y: r.top - o.top, width: r.width, height: r.height };
    },
    syncCalls: 0,
    revalidations: 0,
    revalidateGeometry() { layer.revalidations++; },
    syncPresentation() {
      layer.syncCalls++;
      const r = canvas.getBoundingClientRect();
      return { width: r.width, height: r.height, gridScaleX: canvas.width / (r.width || 1), gridScaleY: canvas.height / (r.height || 1) };
    },
  };
  return layer;
}

let ids = 0;

/** A real env for observers. `html` goes into the layer; returns the pieces a test needs. */
export function createRig({ html = '', options = {}, canvasStyle = 'width:200px;height:100px', canvasAttrs = '' } = {}) {
  const root = fixture(`<canvas id="cv" width="200" height="100" style="${canvasStyle}" ${canvasAttrs}></canvas><div id="layer" style="position:relative;width:200px">${html}</div>`);
  const canvas = root.querySelector('#cv');
  const layerEl = root.querySelector('#layer');
  const layer = createDomLayer(layerEl, canvas);
  const bus = createBus();
  const sink = createSink();
  const reporter = createReporter();
  const record = {
    id: ++ids, canvas, state: 'active', root: document, layer, frameCap: 0, dpr: 1,
    contentBox: { width: 200, height: 100, gridScaleX: 1, gridScaleY: 1 },
    paint: { force: false, serial: 0, lastFireAt: 0, everFired: false, microtaskFrame: -1, waitingSince: null, gateReason: null },
  };
  const store = { invalidated: [], invalidateAll(cause) { store.invalidated.push(cause); } };
  const env = {
    window, document, bus, reporter, now: () => performance.now(),
    options: { defaultFrameCap: 0, inkMargin: 24, interactionFloorFps: 0, maxSnapshotFps: 60, coherentPaint: true, coherenceMaxWaitMs: 50, paintGateMaxWaitMs: 400, ...options },
    registry: { all: () => [record], get: () => record, ownerOfDrawable: () => record, logicalCanvasAncestor: () => null },
    isManagedLayerNode: (el) => el.hasAttribute('data-hic-node'),
    scheduler: sink.api,
    store,
    roots: { roots: () => [document], style: () => ({ geometry: { owns: () => false }, dispose() {} }) },
  };
  return { root, canvas, layerEl, layer, bus, sink, reporter, record, store, env };
}

export const rect = (r) => r && { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
