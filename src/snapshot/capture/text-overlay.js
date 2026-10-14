/**
 * Optimistic text overlay of a focused single-line text field (docs/PERFORMANCE-COMPARISON.md, optimization 1).
 * Module: snapshot-capture (src/snapshot/capture/*).
 *
 * While a key is typed the snapshot of the drawable is one or two frames away (build + async decode). The overlay paints the field's LIVE value into the retained surface in the
 * very next rendering update: the content box is refilled with the backdrop colour and the value is drawn with fillText (same font, colour, spacing, alignment, scrollLeft), the caret is
 * re-measured. The snapshot stays the authority: the next tile that captured this value replaces the overlay. Every case the plan cannot reproduce exactly returns null and the
 * field keeps the plain snapshot path (placeholder, selection, IME composition, right-to-left text, text effects, anything painted over the field, a transformed, filtered
 * or translucent (opacity) ancestor, engines whose controls are drawn by a skin). A backdrop that is not one solid colour (gradient, image, translucent glass over a gradient)
 * comes from a backdrop tile: the field captured once with transparent text (CaptureRequest.hideText), cached by the store until something other than typing changes.
 */

import { currentEngine } from '../../util/engine.js';
import { applyFont, inputMetrics, measureCaret, measuringContext, parseColor, transformText } from './caret-overlay.js';

/** @typedef {import('../../contracts/types.js').Rect} Rect */
/** @typedef {import('../../contracts/types.js').TextOverlayPlan} TextOverlayPlan */

/**
 * single-line text-entry types. Excluded: number (spin buttons share the content box) and search (its cancel button does too, and getComputedStyle cannot read the
 * `::-webkit-search-cancel-button` box: it answers with the field's own style).
 */
const TEXT_TYPES = new Set(['text', 'url', 'tel', 'password', 'email']);
const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿‏‫‮⁧]/;
/** at most this many ancestors between the field and its drawable are inspected (deeper: no overlay) */
const MAX_CHAIN = 24;

/** @param {string} v @returns {number} */
const px = (v) => parseFloat(v) || 0;

/** @param {CSSStyleDeclaration} cs @returns {boolean} the element paints only its background under the text (no effect that the overlay cannot reproduce) */
function plainBox(cs) {
  return (cs.opacity === '1' || cs.opacity === '') && cs.filter === 'none' && (cs.mixBlendMode ?? 'normal') === 'normal' && (cs.backdropFilter ?? 'none') === 'none'
    && (cs.clipPath ?? 'none') === 'none' && ((/** @type {any} */ (cs)).maskImage ?? 'none') === 'none';
}

/** @param {CSSStyleDeclaration} cs @returns {boolean} the text looks like plain fillText */
function plainText(cs) {
  const security = (/** @type {any} */ (cs)).webkitTextSecurity ?? 'none';
  return cs.direction === 'ltr' && cs.writingMode === 'horizontal-tb' && cs.textShadow === 'none' && px(cs.textIndent) === 0 && cs.fontFeatureSettings === 'normal'
    && cs.fontVariationSettings === 'normal' && px((/** @type {any} */ (cs)).webkitTextStrokeWidth ?? '0') === 0 && (cs.textDecorationLine === 'none' || cs.textDecorationLine === '')
    && (cs.fontVariantLigatures === 'normal' || cs.fontVariantLigatures === '') && (cs.fontStretch === '100%' || cs.fontStretch === 'normal') && (security === 'none' || security === 'disc');
}

/**
 * The colour of the content box with the value removed: the field's background composited over its ancestors' up to the drawable (inclusive). undefined when a layer applies an
 * effect the overlay cannot reproduce (no overlay at all); null when a layer is not a solid colour (an image, a gradient: the store uses a backdrop tile instead). An all-transparent
 * chain gives a transparent colour (the surface is transparent there too).
 * @param {Window} win @param {Element} control @param {Element} drawable @returns {string|null|undefined}
 */
function backdropColor(win, control, drawable) {
  /** @type {number[][]} */
  const layers = [];
  let solid = true;
  let n = /** @type {Element|null} */ (control);
  for (let i = 0; n && i < MAX_CHAIN; i++, n = n.parentElement) {
    const cs = win.getComputedStyle(n);
    if (!plainBox(cs) || (n !== drawable && n !== control && cs.transform !== 'none')) return undefined;
    const c = parseColor(cs.backgroundColor);
    if (!c || cs.backgroundImage !== 'none' || (n === control && / inset/.test(` ${cs.boxShadow}`))) solid = false;
    else if (c[3] > 0) layers.push(c);
    if (n === drawable) break;
  }
  if (n !== drawable) return undefined;
  if (!solid) return null;
  let out = [0, 0, 0, 0];
  for (let i = layers.length - 1; i >= 0; i--) {
    const c = layers[i];
    const a = c[3] + out[3] * (1 - c[3]);
    out = a > 0 ? [0, 1, 2].map((k) => (c[k] * c[3] + out[k] * out[3] * (1 - c[3])) / a).concat(a) : [0, 0, 0, 0];
  }
  return `rgba(${Math.round(out[0])},${Math.round(out[1])},${Math.round(out[2])},${out[3]})`;
}

