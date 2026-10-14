// Page side of oracle.driver.mjs: captures every direct child of the plain-DOM fixture surface with the real capture module.
import { createBus } from '/src/util/bus.js';
import { createCapture } from '/src/snapshot/capture/capture.js';
import { createResourceCache } from '/src/snapshot/capture/inline-resources.js';
import { fakeLayer } from './_support.mjs';

const reported = [];
const env = {
  window, document, options: { nodeBudget: { soft: 350, hard: 3000, absolute: 20000 }, inkMargin: 24 }, bus: createBus(),
  reporter: { unsupported: (e) => reported.push(e), deviation() {}, caught: (e, w) => reported.push({ feature: 'caught', message: `${w}: ${e}` }), entries: () => reported },
  now: () => performance.now(), isManagedLayerNode: (el) => el.hasAttribute('data-hic-node'),
};
const resources = createResourceCache(env);
const capture = createCapture(env);

/** @returns {number[]} rgb of the first non-transparent background from the element up */
function backgroundOf(el) {
  for (let e = el; e; e = e.parentElement) {
    const m = getComputedStyle(e).backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [];
    if (m.length === 3 || (m.length === 4 && m[3] > 0.99)) return m.slice(0, 3);
  }
  return [255, 255, 255];
}

/**
 * @param {string} surfaceSelector  the div that replaced the canvas
 * @param {{scale: number, prune?: boolean, rect?: object, scroll?: Record<string, number>, hover?: string, focus?: string}} o
 */
export async function run(surfaceSelector, o) {
  const surface = document.querySelector(surfaceSelector);
  for (const [sel, top] of Object.entries(o.scroll ?? {})) document.querySelector(sel).scrollTop = top;
  if (o.scroll) await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const layer = fakeLayer(surface);
  const record = { id: 1, canvas: surface, root: document, layer, state: 'active' };
  const out = [];
  for (const el of [...surface.children]) {
    if (!el.getClientRects().length || ['SCRIPT', 'STYLE'].includes(el.tagName)) continue;
    el.setAttribute('drawable', '');
  }
  for (const el of [...surface.children].filter((e) => e.hasAttribute('drawable'))) {
    const size = layer.borderBoxSize(el);
    const focus = o.focus ? document.querySelector(o.focus) : null;
    const hover = new Set();
    for (let e = o.hover ? document.querySelector(o.hover) : null; e && e !== surface; e = e.parentElement) hover.add(e);
    const req = { record, element: el, rect: o.rect ?? null, scale: o.scale, ink: { left: 0, top: 0, right: 0, bottom: 0 }, generation: 1, resources, prune: !!o.prune,
      interaction: { hover, active: new Set(), focus, focusVisible: !!focus, caretVisible: true } };
    let r = capture(req);
    for (let tries = 0; !r.complete && tries < 20; tries++) { await new Promise((ok) => setTimeout(ok, 50)); r = capture(req); }
    const img = new Image(); img.src = r.url; await img.decode();
    const c = document.createElement('canvas'); c.width = r.widthPx; c.height = r.heightPx;
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const rect = el.getBoundingClientRect();
    out.push({
      id: el.id || el.tagName, png: c.toDataURL('image/png'), rect: { x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height }, bg: backgroundOf(surface),
      nodes: r.nodes, complete: r.complete, unsupported: r.unsupported, bytes: r.timings.bytes, ms: r.timings,
    });
  }
  return out;
}
