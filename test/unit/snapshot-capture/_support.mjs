// Browser-side helpers of the snapshot-capture tests: a real window, a fake live layer built on getBoundingClientRect (no transforms), a pixel oracle.
import { createBus } from '/src/util/bus.js';
import { createCapture } from '/src/snapshot/capture/capture.js';
import { createResourceCache } from '/src/snapshot/capture/inline-resources.js';
import { fixture } from '/test/unit/lib/t.js';

export const NODE_BUDGET = { soft: 350, hard: 3000, absolute: 20000 };

/** @param {object} [opts] */
export function makeEnv(opts = {}) {
  const reported = [];
  const caught = [];
  const consoleOnce = new Set();
  const reporter = {
    unsupported(e) { reported.push(e); consoleOnce.add(`${e.feature}|${e.path ?? ''}`); },
    deviation() {}, caught(err, where) { caught.push({ err, where }); }, entries: () => reported,
  };
  const env = {
    window, document, options: { nodeBudget: { ...NODE_BUDGET, ...(opts.nodeBudget ?? {}) }, inkMargin: 24, strictResources: false }, bus: createBus(), reporter, now: () => performance.now(),
    isManagedLayerNode: (el) => el.hasAttribute('data-hic-node'),
  };
  return { env, reported, caught, consoleOnce };
}

/** A LiveLayer over a plain element: rects come from getBoundingClientRect, valid because tests apply no transforms. */
export function fakeLayer(layerEl) {
  const drawables = () => [...layerEl.querySelectorAll('[drawable]')];
  const size = (el) => { if (!el.getClientRects().length) return null; const r = el.getBoundingClientRect(); return { width: r.width, height: r.height }; };
  const nearest = (node) => { const el = node.nodeType === 1 ? node : node.parentElement; return el?.closest('[drawable]') ?? null; };
  return {
    element: layerEl, mount() {}, unmount() {}, isMounted: () => true, syncPresentation() {}, logicalChildNodes: () => [...layerEl.childNodes], drawableElements: drawables,
    nearestDrawable: nearest, isLaidOut: (el) => el.getClientRects().length > 0, borderBoxSize: size,
    borderBoxRectInLayer(el) { if (!el.getClientRects().length) return null; const r = el.getBoundingClientRect(); const l = layerEl.getBoundingClientRect(); return { x: r.left - l.left, y: r.top - l.top, width: r.width, height: r.height }; },
    frameRect(el) {
      const d = nearest(el); if (!d || !el.getClientRects().length) return null;
      const dr = d.getBoundingClientRect(); const r = el.getBoundingClientRect();
      return { x: r.left - dr.left, y: r.top - dr.top, width: r.width, height: r.height };
    },
    elementAtPoint: () => null, dispose() {},
  };
}

/**
 * Mounts `<canvas><hic-layer>children</hic-layer>` the way the live module lays it out: the layer is an absolutely positioned, visible (tests read pixels from a clone, not from the page) box.
 * @param {string} html  layer content; drawables carry the `drawable` attribute
 * @param {{css?: string, width?: number, height?: number, layerStyle?: string, envOpts?: object}} [o]
 */
export function mount(html, o = {}) {
  const w = o.width ?? 400;
  const h = o.height ?? 300;
  const host = fixture(`${o.css ? `<style>${o.css}</style>` : ''}<canvas id="c" content="drawable" width="${w}" height="${h}" class="cv" style="display:none"></canvas>`
    + `<hic-layer data-hic-layer="1" data-hic-node style="display:block;position:absolute;left:10px;top:10px;width:${w}px;height:${h}px;${o.layerStyle ?? ''}">${html}</hic-layer>`, { position: 'relative' });
  const layerEl = host.querySelector('hic-layer');
  const canvas = host.querySelector('canvas');
  const layer = fakeLayer(layerEl);
  const record = { id: 1, canvas, root: document, layer, state: 'active' };
  const { env, ...rest } = makeEnv(o.envOpts);
  const resources = createResourceCache(env);
  const capture = createCapture(env);
  const noInteraction = { hover: new Set(), active: new Set(), focus: null, focusVisible: false, caretVisible: true };
  /** @param {Element} el @param {object} [over] */
  const request = (el, over = {}) => {
    const size = layer.borderBoxSize(el);
    return { record, element: el, rect: null, scale: 1, ink: { left: 0, top: 0, right: 0, bottom: 0 }, generation: 1, resources, prune: false, interaction: noInteraction, ...over, size };
  };
  return { host, layerEl, canvas, layer, record, env, resources, capture, request, ...rest };
}

/** Decode a capture result into a canvas of widthPx x heightPx. */
export async function rasterize(result) {
  const img = new Image();
  img.src = result.url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = result.widthPx; c.height = result.heightPx;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0, c.width, c.height);
  return x;
}

/** Fraction of pixels whose channel delta exceeds `level` between two contexts of the same size. */
export function diffFraction(a, b, level = 16) {
  const w = a.canvas.width, h = a.canvas.height;
  if (b.canvas.width !== w || b.canvas.height !== h) throw new Error(`size mismatch ${w}x${h} vs ${b.canvas.width}x${b.canvas.height}`);
  const da = a.getImageData(0, 0, w, h).data, db = b.getImageData(0, 0, w, h).data;
  let n = 0;
  for (let i = 0; i < da.length; i += 4) {
    if (Math.abs(da[i] - db[i]) > level || Math.abs(da[i + 1] - db[i + 1]) > level || Math.abs(da[i + 2] - db[i + 2]) > level || Math.abs(da[i + 3] - db[i + 3]) > level) n++;
  }
  return n / (w * h);
}

/** Share of pixels that are not fully transparent: a blank tile must never pass an oracle. */
export function inkFraction(x) {
  const { data } = x.getImageData(0, 0, x.canvas.width, x.canvas.height);
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n++;
  return n / (data.length / 4);
}

/**
 * Reference rendering by hand: the markup of the intended state written explicitly (no clone, no rewriting), rendered in an SVG image like the tile.
 * It is the oracle for tests that cannot use a screenshot; the true plain-DOM oracle is test/unit/snapshot-capture/oracle.driver.mjs.
 */
export async function reference(html, css, w, h, scale = 1) {
  const holder = document.createElement('div');
  holder.innerHTML = html;
  html = new XMLSerializer().serializeToString(holder).replace(/^<div[^>]*>|<\/div>$/g, '').replace(/^<div[^>]*\/>$/, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w * scale}" height="${h * scale}"><foreignObject width="${w * scale}" height="${h * scale}"><style xmlns="http://www.w3.org/1999/xhtml">${css}</style>`
    + `<div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:${w}px;height:${h}px;overflow:hidden;${scale !== 1 ? `zoom:${scale};` : ''}">${html}</div></foreignObject></svg>`;
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale); c.height = Math.round(h * scale);
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  return x;
}