/** @type {WeakMap<Element, {key: string, ok: boolean}>} last obstruction verdict per field */
const verdicts = new WeakMap();

/**
 * Nothing but the field is hit anywhere on a grid over its content box (8 css px columns, three rows): no label, icon, sticky header or clipping ancestor over the text.
 * Points outside the viewport cannot be tested: no overlay. The verdict is cached per field until its box moves or `epoch` changes (the store bumps it on any damage that is not typing).
 * @param {Document} doc @param {Element} control @param {DOMRect} box viewport rect of the content box @param {number} epoch
 */
function unobstructed(doc, control, box, epoch) {
  const key = `${epoch}|${box.left}|${box.top}|${box.width}|${box.height}`;
  const known = verdicts.get(control);
  if (known?.key === key) return known.ok;
  const root = /** @type {Document|ShadowRoot} */ (control.getRootNode());
  const hit = typeof root.elementFromPoint === 'function' ? root : doc;
  const win = doc.defaultView;
  const cols = Math.min(64, Math.ceil(box.width / 8) + 1);
  let ok = box.left >= 0 && box.top >= 0 && box.right <= (win?.innerWidth ?? 0) && box.bottom <= (win?.innerHeight ?? 0);
  for (let c = 0; ok && c < cols; c++) {
    const x = Math.min(box.right - 1, box.left + 1 + ((box.width - 2) * c) / Math.max(1, cols - 1));
    for (const y of [box.top + 1, (box.top + box.bottom) / 2, box.bottom - 1]) if (hit.elementFromPoint(x, y) !== control) { ok = false; break; }
  }
  verdicts.set(control, { key, ok });
  return ok;
}

/**
 * Plan the overlay of `control` (the focused field) inside its drawable. `frame` is the field's border box in the drawable's border-box frame (LiveLayer.frameRect).
 * @param {Document} doc the live document
 * @param {Element} control
 * @param {Element} drawable
 * @param {Rect} frame
 * @param {number} [epoch]  changes whenever something other than typing may have changed the page around the field (obstruction cache key)
 * @returns {TextOverlayPlan|null}
 */
export function planTextOverlay(doc, control, drawable, frame, epoch = 0) {
  if (currentEngine().engine !== 'chromium' || control.nodeName !== 'INPUT') return null;
  const el = /** @type {HTMLInputElement} */ (control);
  if (!TEXT_TYPES.has(el.type) || el.readOnly || el.disabled || !el.value || RTL.test(el.value)) return null;
  const root = /** @type {Document|ShadowRoot} */ (el.getRootNode());
  if (root.activeElement !== el) return null;
  try { if (el.selectionStart !== null && el.selectionStart !== el.selectionEnd) return null; } catch { /* no selection API (email): collapsed by construction after an edit */ }
  const win = doc.defaultView;
  const ctx = measuringContext(doc);
  if (!win || !ctx) return null;
  const cs = win.getComputedStyle(el);
  if (!plainText(cs) || (el.type === 'password') !== (((/** @type {any} */ (cs)).webkitTextSecurity ?? 'none') === 'disc')) return null;
  const fill = backdropColor(win, el, drawable);
  if (fill === undefined) return null;
  const k = el.offsetWidth > 0 ? frame.width / el.offsetWidth : 1;
  const left = frame.x + px(cs.borderLeftWidth) + px(cs.paddingLeft);
  const top = frame.y + px(cs.borderTopWidth) + px(cs.paddingTop);
  const width = el.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight);
  const height = el.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom);
  if (!(width > 0 && height > 0) || Math.abs(k - 1) > 1e-3) return null;
  const vr = el.getBoundingClientRect();
  const box = new DOMRect(vr.left + px(cs.borderLeftWidth) + px(cs.paddingLeft), vr.top + px(cs.borderTopWidth) + px(cs.paddingTop), width, height);
  if (!unobstructed(doc, el, box, epoch)) return null;
  const metrics = inputMetrics(el, cs, ctx, frame);
  applyFont(ctx, cs);
  const text = el.type === 'password' ? '•'.repeat(el.value.length) : transformText(el.value, cs);
  const m = ctx.measureText('Mg');
  const caret = measureCaret(doc, el, frame);
  const color = (/** @type {any} */ (cs)).webkitTextFillColor || cs.color;
  return {
    box: { x: left, y: top, width, height }, fill, text, color, x: metrics.x(0), baseline: metrics.top + m.fontBoundingBoxAscent,
    font: ctx.font, letterSpacing: ctx.letterSpacing, wordSpacing: ctx.wordSpacing, kerning: cs.fontKerning === 'none' ? 'none' : cs.fontKerning === 'normal' ? 'normal' : 'auto',
    caret,
  };
}
