/**
 * State-synced clone of one drawable (docs/ARCHITECTURE.md ADR-D.1).
 * Module: snapshot-capture (src/snapshot/capture/*).
 */

import { MARK } from '../../contracts/events.js';
import { inflateRect, intersectRect } from '../../util/rect.js';
import { applyFont, buildDocumentSelectionRects, buildSelectionRects, inputSelectionRect, measureCaret, measuringContext, rangeHighlights } from './caret-overlay.js';
import { rangeRectsIn } from '../../util/selection-rects.js';
import { ancestorShell, canvasAncestors } from './custom-props.js';
import { createTokenCollector } from './css-shake.js';
import { applyScrollState, listboxThumb, scrollFacts } from './scroll-emulation.js';
import { appendWithStubs, buildShell, shellFactsOf, shellNeedsBox, siblingStub } from './shells.js';
import {
  LEAF_TAGS, addUnsupported, applyInteractionClasses, cleanAttributes, elementPath, freezeAnimations, inTopLayer, interactionContext, isPending, markPending, syncNodeState, topLayerIn, usedColorScheme,
} from './state-sync.js';
import { placeholderElement } from './placeholder.js';
import { addUseTargets } from './svg-refs.js';
import { appendInlineStyle, setInlineStyle } from './inline-style.js';
import { compositeOver, createSelectionPainter, solidBackdrop } from './selection-paint.js';
import { currentEngine } from '../../util/engine.js';

/** @typedef {import('../../contracts/types.js').CaptureRequest} CaptureRequest */
/** @typedef {import('../../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../../contracts/types.js').Rect} Rect */
/** @typedef {import('../../contracts/types.js').UnsupportedEntry} UnsupportedEntry */
/** @typedef {import('./css-shake.js').ShakeTokens} ShakeTokens */

/**
 * @typedef {Object} CloneResult
 * @property {Element} root        the div.hic-root with shells + drawable clone
 * @property {number} nodes        elements of the drawable subtree the full clone stands for (pruned subtrees are counted)
 * @property {UnsupportedEntry[]} unsupported
 * @property {boolean} complete
 * @property {ShakeTokens} tokens
 * @property {{x: number, y: number, width: number, height: number}} frame  the laid-out frame in the drawable's border-box coordinates (border box + ink)
 * @property {{x: number, y: number}|null} layoutOffset  border box of the drawable inside the layer
 * @property {{rect: Rect, color: string}|null} caret
 * @property {string} extraCss     per-capture rules (scroll markers, the selection wrapper) that go after the shaken sheet
 * @property {CSSStyleDeclaration} layerStyle  computed style of the layer element: the source of the custom properties the root inherits
 */

/** Thrown when the drawable has more nodes than the absolute budget; capture turns it into a placeholder. */
export class BudgetExceeded extends Error {
  /** @param {number} nodes */
  constructor(nodes) { super(`node budget exceeded (${nodes} nodes)`); this.nodes = nodes; }
}

const SKIP = new Set(['script', 'style', 'link', 'noscript', 'template', 'meta', 'title', 'base', 'source', 'track', 'datalist']);
const NO_PRUNE_DISPLAY = /^(inline|contents|none|ruby|table-|inline-)/;
const WINDOW_CHILDREN = 40;
const INHERITED = [
  'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'font-variant', 'font-kerning', 'font-feature-settings', 'font-variation-settings', 'font-optical-sizing',
  'font-size-adjust', 'font-synthesis', 'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-align-last', 'text-indent', 'text-transform', 'text-shadow', 'text-rendering',
  'text-wrap', 'white-space', 'word-break', 'overflow-wrap', 'hyphens', 'tab-size', 'direction', 'writing-mode', 'text-orientation', 'quotes', 'list-style', 'accent-color', 'color-scheme',
  'visibility', 'border-collapse', 'border-spacing', 'empty-cells', 'caption-side', 'image-rendering', 'forced-color-adjust', 'print-color-adjust', 'paint-order',
];
// not copied although inherited: computed values that resolved `currentcolor` or `auto` (-webkit-text-fill-color, caret-color, fill, stroke, cursor) would freeze the root's colour for every descendant.
/** The root stands for html and body, whose box properties must not apply to the content. */
const ROOT_NEUTRAL = 'display:block!important;position:relative!important;box-sizing:border-box!important;margin:0!important;border:0!important;min-width:0!important;min-height:0!important;'
  + 'max-width:none!important;max-height:none!important;overflow:hidden!important;background:none!important;box-shadow:none!important;transform:none!important;filter:none!important;'
  + 'opacity:1!important;outline:none!important;float:none!important;inset:auto!important;contain:none!important;aspect-ratio:auto!important;border-radius:0!important;clip-path:none!important;mask:none!important;';

/** @param {number} v @returns {string} */
const n3 = (v) => String(+v.toFixed(3));

/**
 * @typedef {Object} Ctx
 * @property {HicEnv} env
 * @property {CaptureRequest} req
 * @property {Document} doc  inert document that owns the clone
 * @property {import('../../contracts/types.js').LiveLayer} layer
 * @property {Element} drawable
 * @property {Set<Element>} drawables
 * @property {UnsupportedEntry[]} unsupported
 * @property {import('./css-shake.js').TokenCollector} tokens
 * @property {import('./state-sync.js').InteractionContext} ix
 * @property {Set<Element>|null} animated
 * @property {import('./scroll-emulation.js').ScrollSink} scroll
 * @property {Rect|null} keep  damage prune region in the drawable frame
 * @property {number} nodes
 * @property {number} absolute
 * @property {boolean} fold  pruned spacer runs may be merged (no selector depends on sibling positions)
 * @property {boolean} trunc  trailing children below the keep region may be left out (fold, and no :has() selector)
 * @property {Set<Element>} topLayer  elements of the drawable (in its own tree scope) rendered in the top layer
 * @property {Node} scope  tree scope of the drawable (document or the canvas's shadow root): elements of other scopes are inside shadow trees of the drawable
 * @property {number} shift  css px by which the descendants of CaptureRequest.scroll.el appear moved in the clone (live scrollTop - rendered scrollTop): live rects are shifted by it before a prune test
 * @property {PageSelection|null} selection  the page text selection recoloured inside the clone, or null (no selection here, or it is drawn as overlay rectangles)
 * @property {import('./selection-paint.js').SelectionPainter|null} painter  selection colours of this capture (created on first use)
 * @property {(el: Element, sized?: boolean) => Rect|null} frame  LiveLayer.frameRect of the elements of this drawable, with the drawable-level reads made once (LiveLayer.frameMeasurer)
 */

