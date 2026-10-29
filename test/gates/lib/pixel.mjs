// Pixel oracles shared by the gates. The pixels under test are the CANVAS BACKING STORE (readCanvas), never a compositor screenshot that could contain the
// live DOM: the live layer is opacity:0 over the canvas, so a layer that leaked into view (or a renderer that paints nothing behind a visible layer) must
// not be able to pass. Three independent guards, all required by TEST-PLAN rule 4:
//   1. canvasShot       the 2D backing store, composited over the canvas background (compare with the plain-DOM twin)
//   2. assertLayerHidden the layer's computed opacity is 0 (a visible layer is a bug on its own)
//   3. compositorShot   a screenshot taken with the layer forced invisible (for WebGPU surfaces, where readback is unreliable)
import { H } from './gate.mjs';
import { contentBox, boxEdgeDistance } from '../../harness/lib/pixels.mjs';

export { contentBox, boxEdgeDistance };

/** All <hic-layer> elements of the document and of open shadow roots. */
const FIND_LAYERS = `(() => { const out = []; const walk = (root) => { for (const e of root.querySelectorAll('*')) { if (e.localName === 'hic-layer') out.push(e); if (e.shadowRoot) walk(e.shadowRoot); } }; walk(document); return out; })()`;

/** Computed opacity/visibility of every live layer. @returns {Promise<{count:number, opacities:string[], visible:number}>} */
export function layerState(page) {
  return page.evaluate(`(() => { const L = ${FIND_LAYERS}; const o = L.map((e) => getComputedStyle(e).opacity); return { count: L.length, opacities: o, visible: o.filter((v) => v !== '0').length }; })()`);
}

/** The live layer exists and is invisible: computed opacity 0 on every layer. */
export async function assertLayerHidden(ctx, page, what) {
  const s = await layerState(page);
  ctx.check(`${what}: the live layer is present and invisible (computed opacity 0)`, s.count >= 1 && s.visible === 0, s, 'leak');
  return s;
}

/** Page-side: canvas geometry and the first opaque background colour of the canvas or an ancestor (white when none). */
const GEO_JS = (selector) => `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect();
  let bg = [255, 255, 255]; for (let n = e; n; n = n.parentElement) { const m = getComputedStyle(n).backgroundColor.match(/[\\d.]+/g); if (m && (m[3] === undefined || +m[3] === 1) && !(m.length === 4 && +m[3] === 0)) { bg = [+m[0], +m[1], +m[2]]; break; } }
  return { x: r.left, y: r.top, width: r.width, height: r.height, dpr: devicePixelRatio, bg, canvasW: e.width ?? 0, canvasH: e.height ?? 0 }; })()`;

/** Backing store of a 2D canvas as RGBA, composited over its background. The page must be foreground (readCanvas waits for rAF). */
export async function canvasShot(page, selector = '#hic-surface') {
  const geo = await page.evaluate(GEO_JS(selector));
  if (!geo) throw new Error('canvasShot: element not found ' + selector);
  const img = H.compositeOver(await H.readCanvas(page, selector), geo.bg);
  return { img, geo };
}

/**
 * Compositor screenshot of the surface with the live layer forced invisible by `filter:opacity(0)` on the layer elements. Not `visibility:hidden` or `display:none`:
 * the capture reads inherited styles from the layer, so those would blank the snapshot itself. `filter` is not inherited, does not move or focus-blur anything, and
 * hides the layer even when its own opacity leaked to 1.
 */
export async function compositorShot(page, selector = '#hic-surface') {
  await page.evaluate(`(() => { for (const e of ${FIND_LAYERS}) e.style.setProperty('filter', 'opacity(0)', 'important'); return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); })()`);
  try { return await H.screenshotElement(page, selector); } finally { await page.evaluate(`(() => { for (const e of ${FIND_LAYERS}) e.style.removeProperty('filter'); })()`); }
}

