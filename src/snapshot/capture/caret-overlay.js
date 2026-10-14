/**
 * Caret measurement and selection overlay for the focused control (feature caret-selection).
 * Module: snapshot-capture (src/snapshot/capture/*).
 */

import { setInlineStyle } from './inline-style.js';
import { fallbackCaretIndex, selectionApiMissing } from '../../util/caret-index.js';
import { rangeRectsIn } from '../../util/selection-rects.js';

/** @typedef {import('../../contracts/types.js').Rect} Rect */

const SINGLE_LINE = new Set(['text', 'search', 'url', 'tel', 'password']);
/** single-line text fields without a selection API (selectionStart null): the caret comes from util/caret-index.js */
const NO_SELECTION_API = new Set(['email', 'number']);
const OVERLAY = 'position:absolute;pointer-events:none;z-index:50;';

/** @type {WeakMap<Document, CanvasRenderingContext2D|null>} */
const contexts = new WeakMap();

/** @param {Document} doc @returns {CanvasRenderingContext2D|null} text measuring context of the LIVE document (its fonts, not those of the inert clone document) */
export function measuringContext(doc) {
  let ctx = contexts.get(doc);
  if (ctx === undefined) {
    ctx = doc.createElement('canvas').getContext('2d');
    contexts.set(doc, ctx);
  }
  return ctx;
}

/** @param {string} v @returns {number} */
const px = (v) => parseFloat(v) || 0;

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {CSSStyleDeclaration} cs
 */
export function applyFont(ctx, cs) {
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  ctx.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
  ctx.wordSpacing = cs.wordSpacing === 'normal' ? '0px' : cs.wordSpacing;
}

/** @param {string} text @param {CSSStyleDeclaration} cs @returns {string} */
export function transformText(text, cs) {
  switch (cs.textTransform) {
    case 'uppercase': return text.toUpperCase();
    case 'lowercase': return text.toLowerCase();
    case 'capitalize': return text.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
    default: return text;
  }
}

/** @param {CSSStyleDeclaration} cs @returns {string} */
const caretColor = (cs) => (cs.caretColor && cs.caretColor !== 'auto' ? cs.caretColor : cs.color);

/**
 * Horizontal geometry of a single-line input: where text starts and how wide a prefix is.
 * @param {HTMLInputElement} el
 * @param {CSSStyleDeclaration} cs
 * @param {CanvasRenderingContext2D} ctx
 * @param {Rect} frame
 * @returns {{x: (chars: number) => number, top: number, height: number}}
 */
export function inputMetrics(el, cs, ctx, frame) {
  applyFont(ctx, cs);
  const raw = el.type === 'password' ? '•'.repeat(el.value.length) : transformText(el.value, cs);
  const m = ctx.measureText('Mg');
  const height = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
  const left = frame.x + px(cs.borderLeftWidth) + px(cs.paddingLeft);
  const inner = el.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight);
  const total = ctx.measureText(raw).width;
  const rtl = cs.direction === 'rtl';
  const align = cs.textAlign;
  let shift = 0;
  if (total < inner) {
    if (align === 'center') shift = (inner - total) / 2;
    else if (align === 'right' || (align === 'end' && !rtl) || (align === 'start' && rtl)) shift = inner - total;
  }
  const top = frame.y + px(cs.borderTopWidth) + px(cs.paddingTop) + (el.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom) - height) / 2;
  return { x: (chars) => left + shift + ctx.measureText(raw.slice(0, chars)).width - el.scrollLeft, top, height };
}

/** @param {string} text @param {CanvasRenderingContext2D} ctx @param {number} maxWidth @returns {string[]} greedy word wrap of one paragraph (pre-wrap semantics) */
function wrapParagraph(text, ctx, maxWidth) {
  if (!text) return [''];
  const lines = [];
  let line = '';
  for (const word of text.split(/(?<=\s)/)) {
    if (line && ctx.measureText((line + word).replace(/\s+$/, '')).width > maxWidth) { lines.push(line); line = word; } else line += word;
  }
  lines.push(line);
  return lines;
}

/** @param {(chars: number) => number} xOf @param {number} n @param {number} x @returns {number} the character boundary nearest to x (binary search, xOf grows with chars) */
function nearestBoundary(xOf, n, x) {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xOf(mid + 1) <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo < n && x - xOf(lo) > xOf(lo + 1) - x ? lo + 1 : lo;
}

/**
 * Caret of a textarea: line and column by greedy wrapping with the control's font (approximate: no bidi, no hyphenation).
 * @param {HTMLTextAreaElement} el @param {CSSStyleDeclaration} cs @param {CanvasRenderingContext2D} ctx @param {Rect} frame
 * @returns {Rect|null}
 */