/**
 * @typedef {Object} PageSelection
 * @property {Range} range  the live selection range
 * @property {number} k  client px per drawable css px (a scaled ancestor of the layer)
 * @property {Rect} frame  the drawable's border box in its own frame
 * @property {{range: Range, el: Element}[]} fallback  selected text that is not wrapped: drawn as overlay rectangles
 * @property {boolean} wrapped  at least one wrapper was written (its rule goes into extraCss once)
 * @property {{rects: Rect[], el: Element, background: string, content: number}[]} parts  the wrapped parts in document order (their line fragments in the drawable frame)
 */

/**
 * The INHERITABLE line-height of the layer: a unitless number stays a number. computedStyleMap reports it directly; engines without it (Gecko 155) read the
 * layer's ::after, whose font-size is 200 % (layer-style.js): it is twice the layer's px value only when the line-height is a number.
 * @param {Element} el @param {CSSStyleDeclaration} cs @returns {string}
 */
function lineHeightOf(el, cs) {
  if (el.computedStyleMap) return String(el.computedStyleMap().get('line-height'));
  const own = cs.getPropertyValue('line-height');
  const px = Number.parseFloat(own), size = Number.parseFloat(cs.getPropertyValue('font-size'));
  if (!(px > 0) || !(size > 0) || !own.endsWith('px')) return own;
  const pseudo = Number.parseFloat((el.ownerDocument.defaultView ?? window).getComputedStyle(el, '::after').getPropertyValue('line-height'));
  return Math.abs(pseudo - 2 * px) < 0.02 ? n3(px / size) : own;
}

/** @param {Element} el @param {CSSStyleDeclaration} cs @returns {string} inherited text properties of the layer as an inline style */
function inheritedStyle(el, cs) {
  let s = '';
  for (const p of INHERITED) {
    // a unitless line-height is inherited as a NUMBER (each descendant scales it by its own font-size); getComputedStyle would resolve it to px for the root
    const v = p === 'line-height' ? lineHeightOf(el, cs)
      : p === 'color-scheme' ? usedColorScheme(el.ownerDocument, cs.getPropertyValue(p)) : cs.getPropertyValue(p);
    if (v) s += `${p}:${v};`;
  }
  return s;
}

/** @param {Document} live @param {Element} root */
function copyRootAttributes(live, root) {
  const classes = new Set(['hic-root']);
  for (const host of [live.documentElement, live.body]) {
    if (!host) continue;
    for (const a of Array.from(host.attributes)) {
      if (a.name === 'class') for (const c of a.value.split(/\s+/)) { if (c) classes.add(c); } else if (a.name !== 'style' && a.name !== 'id' && !a.name.startsWith('on')) root.setAttribute(a.name, a.value);
    }
  }
  root.setAttribute('class', [...classes].join(' '));
}

/** @param {Ctx} ctx @param {Element} src @param {string} feature @param {string} message @returns {Element} */
function placeholderFor(ctx, src, feature, message) {
  const size = ctx.layer.borderBoxSize(src) ?? { width: 0, height: 0 };
  const path = elementPath(src);
  return placeholderElement(ctx.doc, { feature, message, path }, size);
}

/**
 * @param {Ctx} ctx @param {Element} src @param {Rect} r @returns {Element} invisible same-size stand-in; keeps tag, id, class and inline style so selectors, margins and
 * grid placement still apply (without its id, a `#bar{grid-column:1/-1}` spacer took one cell and every later grid item moved: a list's column showed the side panel)
 */
function spacerFor(ctx, src, r) {
  const sp = ctx.doc.importNode(src, false);
  cleanAttributes(sp);
  sp.setAttribute('data-hic-sp', '');
  appendInlineStyle(sp, `width:${n3(r.width)}px!important;height:${n3(r.height)}px!important`);
  ctx.tokens.add(sp);
  return sp;
}

/**
 * @param {Ctx} ctx @param {Element} k @param {Rect|null} window  extra keep region for children of a long scroller @param {CSSStyleDeclaration} cs  computed style of `k`
 * @returns {{r: Rect, cs: CSSStyleDeclaration}|null} set when `k` can be replaced by a spacer
 */
function spacerInfo(ctx, k, window, cs) {
  // the style test first: it is cheaper than the frame rect, and rows of inline content (never spacers) are common in large drawables
  const position = cs.position;
  if (NO_PRUNE_DISPLAY.test(cs.display) || position === 'absolute' || position === 'fixed' || position === 'sticky' || cs.transform !== 'none') return null;
  // a rect without area is never a spacer: the laid-out test is left to its size
  const live = ctx.frame(k, true);
  const r = live && ctx.shift ? { x: live.x, y: live.y + ctx.shift, width: live.width, height: live.height } : live;
  if (!r || r.width <= 0 || r.height <= 0) return null;
  if ((!ctx.keep || intersectRect(r, ctx.keep)) && (!window || intersectRect(r, window))) return null;
  if (ctx.ix.focusWithin.has(k) || k.contains(ctx.drawable)) return null;
  return { r, cs };
}

/**
 * A run of adjacent, equally wide block spacers in a block-flow parent becomes one spacer (measured: the SVG shrinks several times). Only when no selector counts siblings (ctx.fold):
 * a merged run shifts :nth-child parity and sibling combinators of the rows behind it.
 * @typedef {{el: HTMLElement, tag: string, x: number, y: number, width: number}} SpacerRun
 */

/** block spacers that may be merged: list items are not, every one counts in the list numbering */
const MERGEABLE = /^(block|flow-root|flex|grid)$/;
/** @param {CSSStyleDeclaration} cs @returns {boolean} the element increments no counter (a merged run would number what follows differently) */
const countsNothing = (cs) => cs.counterIncrement === 'none' || cs.counterIncrement === '';

/** @param {SpacerRun|null} run @param {Element} k @param {{r: Rect, cs: CSSStyleDeclaration}} info @returns {boolean} true when `k` was folded into the run */
function extendRun(run, k, info) {
  if (!run || run.tag !== k.localName || !MERGEABLE.test(info.cs.display) || !countsNothing(info.cs)) return false;
  if (Math.abs(info.r.x - run.x) > 0.5 || Math.abs(info.r.width - run.width) > 0.5 || info.r.y < run.y) return false;
  run.el.style.setProperty('height', `${n3(info.r.y + info.r.height - run.y)}px`, 'important');
  run.el.style.setProperty('margin-bottom', info.cs.marginBottom, 'important');
  return true;
}