/** css rect (viewport coordinates of `origin`) -> device-pixel box inside an image of `w` x `h`. */
export function deviceBox(rect, origin, dpr, img, pad = 0) {
  const x = Math.max(0, Math.floor((rect.x - origin.x) * dpr) - pad);
  const y = Math.max(0, Math.floor((rect.y - origin.y) * dpr) - pad);
  const x2 = Math.min(img.width, Math.ceil((rect.x - origin.x + rect.width) * dpr) + pad);
  const y2 = Math.min(img.height, Math.ceil((rect.y - origin.y + rect.height) * dpr) + pad);
  return { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
}

/** Compare two images over one css rect. Returns {fraction, countOver, maxDiff, box, content} (content = non-dominant fraction of the TWIN region). */
export function regionCompare(poly, twin, rect, origin, dpr, { tolerance = 6, pad = 1 } = {}) {
  const box = deviceBox(rect, origin, dpr, poly, pad);
  if (!box.w || !box.h) return { fraction: 1, countOver: 0, maxDiff: 0, box, content: 0, empty: true };
  const a = H.cropImage(poly, box.x, box.y, box.w, box.h);
  const b = H.cropImage(twin, box.x, box.y, box.w, box.h);
  const c = H.compareImages(a, b, { tolerance, diffImage: false });
  return { fraction: c.fraction, countOver: c.countOver16, maxDiff: c.maxDiff, box, content: H.pixelStats(b).nonDominantFraction };
}

/**
 * The full oracle for one canvas-vs-twin pair (both are device-pixel images of the same css rect).
 *   - both images carry content, and the canvas carries about as much as the twin (a renderer that paints too little or too much)
 *   - the whole surface: delta > 16 on <= 3 % (the project gate) AND a tight pass (`tight.tolerance`, `tight.max`) that sees a 10 % tint and a 1-6 px shift
 *   - every named region (an element's rectangle): its own tight fraction, so a small element cannot hide in a big flat canvas
 * @param {*} ctx gate context
 * @param {{name:string, poly:any, twin:any, dpr:number, origin?:{x:number,y:number}, regions?:{name:string,rect:{x:number,y:number,width:number,height:number}}[],
 *   minContent?:number, tight?:{tolerance:number,max:number}, regionMax?:number, regionTolerance?:number, numbers?:object}} o
 */
export function checkSurface(ctx, { name, poly, twin, dpr, origin = { x: 0, y: 0 }, regions = [], minContent = 0.004, tight = { tolerance: 6, max: 0.003 }, regionMax = 0.01, regionTolerance = 6, numbers = {} }) {
  const ps = H.pixelStats(poly), ts = H.pixelStats(twin);
  ctx.check(`${name}: the plain-DOM twin has content (non-dominant >= ${minContent}), so a blank cannot fit the budget`, ts.nonDominantFraction >= minContent, { nonDominantFraction: ts.nonDominantFraction }, 'content');
  ctx.check(`${name}: the canvas is not blank`, ps.nonBlank, { distinctColors: ps.distinctColors, nonDominantFraction: ps.nonDominantFraction }, 'content');
  const ratio = ts.nonDominantFraction > 0 ? ps.nonDominantFraction / ts.nonDominantFraction : 0;
  ctx.check(`${name}: canvas content amount is within 25 % of the twin`, ratio > 0.8 && ratio < 1.25, { canvas: ps.nonDominantFraction, twin: ts.nonDominantFraction, ratio }, 'content');
  const loose = H.compareImages(poly, twin);
  const strict = H.compareImages(poly, twin, { tolerance: tight.tolerance, diffImage: false });
  const rec = { content: ps.nonDominantFraction, twinContent: ts.nonDominantFraction, sizeMatch: loose.sizeMatch };
  if (loose.sizeMatch) Object.assign(rec, { fraction: loose.fraction, countOver16: loose.countOver16, maxDiff: loose.maxDiff, bbox: loose.overBBox, tightFraction: strict.fraction, tightCount: strict.countOver16 });
  numbers[name] = rec;
  ctx.check(`${name}: O-pixel <= 3 % (delta > 16) against the plain-DOM twin`, loose.sizeMatch && loose.fraction <= 0.03, { fraction: loose.fraction, countOver16: loose.countOver16, sizes: loose.sizes ?? null, bbox: loose.overBBox }, 'pixel');
  ctx.check(`${name}: tight pass (delta > ${tight.tolerance} on <= ${tight.max * 100} % of pixels): catches tints and 1-6 px shifts`, strict.sizeMatch && strict.fraction <= tight.max, { fraction: strict.fraction, countOver: strict.countOver16, maxDiff: strict.maxDiff, bbox: strict.overBBox }, 'pixel');
  const worst = [];
  for (const r of regions) {
    const c = regionCompare(poly, twin, r.rect, origin, dpr, { tolerance: regionTolerance });
    worst.push({ name: r.name, fraction: c.fraction, maxDiff: c.maxDiff, content: c.content });
    ctx.check(`${name}: region ${r.name} matches its twin region (delta > ${regionTolerance} on <= ${regionMax * 100} %) and the twin region has content`, !c.empty && c.fraction <= regionMax && c.content > 0.01, { fraction: c.fraction, maxDiff: c.maxDiff, content: c.content, box: c.box }, 'region');
  }
  if (worst.length) rec.regions = worst;
  return rec;
}

/**
 * Positional check: the canvas content lands where the twin's does, every edge of its bounding box within `maxEdge` device px of the twin's.
 * A fraction budget cannot see a shift on a sparse page: there the pixels a shift changes are at most twice the content, which can be close to the budget
 * itself (the explainer's typed state has 0.8 % content against a 1 % budget). The box moves by the whole shift, however little content the page has.
 */
export function checkContentBox(ctx, { name, poly, twin, bg, tolerance = 16, maxEdge = 1, numbers = {} }) {
  const canvas = contentBox(poly, bg, tolerance), plain = contentBox(twin, bg, tolerance);
  const edge = boxEdgeDistance(canvas, plain);
  numbers[`${name} content box`] = { canvas, twin: plain, edge };
  ctx.check(`${name}: the content bounding box (delta > ${tolerance} from the background) matches the twin's, every edge within ${maxEdge} device px: catches a whole-content shift of any size`, edge <= maxEdge, { canvas, twin: plain, edge }, 'pixel');
  return { canvas, twin: plain, edge };
}

/**
 * Read both pages and run checkSurface. The twin is read from a compositor screenshot (it is plain DOM), the polyfill page from the CANVAS BACKING STORE.
 * Each page is brought to the foreground before it is read. `box: {maxEdge, tolerance}` adds the positional check (checkContentBox) over the same two images.
 */
export async function compareToTwin(ctx, { ref, page, name, selector = '#hic-surface', refSelector = selector, numbers, polyFirst = false, box = null, ...opts }) {
  const rest = opts;
  // polyFirst: read the polyfill canvas while its tab is still in front. Hiding the tab and showing it again makes the polyfill re-snapshot everything, which would hide a missed damage.
  let poly;
  if (polyFirst) { await ctx.focus(page); await assertLayerHidden(ctx, page, name); poly = await canvasShot(page, selector); }
  await ctx.focus(ref);
  const twin = await H.screenshotElement(ref, refSelector);
  const regions = typeof rest.regions === 'function' ? await rest.regions(ref) : rest.regions;
  if (!polyFirst) { await ctx.focus(page); await assertLayerHidden(ctx, page, name); poly = await canvasShot(page, selector); }
  maskOutsideViewport(poly.img, twin.img, twin.geo);
  const sizeOk = poly.img.width === twin.img.width && poly.img.height === twin.img.height;
  ctx.check(`${name}: canvas backing store size equals the twin's device-pixel size`, sizeOk, { canvas: [poly.img.width, poly.img.height], twin: [twin.img.width, twin.img.height] }, 'pixel');
  const rec = checkSurface(ctx, { name, poly: poly.img, twin: twin.img, dpr: twin.geo.dpr, origin: { x: twin.geo.x, y: twin.geo.y }, numbers, ...opts, regions: regions ?? [] });
  if (box) rec.box = checkContentBox(ctx, { name, poly: poly.img, twin: twin.img, bg: poly.geo.bg, numbers, ...box });
  return { poly, twin, rec };
}

/** Write the three images of a failed comparison next to the results (never in a control run). */
export async function dumpFailure(ctx, name, poly, twin) {
  if (ctx.control) return;
  const { writeFileSync } = await import('node:fs');
  const { RESULTS } = await import('./gate.mjs');
  const base = `${RESULTS}/${ctx.id}-${name.replace(/[^a-z0-9]+/gi, '-')}`;
  writeFileSync(`${base}.poly.png`, H.encodePng(poly));
  writeFileSync(`${base}.ref.png`, H.encodePng(twin));
  const c = H.compareImages(poly, twin);
  if (c.sizeMatch) writeFileSync(`${base}.diff.png`, H.encodePng(c.diffImage));
}

/** Share of pixels in a css rect of the canvas image whose colour is within `tol` of `rgb` (read from CANVAS pixels). */
export function colorShare(img, rect, origin, dpr, rgb, tol = 24) {
  const b = deviceBox(rect, origin, dpr, img);
  let hit = 0;
  for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) {
    const i = (y * img.width + x) * 4;
    if (Math.max(Math.abs(img.data[i] - rgb[0]), Math.abs(img.data[i + 1] - rgb[1]), Math.abs(img.data[i + 2] - rgb[2])) <= tol) hit++;
  }
  return b.w * b.h ? hit / (b.w * b.h) : 0;
}

/** The twin screenshot only holds what is inside the viewport; the canvas readback holds everything. Blank the part outside the viewport in BOTH images. */
export function maskOutsideViewport(a, b, geo) {
  const dpr = geo.dpr;
  const x0 = Math.max(0, Math.round(-geo.x * dpr)), y0 = Math.max(0, Math.round(-geo.y * dpr));
  const x1 = Math.min(a.width, Math.round((geo.innerWidth - geo.x) * dpr)), y1 = Math.min(a.height, Math.round((geo.innerHeight - geo.y) * dpr));
  if (x0 === 0 && y0 === 0 && x1 >= a.width && y1 >= a.height) return false;
  for (const img of [a, b]) {
    if (img.width !== a.width || img.height !== a.height) continue;
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
      if (x >= x0 && x < x1 && y >= y0 && y < y1) continue;
      const i = (y * img.width + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = 0; img.data[i + 3] = 255;
    }
  }
  return true;
}