function textareaCaret(el, cs, ctx, frame) {
  applyFont(ctx, cs);
  const m = ctx.measureText('Mg');
  const height = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
  const lineHeight = cs.lineHeight.endsWith('px') ? px(cs.lineHeight) : height * 1.0;
  const inner = el.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight);
  const nowrap = cs.whiteSpace === 'pre' || cs.whiteSpace === 'nowrap';
  const before = transformText(el.value.slice(0, el.selectionStart), cs).split('\n');
  const paragraphs = transformText(el.value, cs).split('\n');
  let row = 0;
  for (let p = 0; p < before.length - 1; p++) row += nowrap ? 1 : wrapParagraph(paragraphs[p], ctx, inner).length;
  const tail = before[before.length - 1];
  let lineText = tail;
  if (!nowrap) {
    const lines = wrapParagraph(paragraphs[before.length - 1], ctx, inner);
    let used = 0;
    let idx = 0;
    while (idx < lines.length - 1 && used + lines[idx].length < tail.length) { used += lines[idx].length; idx++; }
    row += idx;
    lineText = tail.slice(used);
  }
  const x = frame.x + px(cs.borderLeftWidth) + px(cs.paddingLeft) + ctx.measureText(lineText).width - el.scrollLeft;
  const y = frame.y + px(cs.borderTopWidth) + px(cs.paddingTop) + row * lineHeight + (lineHeight - height) / 2 - el.scrollTop;
  return { x, y, width: 1, height };
}

/**
 * Caret of a contenteditable host from the selection's collapsed range.
 * @param {Document} doc @param {Element} focus @param {Rect} frame
 * @returns {Rect|null}
 */
function editableCaret(doc, focus, frame) {
  const sel = doc.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed || !sel.anchorNode || !focus.contains(sel.anchorNode)) return null;
  const range = sel.getRangeAt(0);
  const r = range.getClientRects()[0] ?? (sel.anchorNode.nodeType === 1 ? /** @type {Element} */ (sel.anchorNode).getBoundingClientRect() : null);
  if (!r || (!r.height && !r.width && !r.top)) return null;
  const fr = focus.getBoundingClientRect();
  const k = frame.width > 0 ? fr.width / frame.width : 1;
  return { x: frame.x + (r.left - fr.left) / k, y: frame.y + (r.top - fr.top) / k, width: 1, height: r.height / k };
}

/**
 * Measure the caret of the focused text control (canvas measureText with the control's font; caret-color; width 1 css px): the rect in the drawable's border-box frame and its color, or null when no caret applies.
 * `frame` is the border box of `focus` expressed in that frame (LiveLayer.frameRect(focus)).
 * The caret is NOT drawn into the tile (ADR-D.2): CaptureResult.caret carries it and the store paints it on the retained surface (blink = O(caret rect), no tile build).
 * @param {Document} doc  the live document
 * @param {Element} focus
 * @param {Rect} frame
 * @returns {{rect: Rect, color: string}|null}
 */
export function measureCaret(doc, focus, frame) {
  const ctx = measuringContext(doc);
  if (!ctx) return null;
  const cs = (doc.defaultView ?? window).getComputedStyle(focus);
  /** @type {Rect|null} */
  let rect = null;
  if (focus instanceof HTMLInputElement && (SINGLE_LINE.has(focus.type) || NO_SELECTION_API.has(focus.type)) && selectionApiMissing(focus)) {
    const g = inputMetrics(focus, cs, ctx, frame);
    const k = focus.offsetWidth > 0 ? frame.width / focus.offsetWidth : 1;
    const index = fallbackCaretIndex(focus, (x) => nearestBoundary(g.x, focus.value.length, frame.x + x * k));
    rect = { x: g.x(index), y: g.top, width: 1, height: g.height };
  } else if (focus instanceof HTMLInputElement && SINGLE_LINE.has(focus.type)) {
    if (focus.selectionStart === null || focus.selectionStart !== focus.selectionEnd) return null;
    const g = inputMetrics(focus, cs, ctx, frame);
    rect = { x: g.x(focus.selectionStart), y: g.top, width: 1, height: g.height };
  } else if (focus instanceof HTMLTextAreaElement) {
    if (focus.selectionStart !== focus.selectionEnd) return null;
    rect = textareaCaret(focus, cs, ctx, frame);
  } else if (/** @type {HTMLElement} */ (focus).isContentEditable) rect = editableCaret(doc, focus, frame);
  return rect ? { rect, color: caretColor(cs) } : null;
}