/** @param {Ctx} ctx @param {Element} src @param {CSSStyleDeclaration} [known]  computed style of `src`, when the caller has it @returns {Element|null} */
function cloneElement(ctx, src, known) {
  const ln = src.localName;
  if (src.hasAttribute(MARK.NODE_ATTR)) return null;
  // top-layer elements of the drawable's own tree were found by one query per capture; an element of a shadow tree is asked directly
  const scoped = src.getRootNode() === ctx.scope;
  // script/style/link/template never render but they count for :nth-child and sibling combinators: an attribute-only display:none stand-in keeps the indices
  if (SKIP.has(ln) || (scoped ? ctx.topLayer.has(src) : inTopLayer(src))) return siblingStub(ctx.doc, src);
  const html = /** @type {HTMLElement} */ (src);
  // the inline style is read only where there is one (the attribute reflects every CSSOM write): reading `style` builds a declaration object per element
  if (html.hidden || (src.hasAttribute('style') && html.style?.display === 'none')) {
    const stub = ctx.doc.importNode(src, false);
    cleanAttributes(stub);
    setInlineStyle(stub, 'display:none!important');
    ctx.nodes++;
    return stub;
  }
  let clone = ctx.doc.importNode(src, false);
  cleanAttributes(clone);
  const ok = syncNodeState(ctx.env, src, clone, ctx.req, ctx.unsupported);
  ctx.nodes++;
  if (ok === false) {
    const e = ctx.unsupported[ctx.unsupported.length - 1];
    return placeholderFor(ctx, src, e.feature, e.message);
  }
  const replaced = ok !== true;
  if (replaced) clone = /** @type {Element} */ (ok);
  applyInteractionClasses(src, clone, ctx.ix);
  const cs = known ?? ctx.env.window.getComputedStyle(src);
  if (!replaced && (!scoped || styledByShadow(src))) inlineComputed(src, clone, cs);
  // backdrop of the optimistic text overlay (text-overlay.js): the field without its text
  if (src === ctx.req.hideText) appendInlineStyle(clone, 'color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important');
  // a page of the scroll compositor: pinned (sticky) elements are drawn from their own tile
  if (ctx.req.scroll?.hide.includes(src)) {
    appendInlineStyle(clone, 'visibility:hidden!important');
    clone.setAttribute('data-hic-hide', '');
  }
  // a rounded scroller: square corners (the compositor clips to the rounded port itself), or its backdrop (the content hidden)
  if (ctx.req.scroll?.el === src && ctx.req.scroll.shape === 'square') appendInlineStyle(clone, 'border-radius:0!important');
  if (ctx.req.scroll?.el === src && ctx.req.scroll.shape === 'backdrop') clone.setAttribute('data-hic-hide', '');
  if (ctx.animated?.has(src)) freezeAnimations(src, /** @type {HTMLElement} */ (clone));
  ctx.tokens.add(clone);
  if (!replaced && !LEAF_TAGS.has(ln)) cloneChildren(ctx, src, clone, cs);
  maybeScroll(ctx, src, clone, cs);
  return clone;
}

/** form controls whose text or options scroll inside them whatever their computed overflow says */
const OWN_SCROLLERS = new Set(['input', 'textarea', 'select']);

/** @param {Ctx} ctx @param {Element} src @param {Element} clone @param {CSSStyleDeclaration} cs  computed style of `src` */
function maybeScroll(ctx, src, clone, cs) {
  const over = ctx.req.scroll?.el === src ? ctx.req.scroll : null;
  // overflow visible on both axes: not a scroll container, so its scroll offsets are 0 and nothing of it is scrollable (scrollFacts would answer null). The computed style
  // is a cheaper read than the four scroll metrics, and it is the answer for most elements.
  if (!over && cs.overflowX === 'visible' && cs.overflowY === 'visible' && !OWN_SCROLLERS.has(src.localName)) return;
  if (!(src.scrollTop || src.scrollLeft || src.scrollHeight > src.clientHeight || src.scrollWidth > src.clientWidth)) return;
  const live = scrollFacts(src, cs);
  const f = over ? { ...(live ?? { sL: src.scrollLeft, gv: 0, gh: 0, scrollableY: true, scrollableX: false, styled: false }), sT: over.top } : live;
  if (src.localName === 'select') listboxThumb(src, /** @type {HTMLElement} */ (clone), cs, f?.sT ?? src.scrollTop);
  if (!f) return;
  const res = applyScrollState(ctx.env, src, /** @type {HTMLElement} */ (clone), ctx.req, ctx.scroll, f);
  if (res.pending) markPending(ctx.unsupported);
  for (const x of res.failed) addUnsupported(ctx.unsupported, src, x.error.feature, x.error.message, x.error.hint);
}

/** @param {Ctx} ctx @param {Element} src @param {Element} clone @param {CSSStyleDeclaration} cs  computed style of `src` */
function cloneChildren(ctx, src, clone, cs) {
  if (ctx.nodes > ctx.absolute) throw new BudgetExceeded(ctx.nodes);
  /** @type {Rect|null} */
  let window = null;
  const over = ctx.req.scroll?.el === src ? ctx.req.scroll : null;
  if (src.childElementCount > WINDOW_CHILDREN && src.scrollHeight + src.scrollWidth > src.clientHeight + src.clientWidth) {
    const r = ctx.frame(src);
    if (r) window = inflateRect({ x: r.x, y: r.y + (over ? 0 : ctx.shift), width: r.width, height: r.height }, Math.max(r.width, r.height) * 0.6);
  }
  // a page of the scroll compositor renders `src` at another offset: its descendants appear moved by the difference
  const shifted = ctx.shift;
  if (over) ctx.shift = /** @type {HTMLElement} */ (src).scrollTop - over.top;
  try {
    cloneChildList(ctx, src, clone, window, cs);
  } finally {
    ctx.shift = shifted;
  }
}

