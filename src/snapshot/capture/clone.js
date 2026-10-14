/**
 * State-synced clone of one drawable (docs/ARCHITECTURE.md ADR-D.1).
 * Module: snapshot-capture (src/snapshot/capture/*).
 */

import { MARK } from '../../contracts/events.js';
import { inflateRect, intersectRect } from '../../util/rect.js';
import { buildDocumentSelectionRects, buildSelectionRects, measureCaret } from './caret-overlay.js';
import { ancestorShell, canvasAncestors } from './custom-props.js';
import { createTokenCollector } from './css-shake.js';
import { applyScrollState, scrollFacts } from './scroll-emulation.js';
import { appendWithStubs, buildShell, shellFactsOf, shellNeedsBox, siblingStub } from './shells.js';
import {
  LEAF_TAGS, applyInteractionClasses, cleanAttributes, elementPath, freezeAnimations, inTopLayer, interactionContext, isPending, markPending, syncNodeState, usedColorScheme,
} from './state-sync.js';
import { placeholderElement } from './placeholder.js';
import { addUseTargets } from './svg-refs.js';
import { appendInlineStyle, setInlineStyle } from './inline-style.js';

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
 * @property {string} extraCss     per-capture rules (scroll markers) that go after the shaken sheet
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
 * @property {Node} scope  tree scope of the drawable (document or the canvas's shadow root): elements of other scopes are inside shadow trees of the drawable
 * @property {number} shift  css px by which the descendants of CaptureRequest.scroll.el appear moved in the clone (live scrollTop - rendered scrollTop): live rects are shifted by it before a prune test
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

/** @param {Ctx} ctx @param {Element} src @param {Rect} r @returns {Element} invisible same-size stand-in; keeps tag, class and inline style so selectors and margins still apply */
function spacerFor(ctx, src, r) {
  const sp = ctx.doc.importNode(src, false);
  cleanAttributes(sp);
  sp.removeAttribute('id');
  sp.setAttribute('data-hic-sp', '');
  appendInlineStyle(sp, `width:${n3(r.width)}px!important;height:${n3(r.height)}px!important`);
  ctx.tokens.add(sp);
  return sp;
}

/** @param {Ctx} ctx @param {Element} k @param {Rect|null} window  extra keep region for children of a long scroller @returns {{r: Rect, cs: CSSStyleDeclaration}|null} set when `k` can be replaced by a spacer */
function spacerInfo(ctx, k, window) {
  if (!ctx.keep && !window) return null;
  const live = ctx.layer.frameRect(k);
  const r = live && ctx.shift ? { x: live.x, y: live.y + ctx.shift, width: live.width, height: live.height } : live;
  if (!r || r.width <= 0 || r.height <= 0) return null;
  if ((!ctx.keep || intersectRect(r, ctx.keep)) && (!window || intersectRect(r, window))) return null;
  if (ctx.ix.focusWithin.has(k) || k.contains(ctx.drawable)) return null;
  const cs = ctx.env.window.getComputedStyle(k);
  if (NO_PRUNE_DISPLAY.test(cs.display) || cs.position === 'absolute' || cs.position === 'fixed' || cs.position === 'sticky' || cs.transform !== 'none') return null;
  return { r, cs };
}

/**
 * A run of adjacent, equally wide block spacers in a block-flow parent becomes one spacer (measured: the SVG shrinks several times). Only when no selector counts siblings (ctx.fold):
 * a merged run shifts :nth-child parity and sibling combinators of the rows behind it.
 * @typedef {{el: HTMLElement, tag: string, x: number, y: number, width: number}} SpacerRun
 */

/** @param {SpacerRun|null} run @param {Element} k @param {{r: Rect, cs: CSSStyleDeclaration}} info @returns {boolean} true when `k` was folded into the run */
function extendRun(run, k, info) {
  if (!run || run.tag !== k.localName || !/^(block|list-item|flow-root|flex|grid)$/.test(info.cs.display)) return false;
  if (Math.abs(info.r.x - run.x) > 0.5 || Math.abs(info.r.width - run.width) > 0.5 || info.r.y < run.y) return false;
  run.el.style.setProperty('height', `${n3(info.r.y + info.r.height - run.y)}px`, 'important');
  run.el.style.setProperty('margin-bottom', info.cs.marginBottom, 'important');
  return true;
}

/** @param {Ctx} ctx @param {Element} src @returns {Element|null} */
function cloneElement(ctx, src) {
  const ln = src.localName;
  if (src.hasAttribute(MARK.NODE_ATTR)) return null;
  // script/style/link/template never render but they count for :nth-child and sibling combinators: an attribute-only display:none stand-in keeps the indices
  if (SKIP.has(ln) || inTopLayer(src)) return siblingStub(ctx.doc, src);
  const html = /** @type {HTMLElement} */ (src);
  if (html.hidden || html.style?.display === 'none') {
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
  if (!replaced && styledByShadow(ctx, src)) inlineComputed(ctx, src, clone);
  // backdrop of the optimistic text overlay (text-overlay.js): the field without its text
  if (src === ctx.req.hideText) appendInlineStyle(clone, 'color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important');
  // a page of the scroll compositor: pinned (sticky) elements are drawn from their own tile
  if (ctx.req.scroll?.hide.includes(src)) {
    appendInlineStyle(clone, 'visibility:hidden!important');
    clone.setAttribute('data-hic-hide', '');
  }
  if (ctx.animated?.has(src)) freezeAnimations(src, /** @type {HTMLElement} */ (clone));
  ctx.tokens.add(clone);
  if (!replaced && !LEAF_TAGS.has(ln)) cloneChildren(ctx, src, clone);
  maybeScroll(ctx, src, clone);
  return clone;
}

/** @param {Ctx} ctx @param {Element} src @param {Element} clone */
function maybeScroll(ctx, src, clone) {
  if (!(src.scrollTop || src.scrollLeft || src.scrollHeight > src.clientHeight || src.scrollWidth > src.clientWidth)) return;
  const cs = ctx.env.window.getComputedStyle(src);
  const over = ctx.req.scroll?.el === src ? ctx.req.scroll : null;
  const live = scrollFacts(src, cs);
  const f = over ? { ...(live ?? { sL: src.scrollLeft, gv: 0, gh: 0, scrollableY: true, scrollableX: false, styled: false }), sT: over.top } : live;
  if (f) applyScrollState(ctx.env, src, /** @type {HTMLElement} */ (clone), ctx.req, ctx.scroll, f);
}

/** @param {Ctx} ctx @param {Element} src @param {Element} clone */
function cloneChildren(ctx, src, clone) {
  if (ctx.nodes > ctx.absolute) throw new BudgetExceeded(ctx.nodes);
  /** @type {Rect|null} */
  let window = null;
  const over = ctx.req.scroll?.el === src ? ctx.req.scroll : null;
  if (src.childElementCount > WINDOW_CHILDREN && src.scrollHeight + src.scrollWidth > src.clientHeight + src.clientWidth) {
    const r = ctx.layer.frameRect(src);
    if (r) window = inflateRect({ x: r.x, y: r.y + (over ? 0 : ctx.shift), width: r.width, height: r.height }, Math.max(r.width, r.height) * 0.6);
  }
  // a page of the scroll compositor renders `src` at another offset: its descendants appear moved by the difference
  const shifted = ctx.shift;
  if (over) ctx.shift = /** @type {HTMLElement} */ (src).scrollTop - over.top;
  try {
    cloneChildList(ctx, src, clone, window);
  } finally {
    ctx.shift = shifted;
  }
}

/** @param {Ctx} ctx @param {Element} src @param {Element} clone @param {Rect|null} window */
function cloneChildList(ctx, src, clone, window) {
  /** @type {SpacerRun|null} */
  let run = null;
  const blockParent = ctx.fold && (ctx.keep || window) && /^(block|list-item|flow-root|flex|grid)$/.test(ctx.env.window.getComputedStyle(src).display);
  for (const k of flatChildren(src)) {
    if (k.nodeType === 3) {
      const text = /** @type {Text} */ (k).data;
      if (/\S/.test(text)) run = null;
      clone.appendChild(ctx.doc.createTextNode(text));
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
    const info = SKIP.has(el.localName) ? null : spacerInfo(ctx, el, window);
    if (info) {
      ctx.nodes += 1 + el.getElementsByTagName('*').length;
      if (blockParent && extendRun(run, el, info)) continue;
      const sp = /** @type {HTMLElement} */ (spacerFor(ctx, el, info.r));
      clone.appendChild(sp);
      run = blockParent && /^(block|list-item|flow-root|flex|grid)$/.test(info.cs.display) ? { el: sp, tag: el.localName, x: info.r.x, y: info.r.y, width: info.r.width } : null;
      continue;
    }
    run = null;
    const c = cloneElement(ctx, el);
    if (c) clone.appendChild(c);
  }
}

/**
 * Children of `src` in the flat tree: a shadow host renders its (open) shadow root's children instead of its own; a <slot> of a shadow tree renders its flattened assigned nodes
 * (or its fallback content). The slot element itself is kept: in the clone it is a light-DOM <slot>, `display: contents` by default, which renders the children it is given.
 * @param {Element} src @returns {Node[]}
 */
function flatChildren(src) {
  if (src.shadowRoot) return Array.from(src.shadowRoot.childNodes);
  if (src.localName === 'slot' && src.getRootNode() instanceof ShadowRoot) {
    const assigned = /** @type {HTMLSlotElement} */ (src).assignedNodes({ flatten: true });
    if (assigned.length) return assigned;
  }
  return Array.from(src.childNodes);
}

/**
 * Elements of a shadow tree inside a drawable, their hosts and the light-DOM elements slotted into them are styled by rules the clone does not carry (shadow-scoped sheets, `:host`, `::slotted`),
 * while document rules that natively stop at the shadow boundary would reach the flattened clone. Such an element carries its full computed style inline (!important), which is exact for its own box;
 * the pseudo-elements of a shadow tree (`::before`/`::after` from a shadow sheet) are not reproduced.
 * @param {Ctx} ctx @param {Element} src @returns {boolean}
 */
function styledByShadow(ctx, src) {
  return !!src.shadowRoot || !!(/** @type {HTMLElement} */ (src).assignedSlot) || src.getRootNode() !== ctx.scope;
}

/** @param {Ctx} ctx @param {Element} src @param {Element} clone */
function inlineComputed(ctx, src, clone) {
  const cs = ctx.env.window.getComputedStyle(src);
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
 * @returns {CloneResult}
 */
export function cloneDrawable(env, req, doc, fold = false) {
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
    animated: null, scroll: { rules: [], nextId: 0 }, keep: req.prune && req.rect ? inflateRect(req.rect, env.options.inkMargin) : null, nodes: 0, absolute: env.options.nodeBudget.absolute, fold, scope: el.getRootNode(),
    shift: 0,
  };
  if (req.scroll?.hide.length) ctx.scroll.rules.push('[data-hic-hide] *{visibility:hidden!important}');
  // the scroll compositor's classic-bar tiles: the track without its thumb, or the thumb alone on a transparent backdrop
  if (req.scroll?.bars === 'track') ctx.scroll.rules.push('[data-hic-bar=thumb]{visibility:hidden!important}');
  if (req.scroll?.bars === 'thumb') ctx.scroll.rules.push('*{visibility:hidden!important}[data-hic-bar=thumb]{visibility:visible!important}');
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
 * Selection rectangles go into the tile (inside a zero-size container at the border-box origin); the caret is only measured.
 * @param {Ctx} ctx @param {Element} root @param {{width: number, height: number}} size @param {{left: number, top: number}} ink
 * @returns {{rect: Rect, color: string}|null}
 */
function addSelectionAndCaret(ctx, root, size, ink) {
  const live = ctx.env.document;
  const focus = ctx.req.interaction.focus;
  const rects = buildDocumentSelectionRects(live, ctx.drawable, { x: 0, y: 0, width: size.width, height: size.height });
  /** @type {{rect: Rect, color: string}|null} */
  let caret = null;
  if (focus && ctx.layer.nearestDrawable(focus) === ctx.drawable) {
    const fr = ctx.layer.frameRect(focus);
    if (fr) {
      rects.push(...buildSelectionRects(live, focus, fr));
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