/** @param {string} css a computed colour, rgb()/rgba() @returns {number[]|null} [r, g, b, a] */
export function parseColor(css) {
  const m = /^rgba?\(([^)]+)\)$/.exec(css.trim());
  const v = m ? m[1].split(/[\s,/]+/).filter(Boolean).map(Number) : [];
  return v.length >= 3 && v.every((n) => !Number.isNaN(n)) ? [v[0], v[1], v[2], v[3] ?? 1] : null;
}

/** The colour behind `el`: its own and its ancestors' backgrounds composited over white (12 levels). @param {Window} win @param {Element} el @returns {number[]} rgb */
function backdropOf(win, el) {
  /** @type {number[][]} */
  const layers = [];
  for (let n = /** @type {Element|null} */ (el), i = 0; n && i < 12; n = n.parentElement, i++) {
    const c = parseColor(win.getComputedStyle(n).backgroundColor);
    if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
  }
  return layers.reduceRight((under, c) => under.map((u, k) => u * (1 - c[3]) + c[k] * c[3]), [255, 255, 255]);
}

/**
 * The author's `::selection` background of `el` (an opaque one is painted as is). Without one the engine paints the system Highlight (read through a canvas: a DOM probe would mutate the live page,
 * measured rgba(128,188,254,0.6)) UNDER the glyphs, so the background becomes backdrop*(1-a)+Highlight*a and the glyphs keep their colour. An overlay above the glyphs reproduces that exactly with
 * `lighten` (dark control, light glyphs) or `darken` (light control, dark glyphs) of the blended colour; when the glyph colour is on the wrong side in some channel, a plain alpha overlay (glyphs tinted).
 * @param {Document} doc @param {Element} el @returns {string}
 */
function selectionLook(doc, el) {
  const win = doc.defaultView ?? window;
  const bg = win.getComputedStyle(el, '::selection').backgroundColor;
  if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return `${OVERLAY}background:${bg};`;
  const ctx = measuringContext(doc);
  const saved = ctx?.fillStyle;
  if (ctx) ctx.fillStyle = 'Highlight';
  const hi = ctx ? parseColor(String(ctx.fillStyle)) : null;
  if (ctx && saved !== undefined) ctx.fillStyle = saved;
  if (!hi) return `${OVERLAY}mix-blend-mode:multiply;background:Highlight;`;
  const under = backdropOf(win, el);
  const text = parseColor(win.getComputedStyle(el).color) ?? [0, 0, 0, 1];
  const blended = under.map((u, k) => u * (1 - hi[3]) + hi[k] * hi[3]);
  const rgb = `rgb(${blended.map(Math.round).join(',')})`;
  if (blended.every((t, k) => t >= under[k] && text[k] >= t)) return `${OVERLAY}mix-blend-mode:lighten;background:${rgb};`;
  if (blended.every((t, k) => t <= under[k] && text[k] <= t)) return `${OVERLAY}mix-blend-mode:darken;background:${rgb};`;
  return `${OVERLAY}background:rgba(${hi[0]},${hi[1]},${hi[2]},${hi[3]});`;
}

/** @param {Document} doc @param {Rect} r @param {Element} el the element whose ::selection style applies @returns {Element} */
function highlight(doc, r, el) {
  const d = doc.createElement('div');
  setInlineStyle(d, `${selectionLook(doc, el)}left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px`);
  return d;
}

/**
 * Selection highlight rectangles (::selection colours) for a non-collapsed selection in the focused control. Single-line inputs are exact, a textarea
 * and contenteditable fall back to their ranges (approximate, row caret-selection).
 * @param {Document} doc
 * @param {Element} focus
 * @param {Rect} frame
 * @returns {Element[]}
 */
export function buildSelectionRects(doc, focus, frame) {
  const ctx = measuringContext(doc);
  if (!ctx || !(focus instanceof HTMLInputElement) || !SINGLE_LINE.has(focus.type)) return [];
  const a = focus.selectionStart;
  const b = focus.selectionEnd;
  if (a === null || b === null || a === b) return [];
  const cs = (doc.defaultView ?? window).getComputedStyle(focus);
  const g = inputMetrics(focus, cs, ctx, frame);
  const x0 = g.x(a);
  return [highlight(doc, { x: x0, y: g.top, width: g.x(b) - x0, height: g.height }, focus)];
}

/**
 * Highlight rectangles of a text selection that lives in the page DOM (labels, paragraphs) inside `scope`, in the border-box frame of `scope`.
 * @param {Document} doc
 * @param {Element} scope  the drawable
 * @param {Rect} frame  the drawable's border box in its own frame ({x:0,y:0,width,height})
 * @returns {Element[]}
 */
export function buildDocumentSelectionRects(doc, scope, frame) {
  const sel = doc.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return [];
  return rangeRectsIn(sel.getRangeAt(0), scope, frame).map((r) => highlight(doc, r, scope));
}