/** @param {Ctx} ctx @param {Element} src @param {Element} clone @param {Rect|null} window @param {CSSStyleDeclaration} srcStyle  computed style of `src` */
function cloneChildList(ctx, src, clone, window, srcStyle) {
  /** @type {SpacerRun|null} */
  let run = null;
  const prune = !!(ctx.keep || window);
  const blockParent = ctx.fold && prune && /^(block|list-item|flow-root|flex|grid)$/.test(srcStyle.display);
  const kids = flatChildren(src);
  const cut = ctx.trunc && ctx.keep && !window && kids.length > TRUNC_MIN_CHILDREN ? truncation(ctx, src, kids) : null;
  const end = cut ? cut.index : kids.length;
  for (let i = 0; i < end; i++) {
    const k = kids[i];
    if (k.nodeType === 3) {
      const text = /** @type {Text} */ (k).data;
      if (/\S/.test(text)) run = null;
      if (!ctx.selection || !appendSelectedText(ctx, src, /** @type {Text} */ (k), clone)) clone.appendChild(ctx.doc.createTextNode(text));
      continue;
    }
    if (k.nodeType !== 1) continue;
    const el = /** @type {Element} */ (k);
    if (ctx.drawables.has(el)) {
      run = null;
      const size = ctx.layer.borderBoxSize(el);
      if (size) {
        const sp = spacerFor(ctx, el, { x: 0, y: 0, width: size.width, height: size.height });
        sp.setAttribute('class', `${sp.getAttribute('class') ?? ''} ${MARK.CLS_NESTED}`.trim());
        clone.appendChild(sp);
        ctx.nodes += 1;
      }
      continue;
    }
    const cs = prune && !SKIP.has(el.localName) ? ctx.env.window.getComputedStyle(el) : undefined;
    const info = cs ? spacerInfo(ctx, el, window, cs) : null;
    if (info) {
      ctx.nodes += 1 + el.getElementsByTagName('*').length;
      if (blockParent && extendRun(run, el, info)) continue;
      const sp = /** @type {HTMLElement} */ (spacerFor(ctx, el, info.r));
      clone.appendChild(sp);
      run = blockParent && MERGEABLE.test(info.cs.display) && countsNothing(info.cs) ? { el: sp, tag: el.localName, x: info.r.x, y: info.r.y, width: info.r.width } : null;
      continue;
    }
    run = null;
    const c = cloneElement(ctx, el, cs);
    if (c) clone.appendChild(c);
  }
  if (!cut) return;
  appendInlineStyle(clone, cut.pin);
  // the left-out children still count for the node budget, as pruned spacers do
  for (let i = cut.index; i < kids.length; i++) if (kids[i].nodeType === 1) ctx.nodes += 1 + /** @type {Element} */ (kids[i]).getElementsByTagName('*').length;
}

/** a container needs more children than this before its trailing ones are worth measuring for truncation */
const TRUNC_MIN_CHILDREN = 8;
const FLOW = /^(block|flow-root|list-item)$/;
/** element children tried after the first one below the keep region, looking for one that starts a line */
const LINE_START_TRIES = 64;
/** boxes inspected on the cut's line */
const UNIFORM_LINE_MAX = 200;

/**
 * Trailing children of a large flow container that lie entirely below the keep region (a damage-pruned tile) are left out of the clone: in a block or inline flow,
 * content never moves the content before it, so the kept lines lay out as they do live, and the container keeps its live size through a min-height (and, as a row flex
 * item, a pinned width) so nothing around it moves. A row of 1,000 inline cells under a changed counter is no longer cloned, serialised and laid out for every change.
 * Only where nothing can depend on the dropped content: `trunc` (no selector counts siblings, no :has()); a block / flow-root / list-item container that is not a scroll
 * container, in horizontal flow, without columns, justification, a styled last line, balanced / pretty wrapping, line clamping, text-overflow, ::after content or reversed
 * numbering; its parent a block flow (or a row flex container when its width is not auto); no focus inside. The cut must start a line (the content before it ends above it)
 * and everything from it on lies below the keep region (one Range rect). Positioned descendants of the dropped children are not followed, as for pruned spacers.
 * @param {Ctx} ctx @param {Element} src @param {Node[]} kids @returns {{index: number, pin: string}|null}
 */
function truncation(ctx, src, kids) {
  if (src.shadowRoot || src.localName === 'slot' || ctx.ix.focusWithin.has(src)) return null;
  const win = ctx.env.window;
  const cs = win.getComputedStyle(src);
  if (!FLOW.test(cs.display) || cs.writingMode !== 'horizontal-tb' || cs.columnCount !== 'auto' || cs.columnWidth !== 'auto') return null;
  if (!/^(visible|clip)$/.test(cs.overflowX) || !/^(visible|clip)$/.test(cs.overflowY) || cs.textOverflow !== 'clip') return null;
  if (cs.textAlign === 'justify' || cs.textAlignLast !== 'auto' || !/^(auto|stable|)$/.test(cs.getPropertyValue('text-wrap-style'))) return null;
  if (!/^(none|)$/.test(cs.getPropertyValue('-webkit-line-clamp')) || /reversed\(/.test(cs.counterReset) || (src.localName === 'ol' && /** @type {HTMLOListElement} */ (src).reversed)) return null;
  const after = win.getComputedStyle(src, '::after').content;
  if (after && after !== 'none' && after !== 'normal') return null;
  let rowItem = false;
  if (src !== ctx.drawable) {
    const parent = src.parentElement;
    const ps = parent ? win.getComputedStyle(parent) : null;
    if (!ps) return null;
    if (/^(inline-)?flex$/.test(ps.display) && /^row/.test(ps.flexDirection)) {
      const width = /** @type {any} */ (src).computedStyleMap?.().get('width');
      if (!width || String(width) === 'auto') return null;
      rowItem = true;
    } else if (!FLOW.test(ps.display)) return null;
  }
  // the first element child whose frame top (live rect shifted like a pruned spacer's) is below the keep region (flow order is top-down), then the checks that make the cut safe
  const bottom = /** @type {Rect} */ (ctx.keep).y + /** @type {Rect} */ (ctx.keep).height;
  const below = (/** @type {Element} */ el) => { const r = ctx.frame(el); return !!r && r.y + ctx.shift >= bottom; };
  /** @type {number[]} */
  const els = [];
  for (let i = 0; i < kids.length; i++) if (kids[i].nodeType === 1) els.push(i);
  let lo = 0, hi = els.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (below(/** @type {Element} */ (kids[els[mid]]))) hi = mid; else lo = mid + 1;
  }
  if (lo >= els.length || lo === 0) return null;
  // the kept lines must lay out as they do live: the cut starts a line (the content before it ends above it), or the content before it ends on the cut's line and
  // that line is uniform (every box on it has the same top, bottom, line-height and vertical-align, and no bare text), so what is left of it keeps its baseline
  const range = src.ownerDocument.createRange();
  let index = -1;
  let top = 0;
  for (let e = lo, tries = 0; e < els.length && tries < LINE_START_TRIES; e++, tries++) {
    const at = els[e];
    let p = at - 1;
    while (p >= 0 && kids[p].nodeType !== 1 && !(kids[p].nodeType === 3 && /\S/.test(/** @type {Text} */ (kids[p]).data))) p--;
    if (p < 0) return null;
    range.selectNode(/** @type {Node} */ (kids[p]));
    const rects = range.getClientRects();
    const tail = rects[rects.length - 1];
    if (!tail) return null;
    const r = /** @type {Element} */ (kids[at]).getBoundingClientRect();
    if (tail.bottom <= r.top + 0.5 || (Math.abs(tail.top - r.top) < 0.5 && Math.abs(tail.bottom - r.bottom) < 0.5 && uniformLine(win, kids, p, at, r))) { index = at; top = r.top; break; }
  }
  if (index < 0) return null;
  const first = /** @type {Element} */ (kids[index]);
  if (ctx.drawables.has(first)) return null;
  // everything from `first` on (descendants' boxes included) starts no higher than `first` itself
  range.setStartBefore(first);
  range.setEndAfter(/** @type {Node} */ (kids[kids.length - 1]));
  if (range.getBoundingClientRect().top < top - 0.5) return null;
  for (let i = index; i < kids.length; i++) if (kids[i].nodeType === 1 && ctx.ix.focusWithin.has(/** @type {Element} */ (kids[i]))) return null;
  const size = ctx.layer.borderBoxSize(src);
  if (!size) return null;
  const n = (/** @type {string} */ v) => parseFloat(v) || 0;
  const content = cs.boxSizing !== 'border-box';
  const h = size.height - (content ? n(cs.paddingTop) + n(cs.paddingBottom) + n(cs.borderTopWidth) + n(cs.borderBottomWidth) : 0);
  const w = size.width - (content ? n(cs.paddingLeft) + n(cs.paddingRight) + n(cs.borderLeftWidth) + n(cs.borderRightWidth) : 0);
  const pin = `min-height:${n3(h)}px!important;` + (rowItem ? `width:${n3(w)}px!important;min-width:${n3(w)}px!important;flex:0 0 auto!important;` : '');
  return { index, pin };
}

