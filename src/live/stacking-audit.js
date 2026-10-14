/**
 * Stacking audit: page content that natively paints above a non-positioned canvas but is covered by the layer's drawn drawables (docs/ARCHITECTURE.md ADR-L).
 * Module: live (src/live/*).
 */

import { isLayerElement } from './drawables.js';
import { styleOf } from './measure.js';

/** @typedef {import('../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../contracts/types.js').StackingFinding} StackingFinding */

const GRID = [0.02, 0.5, 0.98];
const MAX_SCANNED = 3000;
const MAX_CANDIDATES = 8;

/** @typedef {{left: number, top: number, right: number, bottom: number}} Box */

/** @param {DOMRect|Box} r @returns {Box} */
const box = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });

/** @param {Box} a @param {Box} b @returns {Box|null} */
function intersect(a, b) {
  const out = { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
  return out.right > out.left && out.bottom > out.top ? out : null;
}

/** @param {Box} b @returns {Array<{x: number, y: number}>} centre and edge midpoints, 1px inside */
function edgePoints(b) {
  const cx = (b.left + b.right) / 2;
  const cy = (b.top + b.bottom) / 2;
  const pad = Math.min(1, (b.right - b.left) / 2, (b.bottom - b.top) / 2);
  return [{ x: cx, y: cy }, { x: cx, y: b.top + pad }, { x: cx, y: b.bottom - pad }, { x: b.left + pad, y: cy }, { x: b.right - pad, y: cy }];
}

/** Positioned page elements whose box overlaps `area`: their boundary is where a stacking mismatch starts, which a coarse grid can miss. */
function overlapCandidates(/** @type {Document|ShadowRoot} */ root, /** @type {CanvasRecord} */ record, /** @type {HTMLElement} */ layerEl, /** @type {Box} */ area) {
  /** @type {Box[]} */
  const out = [];
  let scanned = 0;
  for (const el of root.querySelectorAll('*')) {
    if (++scanned > MAX_SCANNED || out.length >= MAX_CANDIDATES) break;
    if (el === record.canvas || layerEl.contains(el) || el.contains(record.canvas) || isLayerElement(el)) continue;
    const hit = intersect(box(el.getBoundingClientRect()), area);
    if (!hit || styleOf(el).position === 'static') continue;
    out.push(hit);
  }
  return out;
}

/** @param {Box} area @param {Box[]} candidates @returns {Array<{x: number, y: number}>} */
function samplePoints(area, candidates) {
  const w = area.right - area.left;
  const h = area.bottom - area.top;
  const points = GRID.flatMap((fy) => GRID.map((fx) => ({ x: area.left + w * fx, y: area.top + h * fy })));
  for (const c of candidates) points.push(...edgePoints(c));
  return points;
}

/**
 * @param {Element[]} between  elements listed after the layer hit and before the canvas
 * @param {Element} canvas
 * @param {HTMLElement} layerEl
 * @returns {Element[]} the outermost page elements among them
 */
function culprits(between, canvas, layerEl) {
  const pool = between.filter((el) => !layerEl.contains(el) && !el.contains(canvas) && !isLayerElement(el) && !el.hasAttribute('data-hic-node'));
  return pool.filter((el) => !pool.some((other) => other !== el && other.contains(el)));
}

/**
 * For sample points of each drawn drawable (3 x 3 grid of its visible rect plus the boundary points of every positioned element that overlaps it): list = elementsFromPoint(p) (no style mutation, never toggles the layer display).
 * Elements positioned BETWEEN the drawn drawable (or any layer node) and the canvas in that list are above the canvas natively and below the layer: findings.
 * A point where the layer is hit but the canvas is absent from the list (an unclipped scroller hides it) yields a finding whose `covered` is the canvas itself.
 * Rate limiting belongs to the caller; the pure scan has none. The caller reports `stacking-overlap` once per (canvas, element).
 * @param {CanvasRecord} record
 * @param {HTMLElement} layerEl
 * @param {Element[]} drawn  drawn drawables (hit-testable)
 * @returns {StackingFinding[]}
 */
export function auditStacking(record, layerEl, drawn) {
  const root = record.root;
  const win = /** @type {Window} */ (layerEl.ownerDocument.defaultView);
  const viewport = { left: 0, top: 0, right: win.innerWidth, bottom: win.innerHeight };
  const canvasBox = intersect(box(record.canvas.getBoundingClientRect()), viewport);
  const canvasHittable = styleOf(record.canvas).visibility !== 'hidden' && styleOf(record.canvas).pointerEvents !== 'none';
  /** @type {StackingFinding[]} */
  const findings = [];
  /** @type {Set<Element>} */
  const seen = new Set();
  if (!canvasBox) return findings;
  for (const drawable of drawn) {
    const area = intersect(box(drawable.getBoundingClientRect()), canvasBox);
    if (!area) continue;
    for (const point of samplePoints(area, overlapCandidates(root, record, layerEl, area))) {
      const list = root.elementsFromPoint(point.x, point.y);
      const top = list.findIndex((el) => el !== layerEl && layerEl.contains(el));
      if (top < 0 || !drawable.contains(list[top])) continue;
      const canvasAt = list.indexOf(record.canvas);
      const covered = canvasAt < 0 ? (canvasHittable ? [record.canvas] : []) : culprits(list.slice(top + 1, canvasAt), record.canvas, layerEl);
      for (const el of covered) {
        if (seen.has(el)) continue;
        seen.add(el);
        findings.push({ drawable, covered: el, point });
      }
    }
  }
  return findings;
}