/**
 * Is the line that starts (for the cut) at kids[at] made only of boxes like the one before it: the same top and bottom as `r`, the same line-height and vertical-align as kids[p],
 * no bare text? Then leaving out the boxes after kids[p] does not move what is left of the line.
 * @param {Window} win @param {Node[]} kids @param {number} p @param {number} at @param {DOMRect} r @returns {boolean}
 */
function uniformLine(win, kids, p, at, r) {
  const ref = kids[p].nodeType === 1 ? win.getComputedStyle(/** @type {Element} */ (kids[p])) : null;
  if (!ref) return false;
  for (let j = at, n = 0; j < kids.length; j++, n++) {
    if (n > UNIFORM_LINE_MAX) return false;
    const k = kids[j];
    if (k.nodeType === 3) { if (/\S/.test(/** @type {Text} */ (k).data)) return false; continue; }
    if (k.nodeType !== 1) continue;
    const f = /** @type {Element} */ (k).getClientRects()[0];
    if (!f) continue;
    if (f.top > r.top + 0.5) return true;
    if (Math.abs(f.top - r.top) > 0.5 || Math.abs(f.bottom - r.bottom) > 0.5) return false;
    const cs = win.getComputedStyle(/** @type {Element} */ (k));
    if (cs.lineHeight !== ref.lineHeight || cs.verticalAlign !== ref.verticalAlign || cs.display !== ref.display) return false;
  }
  return true;
}

/**
 * Children of `src` in the flat tree: a shadow host renders its (open) shadow root's children instead of its own; a <slot> of a shadow tree renders its flattened assigned nodes
 * (or its fallback content). The slot element itself is kept: in the clone it is a light-DOM <slot>, `display: contents` by default, which renders the children it is given.
 * @param {Element} src @returns {Node[]}
 */
function flatChildren(src) {
  if (src.shadowRoot) return childList(src.shadowRoot);
  if (src.localName === 'slot' && src.getRootNode() instanceof ShadowRoot) {
    const assigned = /** @type {HTMLSlotElement} */ (src).assignedNodes({ flatten: true });
    if (assigned.length) return assigned;
  }
  return childList(src);
}

/** @param {Node} parent @returns {Node[]} its child nodes (a sibling walk: cheaper than copying the live NodeList) */
function childList(parent) {
  const out = [];
  for (let n = parent.firstChild; n; n = n.nextSibling) out.push(n);
  return out;
}

/**
 * Elements of a shadow tree inside a drawable, their hosts and the light-DOM elements slotted into them are styled by rules the clone does not carry (shadow-scoped sheets, `:host`, `::slotted`),
 * while document rules that natively stop at the shadow boundary would reach the flattened clone. Such an element carries its full computed style inline (!important), which is exact for its own box;
 * the pseudo-elements of a shadow tree (`::before`/`::after` from a shadow sheet) are not reproduced.
 * The tree-scope test (an element of another scope than the drawable) is made by the caller.
 * @param {Element} src @returns {boolean}
 */
function styledByShadow(src) {
  return !!src.shadowRoot || !!(/** @type {HTMLElement} */ (src).assignedSlot);
}

/** @param {Element} src @param {Element} clone @param {CSSStyleDeclaration} cs  computed style of `src` */
function inlineComputed(src, clone, cs) {
  let text = '';
  for (let i = 0; i < cs.length; i++) {
    const name = cs[i];
    if (name.startsWith('--') || name === 'transition' || name.startsWith('transition-') || name.startsWith('animation')) continue;
    const value = cs.getPropertyValue(name);
    if (value) text += `${name}:${value}!important;`;
  }
  appendInlineStyle(clone, text);
}

/**
 * Logical ancestors of the drawable, innermost first, up to (excluding) the canvas / the layer.
 * @param {Element} el @param {Element} canvas @param {Element} layerEl
 * @returns {Element[]}
 */
function ancestorsOf(el, canvas, layerEl) {
  const out = [];
  for (let cur = el.parentElement; cur && cur !== canvas && cur !== layerEl; cur = cur.parentElement) out.push(cur);
  return out;
}

/**
 * Shells for logical ancestors from shells.js (display:contents, or a real measured box for container-type/contain/overflow/transform/filter ancestors, plus attribute-only display:none sibling stubs), forced size on the drawable clone,
 * nested drawables as spacers (a nested managed canvas appears as a plain canvas bitmap, its layer is skipped through MARK.NODE_ATTR), node budget pruning (req.prune), scroll emulation, state classes from req.interaction.
 * Does NOT paint the caret (caret-overlay.measureCaret feeds CaptureResult.caret). Collects ShakeTokens (css-shake.js) while cloning.
 * @param {HicEnv} env
 * @param {CaptureRequest} req
 * @param {Document} doc  inert document that owns the clone (no custom element upgrades, no resource loads)
 * @param {boolean} [fold]  pruned spacer runs may be merged: true only when the page CSS has no sibling-position selectors
 * @param {boolean} [trunc]  trailing children below a pruned tile may be left out: `fold` and no :has() selector
 * @param {boolean} [wrapSelection]  the page CSS has no :has() selector: selected page text may be wrapped in the clone (an extra inline element changes no :has() answer)
 * @returns {CloneResult}
 */
export function cloneDrawable(env, req, doc, fold = false, trunc = false, wrapSelection = false) {
  const layer = req.record.layer;
  if (!layer) throw new Error('the canvas has no live layer');
  const el = req.element;
  const size = layer.borderBoxSize(el);
  if (!size) throw new Error('the drawable has no border box');
  const live = env.document;
  const win = env.window;
  const layerCs = win.getComputedStyle(layer.element);
  const ink = req.ink;
  const frame = { x: 0 - ink.left, y: 0 - ink.top, width: size.width + ink.left + ink.right, height: size.height + ink.top + ink.bottom };
  /** @type {Ctx} */
  const ctx = {
    env, req, doc, layer, drawable: el, drawables: new Set(layer.drawableElements()), unsupported: [], tokens: createTokenCollector(), ix: interactionContext(req.interaction, layer.element),
    animated: null, scroll: { rules: [], nextId: 0 }, keep: req.prune && req.rect ? inflateRect(req.rect, env.options.inkMargin) : null, nodes: 0, absolute: env.options.nodeBudget.absolute, fold, trunc: fold && trunc, scope: el.getRootNode(), topLayer: topLayerIn(el),
    shift: 0, selection: null, painter: null, frame: layer.frameMeasurer(el),
  };
  ctx.selection = pageSelectionIn(ctx, el, size, wrapSelection);
  if (req.scroll?.hide.length || req.scroll?.shape === 'backdrop') ctx.scroll.rules.push('[data-hic-hide] *{visibility:hidden!important}');
  // the scroll compositor's classic-bar tiles: the track without its thumb, or the thumb alone on a transparent backdrop
  if (req.scroll?.bars === 'track') ctx.scroll.rules.push('[data-hic-bar=thumb]{visibility:hidden!important}');
  // (scoped to the clone root: a hidden svg / foreignObject would paint nothing at all)
  if (req.scroll?.bars === 'thumb') ctx.scroll.rules.push(`.${MARK.CLS_ROOT},.${MARK.CLS_ROOT} *{visibility:hidden!important}[data-hic-bar=thumb]{visibility:visible!important}`);
  const animations = live.getAnimations ? live.getAnimations() : [];
  if (animations.length) ctx.animated = new Set(animations.map((a) => /** @type {KeyframeEffect|null} */ (a.effect)).filter((e) => e && !e.pseudoElement).map((e) => /** @type {Element} */ (e?.target)));

  const root = doc.createElement('div');
  copyRootAttributes(live, root);
  setInlineStyle(root, `${inheritedStyle(layer.element, layerCs)}${ROOT_NEUTRAL}width:${n3(frame.width)}px!important;height:${n3(frame.height)}px!important;padding:${n3(ink.top)}px 0 0 ${n3(ink.left)}px!important`);
  ctx.tokens.add(root);

  const canvas = req.record.canvas;
  const canvasShell = buildShell(doc, canvas, false, null, true);
  applyInteractionClasses(canvas, canvasShell, ctx.ix);
  ctx.tokens.add(canvasShell);
  /** @type {Element} */
  let outer = root;
  for (const above of canvasAncestors(canvas, live)) {
    const shell = ancestorShell(doc, above);
    ctx.tokens.add(shell);
    outer.appendChild(shell);
    outer = shell;
    ctx.nodes++;
  }
  outer.appendChild(canvasShell);

  const dRect = layer.borderBoxRectInLayer(el);
  const chain = ancestorsOf(el, canvas, layer.element).reverse();
  let parent = canvasShell;
  let prevBox = null;
  for (const a of chain) {
    const cs = win.getComputedStyle(a);
    const aRect = shellNeedsBox(shellFactsOf(cs)) ? layer.borderBoxRectInLayer(a) : null;
    let box = null;
    if (aRect && dRect) {
      const left = prevBox ? aRect.x - prevBox.rect.x - prevBox.border.left : aRect.x - dRect.x + ink.left;
      const top = prevBox ? aRect.y - prevBox.rect.y - prevBox.border.top : aRect.y - dRect.y + ink.top;
      box = { width: n3(aRect.width), height: n3(aRect.height), left, top };
    }
    const shell = buildShell(doc, a, !!box, box && { width: +box.width, height: +box.height, left: +n3(box.left), top: +n3(box.top) });
    applyInteractionClasses(a, shell, ctx.ix);
    ctx.tokens.add(shell);
    ctx.nodes += appendWithStubs(doc, parent, a, shell, /** @type {Element} */ (a.parentElement)) + 1;
    parent = shell;
    if (aRect) prevBox = { rect: aRect, border: { left: parseFloat(cs.borderLeftWidth) || 0, top: parseFloat(cs.borderTopWidth) || 0 } };
  }

  let dClone = cloneElement(ctx, el) ?? placeholderFor(ctx, el, 'node-budget', 'drawable skipped');
  const left = prevBox && dRect ? dRect.x - prevBox.rect.x - prevBox.border.left : ink.left;
  const top = prevBox && dRect ? dRect.y - prevBox.rect.y - prevBox.border.top : ink.top;
  appendInlineStyle(dClone, `position:absolute!important;left:${n3(left)}px!important;top:${n3(top)}px!important;right:auto!important;bottom:auto!important;margin:0!important;float:none!important;box-sizing:border-box!important;`
    + `width:${n3(size.width)}px!important;height:${n3(size.height)}px!important;min-width:0!important;min-height:0!important;max-width:none!important;max-height:none!important;`
    + 'contain:layout!important;isolation:isolate!important');
  const dParent = el.parentElement;
  ctx.nodes += dParent ? appendWithStubs(doc, parent, el, dClone, dParent) : (parent.appendChild(dClone), 0);

  const uses = addUseTargets(live, root, req.resources, (u) => ctx.tokens.add(u));
  ctx.nodes += uses.added;
  if (uses.pending) markPending(ctx.unsupported);
  const sizeTotal = el.getElementsByTagName('*').length + 1;
  const caret = addSelectionAndCaret(ctx, root, size, ink);
  return {
    root, nodes: Math.max(ctx.nodes, sizeTotal), unsupported: ctx.unsupported, complete: !isPending(ctx.unsupported), tokens: ctx.tokens.finish(), frame,
    layoutOffset: dRect ? { x: dRect.x, y: dRect.y } : null, caret, extraCss: ctx.scroll.rules.join(''), layerStyle: layerCs,
  };
}

/**
 * Selection highlights go into the tile (inside a zero-size container at the border-box origin); the caret is only measured.
 * @param {Ctx} ctx @param {Element} root @param {{width: number, height: number}} size @param {{left: number, top: number}} ink
 * @returns {{rect: Rect, color: string}|null}
 */
function addSelectionAndCaret(ctx, root, size, ink) {
  const live = ctx.env.document;
  const focus = ctx.req.interaction.focus;
  const box0 = { x: 0, y: 0, width: size.width, height: size.height };
  const rects = ctx.selection
    ? [...ctx.selection.fallback.flatMap((f) => rangeHighlights(live, f.range, ctx.drawable, box0, f.el)), ...lineBreakMarks(ctx, ctx.selection)]
    : buildDocumentSelectionRects(live, ctx.drawable, box0);
  /** @type {{rect: Rect, color: string}|null} */
  let caret = null;
  if (focus && ctx.layer.nearestDrawable(focus) === ctx.drawable) {
    const fr = ctx.layer.frameRect(focus);
    if (fr) {
      rects.push(...fieldSelection(ctx, focus, fr));
      caret = measureCaret(live, focus, fr);
    }
  }
  if (rects.length) {
    const box = ctx.doc.createElement('div');
    setInlineStyle(box, `position:absolute;left:${n3(ink.left)}px;top:${n3(ink.top)}px;width:0;height:0;overflow:visible`);
    for (const r of rects) box.appendChild(ctx.doc.adoptNode(r));
    root.appendChild(box);
  }
  return caret;
}

/** @param {Ctx} ctx @returns {import('./selection-paint.js').SelectionPainter} */
const painterOf = (ctx) => (ctx.painter ??= createSelectionPainter(ctx.env.document));

/** the selected text's wrapper and its rule: every author rule that could reach the element is reset, its pseudo-elements are suppressed */
const SEL_TAG = 'hic-sel';
const SEL_RULE = `:is(#${SEL_TAG},${SEL_TAG}){all:unset!important;unicode-bidi:normal!important}:is(#${SEL_TAG},${SEL_TAG})::before,:is(#${SEL_TAG},${SEL_TAG})::after{content:none!important}`;
/** parents whose text sits in an inline formatting context: an inline wrapper there changes no box (in a flex or grid container it would split an anonymous item) */
const WRAP_DISPLAY = /^(block|inline|inline-block|list-item|flow-root|table-cell|table-caption)$/;

/**
 * The page text selection when it is recoloured inside the clone: Chromium (the engine whose selection painting was measured, util/engine.js), a non-collapsed
 * selection that reaches the drawable, page CSS without :has().
 * @param {Ctx} ctx @param {Element} el the drawable @param {{width: number, height: number}} size @param {boolean} allowed
 * @returns {PageSelection|null}
 */
function pageSelectionIn(ctx, el, size, allowed) {
  if (!allowed || currentEngine().engine !== 'chromium') return null;
  const sel = ctx.env.document.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!range.intersectsNode(el)) return null;
  const w = el.getBoundingClientRect().width;
  return { range, k: w > 0 && size.width > 0 ? w / size.width : 1, fallback: [], wrapped: false, parts: [], frame: { x: 0, y: 0, width: size.width, height: size.height } };
}

/**
 * Vertical padding that stretches an inline box over the content area of a text run (`content` css px tall) to where the engine's selection highlight reaches
 * (measured, Chrome 155 on macOS and Linux): over a line box taller than the text, the line box, whose leading the engine splits with the upper half rounded down to
 * a whole px (a fractional top padding would move the glyphs by one px, measured); over a shorter one, the content area. `1lh` is the used line-height, the font's
 * normal line spacing (line gap included) for line-height normal, which no script API reports.
 * @param {number} content
 * @returns {string}
 */
function lineBoxPadding(content) {
  const lead = `(1lh - ${n3(content)}px)`;
  const top = `round(down,calc(${lead} / 2),1px)`;
  return `padding-top:max(0px,${top})!important;padding-bottom:max(0px,calc(${lead} - ${top}))!important;`;
}

/**
 * Append the text node `k`, a child of `src`, with its selected part wrapped in an inline element that paints the selection as the engine does: its background is the
 * selection background (a translucent Highlight composites over the real backdrop, gradients included), the glyphs on it are the selection foreground (or their own
 * colour), at the positions of the same layout, and the background reaches as far as the engine's (lineBoxPadding). A wrapper is written only where it cannot change
 * a selector's answer or a box: no sibling-position selector in the page CSS or no element sibling, and a parent in an inline formatting context. Otherwise the part
 * becomes an overlay rectangle (PageSelection.fallback).
 * @param {Ctx} ctx @param {Element} src @param {Text} k @param {Element} clone
 * @returns {boolean} the node was appended
 */
function appendSelectedText(ctx, src, k, clone) {
  const sel = /** @type {PageSelection} */ (ctx.selection);
  const { range } = sel;
  if (!range.intersectsNode(k)) return false;
  const s = range.startContainer === k ? range.startOffset : 0;
  const e = range.endContainer === k ? range.endOffset : k.length;
  const parent = k.parentElement;
  if (s >= e || !parent) return false;
  const cs = ctx.env.window.getComputedStyle(parent);
  if (cs.userSelect === 'none') return false;
  const part = ctx.env.document.createRange();
  part.setStart(k, s);
  part.setEnd(k, e);
  const client = part.getClientRects();
  const boxes = Array.from(client).filter((r) => r.width >= 0.5 && r.height >= 0.5);
  if (!boxes.length) return false; // collapsed white space: nothing is painted
  if (parent !== src || !WRAP_DISPLAY.test(cs.display) || (!ctx.fold && parent.childElementCount > 0)) {
    sel.fallback.push({ range: part, el: parent });
    return false;
  }
  const paint = painterOf(ctx).paint(parent);
  const doc = ctx.doc;
  const text = k.data;
  if (s > 0) clone.appendChild(doc.createTextNode(text.slice(0, s)));
  const w = doc.createElement(SEL_TAG);
  w.appendChild(doc.createTextNode(text.slice(s, e)));
  const fg = paint.foreground ? `color:${paint.foreground}!important;-webkit-text-fill-color:${paint.foreground}!important;` : '';
  setInlineStyle(w, `background-color:${paint.background}!important;${lineBoxPadding(boxes[0].height / sel.k)}${fg}`);
  clone.appendChild(w);
  if (e < text.length) clone.appendChild(doc.createTextNode(text.slice(e)));
  ctx.nodes++;
  if (cs.direction === 'ltr') sel.parts.push({ rects: rangeRectsIn(part, ctx.drawable, sel.frame, client), el: parent, background: paint.background, content: boxes[0].height / sel.k });
  if (!sel.wrapped) {
    sel.wrapped = true;
    ctx.scroll.rules.push(SEL_RULE);
  }
  return true;
}

/**
 * The engine marks a line break inside the selection: where the selected text goes on on a later line, a space-wide highlight follows the last glyph of the line
 * (measured, Chrome 155 on macOS and Linux), as tall as the highlight of the text. Drawn as overlay rectangles: nothing is painted there. Left-to-right text only.
 * @param {Ctx} ctx @param {PageSelection} sel
 * @returns {Element[]}
 */
function lineBreakMarks(ctx, sel) {
  const frags = sel.parts.flatMap((p) => p.rects.map((r) => ({ r, p })));
  /** @type {Element[]} */
  const out = [];
  const measure = measuringContext(ctx.env.document);
  for (let i = 0; i + 1 < frags.length && measure; i++) {
    const { r, p } = frags[i];
    if (frags[i + 1].r.y < r.y + r.height / 2) continue;
    const cs = ctx.env.window.getComputedStyle(p.el);
    applyFont(measure, cs);
    const space = measure.measureText(' ').width;
    const mark = ctx.doc.createElement('div');
    setInlineStyle(mark, `position:absolute;pointer-events:none;z-index:50;left:${n3(r.x + r.width)}px;width:${n3(space)}px;background:${p.background};`
      + `${lineMetrics(cs)}top:calc(${n3(r.y)}px - max(0px,round(down,calc((1lh - ${n3(p.content)}px) / 2),1px)));height:max(${n3(p.content)}px,1lh)`);
    out.push(mark);
  }
  return out;
}

/** @param {CSSStyleDeclaration} cs @returns {string} the font and line-height of `cs`: an overlay box with them resolves `1lh` to the same line box */
const lineMetrics = (cs) => `font-family:${cs.fontFamily};font-size:${cs.fontSize};font-style:${cs.fontStyle};font-weight:${cs.fontWeight};font-stretch:${cs.fontStretch};line-height:${cs.lineHeight};`;

/** a copy of a text field that paints nothing but its glyphs */
const GLYPHS_ONLY = 'position:absolute!important;right:auto!important;bottom:auto!important;margin:0!important;float:none!important;transform:none!important;translate:none!important;'
  + 'rotate:none!important;scale:none!important;background:none!important;border-color:transparent!important;border-image:none!important;box-shadow:none!important;outline:none!important;'
  + 'appearance:none!important;-webkit-appearance:none!important;caret-color:transparent!important;pointer-events:none!important;z-index:51!important;';

/**
 * The selection of the focused single-line text field. Chromium: the selection background as an opaque rectangle over the field's glyphs (the selection colour composited
 * over a solid backdrop; translucent over any other backdrop), then the selected glyphs again in the selection foreground: a copy of the field that carries its full
 * computed style, its value and scroll and paints nothing but the text, clipped to the selection rectangle. The engine lays the copy out like the field, so the glyphs land
 * where the field's glyphs are (the engine clips the selected glyphs to the same rectangle). Other engines, and a field the copy cannot reproduce (scaled, replaced
 * by the clone): the selection colour over the glyphs (caret-overlay.js selectionLook).
 * @param {Ctx} ctx @param {Element} focus @param {Rect} fr  the field's border box in the drawable frame
 * @returns {Element[]}
 */
function fieldSelection(ctx, focus, fr) {
  const live = ctx.env.document;
  if (currentEngine().engine !== 'chromium') return buildSelectionRects(live, focus, fr);
  const rect = inputSelectionRect(live, focus, fr);
  if (!rect) return [];
  const cs = ctx.env.window.getComputedStyle(focus);
  // the inner editor is one line box (1lh: the used line-height, line gap included for normal) centred in the content box
  const top = fr.y + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0);
  const centred = `calc(${n3(top)}px + (${n3(focus.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0))}px - 1lh) / 2)`;
  const paint = painterOf(ctx).paint(focus);
  const glyphs = glyphCopy(ctx, /** @type {HTMLInputElement} */ (focus), fr, rect, centred, paint.foreground);
  if (!glyphs) return buildSelectionRects(live, focus, fr);
  const under = solidBackdrop(ctx.env.window, focus);
  const bg = (under && compositeOver(under, paint.background)) ?? paint.background;
  const back = ctx.doc.createElement('div');
  setInlineStyle(back, `position:absolute;pointer-events:none;z-index:50;left:${n3(rect.x)}px;top:${centred};width:${n3(rect.width)}px;height:1lh;background:${bg};`
    + lineMetrics(cs));
  return [back, glyphs];
}

/**
 * @param {Ctx} ctx @param {HTMLInputElement} src @param {Rect} fr @param {Rect} rect the selection rectangle (horizontal extent) @param {string} lineTop  CSS length: the top of the
 * inner editor's line box in the drawable frame @param {string|null} color  the glyph colour (null: their own)
 * @returns {Element|null}
 */
function glyphCopy(ctx, src, fr, rect, lineTop, color) {
  if (Math.abs(fr.width - src.offsetWidth) > 0.5 || Math.abs(fr.height - src.offsetHeight) > 0.5) return null;
  const copy = ctx.doc.importNode(src, false);
  cleanAttributes(copy);
  inlineComputed(src, copy, ctx.env.window.getComputedStyle(src));
  if (syncNodeState(ctx.env, src, copy, ctx.req, []) !== true) return null;
  // clipped to the selection: its x extent and the line box (the copy has the field's line-height, so 1lh is the same there)
  const y = `calc(${lineTop} - ${n3(fr.y)}px)`;
  const clip = `${y} ${n3(fr.x + fr.width - rect.x - rect.width)}px calc(${n3(fr.height)}px - ${y} - 1lh) ${n3(rect.x - fr.x)}px`;
  appendInlineStyle(copy, `${GLYPHS_ONLY}left:${n3(fr.x)}px!important;top:${n3(fr.y)}px!important;clip-path:inset(${clip})!important;`
    + (color ? `color:${color}!important;-webkit-text-fill-color:${color}!important;` : ''));
  return copy;
}
