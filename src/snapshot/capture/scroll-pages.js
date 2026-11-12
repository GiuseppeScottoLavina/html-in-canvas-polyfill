/**
 * Scroll compositor, capture side: may a scroller be shown by composing cached PAGES (its scrollport rendered at other
 * offsets, CaptureRequest.scroll) plus its pinned sticky elements, and with what geometry. Answers null for everything the composition could not reproduce exactly; that
 * scroller keeps the plain snapshot path (a whole-scroller tile per scroll step), which is exact by construction.
 * Module: snapshot-capture (src/snapshot/capture/*).
 */

import { currentEngine } from '../../util/engine.js';
import { intersectRect } from '../../util/rect.js';
import { parseColor } from './caret-overlay.js';
import { engineSkins } from './engine-skins.js';
import { WEBKIT_SYSTEM_INSET, WEBKIT_SYSTEM_MIN, webkitSystemKnob } from './webkit-bar-geometry.js';
import { chromiumBarLook, chromiumVerticalBar, parseScrollbarColor, scrollFacts, styledMinThumb, verticalBar, webkitStyledBar, webkitStyledMinThumb } from './scroll-emulation.js';

/** @typedef {import('../../contracts/types.js').LiveLayer} LiveLayer */
/** @typedef {import('../../contracts/types.js').Rect} Rect */
/** @typedef {import('../../contracts/types.js').ScrollPlan} ScrollPlan */

/**
 * ScrollPlan.cover: the backgrounds the compositor's cover tiles give the scroller, its content hidden (scroll-compose.js vet), one tile each. A port pixel of another
 * colour in either is painted by something the pages would carry along (an element outside the scroller, or what shows through it). One colour alone passes an overlay
 * of that very colour (rgb(1, 254, 3) over the port: 24,000 of 104,000 pixels wrong in the first composed step), and so would any single colour, picked at random or
 * not. Two colours whose every channel lies near opposite ends (at least 249 levels apart): an opaque overlay differs from one of them whatever its colour, and a
 * translucent one passes both only at an alpha under 0.004 (alpha times 124 levels rounds to nothing), about one level of error over the content.
 */
/** @type {Array<[number, number, number]>} */
const COVERS = [[1, 254, 3], [254, 1, 252]];
/** at most this many elements in the scroller are inspected (larger: no composition; the node budget's absolute limit is 20000) */
const MAX_SCAN = 20000;
/** elements inspected per step of a large scroller's scan at most (planSteps) */
const SCAN_STEP = 2500;
/**
 * A step of the plan yields once it has run this long (ms; the clock is read every SCAN_CLOCK elements and at every hit test). The pump admits side jobs while it has
 * spent under 4 ms, so one pump runs two steps at most. Measured (headless Chrome, a 1,058 px port over 10,000 rows): the 32 x 32 hit-test grid took 168 ms in one
 * task, 1,100 ms at 6x CPU throttling.
 */
const STEP_MS = 3;
const SCAN_CLOCK = 64;
const UNSAFE_TAGS = new Set(['video', 'canvas', 'iframe', 'embed', 'object']);

/** @param {string} v @returns {number} */
const px = (v) => parseFloat(v) || 0;

/** @param {CSSStyleDeclaration} cs @returns {boolean} no effect that mixes pixels across the scrollport or depends on the scroll offset */
function plainEffects(cs) {
  return cs.filter === 'none' && (cs.backdropFilter ?? 'none') === 'none' && (cs.mixBlendMode ?? 'normal') === 'normal' && (cs.clipPath ?? 'none') === 'none'
    && ((/** @type {any} */ (cs)).maskImage ?? 'none') === 'none';
}

/** elements whose painting in a Gecko image was not verified under a moving clip (images, SVG and MathML, form controls: the engines bundle skins them) */
const GECKO_UNVERIFIED = new Set(['img', 'picture', 'svg', 'math', 'input', 'select', 'textarea', 'meter', 'progress']);
/** line styles a Gecko image paints the same whatever clips them (dotted lines are rows of round dots) */
const GECKO_LINES = /^(none|hidden|solid|dashed)$/;

/**
 * Gecko: does this box (an element of the scroller's content, or one of its pseudo-elements) paint the same pixels wherever the scrollport or a page edge cuts it? A Gecko
 * image paints a rounded corner, a dotted line or a transformed box differently once a clip edge crosses it (Firefox 157, a 24 x 16.8 px box with 6 px corners cut 2 px
 * below its top: its top corner pixels change by up to 159 of 255; dotted borders by up to 28, a rotated box by up to 25), so a composed frame, whose pages cut the content
 * at other rows than the settled tile, would differ there. Verified unchanged under such a cut: text, square solid and dashed borders, colours, linear gradients, url()
 * backgrounds, box and text shadows, opacity, list markers, wavy underlines, nested square clips. Everything else is refused.
 * @param {CSSStyleDeclaration} cs @returns {boolean}
 */
function clipInvariant(cs) {
  const any = /** @type {any} */ (cs);
  return square(cs) && cs.transform === 'none' && (any.rotate ?? 'none') === 'none' && (any.scale ?? 'none') === 'none' && (any.translate ?? 'none') === 'none'
    && plainEffects(cs) && GECKO_LINES.test(cs.borderTopStyle) && GECKO_LINES.test(cs.borderRightStyle) && GECKO_LINES.test(cs.borderBottomStyle)
    && GECKO_LINES.test(cs.borderLeftStyle) && GECKO_LINES.test(cs.outlineStyle) && GECKO_LINES.test(any.columnRuleStyle ?? 'none')
    && (any.borderImageSource ?? 'none') === 'none' && cs.listStyleImage === 'none' && (any.textEmphasisStyle ?? 'none') === 'none'
    && (cs.textDecorationLine === 'none' || /^(solid|wavy)$/.test(cs.textDecorationStyle)) && !/radial|conic|image-set|cross-fade|element\(|paint\(/.test(cs.backgroundImage);
}

/** @param {CSSStyleDeclaration} cs @returns {boolean} square corners */
const square = (cs) => px(cs.borderTopLeftRadius) === 0 && px(cs.borderTopRightRadius) === 0 && px(cs.borderBottomLeftRadius) === 0 && px(cs.borderBottomRightRadius) === 0;

/** @param {string} v one computed corner radius ("10px", "10px 5px", "50%") @param {number} w @param {number} h @returns {{x: number, y: number}} */
function corner(v, w, h) {
  const [a, b = a] = v.trim().split(/\s+/);
  const len = (/** @type {string} */ t, /** @type {number} */ of) => (t.endsWith('%') ? (parseFloat(t) / 100) * of : px(t));
  return { x: Math.max(0, len(a, w)), y: Math.max(0, len(b, h)) };
}

/**
 * The used outer radii of a border box w x h (percentages resolved, scaled down together where adjacent radii overlap, CSS Backgrounds 3 section 5.5).
 * @param {CSSStyleDeclaration} cs @param {number} w @param {number} h
 */
export function outerRadii(cs, w, h) {
  const tl = corner(cs.borderTopLeftRadius, w, h), tr = corner(cs.borderTopRightRadius, w, h);
  const br = corner(cs.borderBottomRightRadius, w, h), bl = corner(cs.borderBottomLeftRadius, w, h);
  let f = 1;
  for (const [side, sum] of [[w, tl.x + tr.x], [w, bl.x + br.x], [h, tl.y + bl.y], [h, tr.y + br.y]]) if (sum > side) f = Math.min(f, side / sum);
  const k = (/** @type {{x: number, y: number}} */ r) => ({ x: r.x * f, y: r.y * f });
  return { tl: k(tl), tr: k(tr), br: k(br), bl: k(bl) };
}

/**
 * Inner radii of the scrollport (the padding box edge: outer radius minus the adjacent border width), null when every one is 0.
 * @param {CSSStyleDeclaration} cs @param {number} w @param {number} h border box
 * @returns {NonNullable<ScrollPlan['round']>|null}
 */
export function innerRadii(cs, w, h) {
  const o = outerRadii(cs, w, h);
  const bl = px(cs.borderLeftWidth), bt = px(cs.borderTopWidth), br = px(cs.borderRightWidth), bb = px(cs.borderBottomWidth);
  const r = {
    tl: { x: Math.max(0, o.tl.x - bl), y: Math.max(0, o.tl.y - bt) }, tr: { x: Math.max(0, o.tr.x - br), y: Math.max(0, o.tr.y - bt) },
    br: { x: Math.max(0, o.br.x - br), y: Math.max(0, o.br.y - bb) }, bl: { x: Math.max(0, o.bl.x - bl), y: Math.max(0, o.bl.y - bb) },
  };
  return Object.values(r).some((c) => c.x > 0 && c.y > 0) ? r : null;
}

/** scrollers whose last plan was refused for a sticky element it cannot pin (Capture.scrollRefusal: the store names the refusal `sticky`) */
const unpinnable = new WeakSet();

/** Why the last plan of `scroller` was refused, when it was for a sticky element (read on a refusal only). @param {Element} scroller @returns {'sticky'|null} */
export function scrollRefusal(scroller) {
  return unpinnable.has(scroller) ? 'sticky' : null;
}

/** an element's stacking order among the positioned boxes of its stacking context: z-index auto paints with z-index 0 @param {CSSStyleDeclaration} cs */
const zOf = (cs) => (cs.zIndex === 'auto' ? 0 : Number(cs.zIndex));

/**
 * A stacking context without a z-index of its own: painted with the positioned boxes of z-index auto and 0, in tree order (CSS 2 appendix E), so above an earlier
 * sticky element of z-index auto or 0. Conservative: every property that may make one counts.
 * @param {CSSStyleDeclaration} cs
 */
function ownLayer(cs) {
  const c = /** @type {any} */ (cs);
  return cs.opacity !== '1' || cs.transform !== 'none' || (c.translate ?? 'none') !== 'none' || (c.rotate ?? 'none') !== 'none' || (c.scale ?? 'none') !== 'none'
    || cs.perspective !== 'none' || !plainEffects(cs) || cs.isolation === 'isolate' || (c.willChange ?? 'auto') !== 'auto' || /paint|layout|strict|content/.test(c.contain ?? 'none')
    || (c.containerType ?? 'normal') !== 'normal' || (c.viewTransitionName ?? 'none') !== 'none';
}

/**
 * A sticky element the compositor can draw from one tile at its live position: an opaque rectangle with nothing outside its border box, painted above the scroller's
 * in-flow content (z-index auto or not negative; what else may paint above it is checked by planSteps).
 * @param {Element} el @param {CSSStyleDeclaration} cs @returns {boolean}
 */
function pinnable(el, cs) {
  if (cs.position !== 'sticky') return false;
  const bg = parseColor(cs.backgroundColor);
  const h = /** @type {HTMLElement} */ (el);
  return !!bg && bg[3] >= 1 && cs.backgroundImage === 'none' && square(cs) && cs.boxShadow === 'none' && (cs.outlineStyle === 'none' || px(cs.outlineWidth) === 0)
    && (cs.opacity === '1' || cs.opacity === '') && cs.transform === 'none' && plainEffects(cs) && zOf(cs) >= 0
    && h.scrollWidth <= h.clientWidth + 1 && h.scrollHeight <= h.clientHeight + 1;
}

/**
 * Nothing but the scroller or its descendants is hit on a grid over its scrollport (32 css px), and every point lies in the viewport. Points outside a rounded
 * corner of the port are skipped (what is hit there is what lies behind the corner). In steps: a hit test costs in proportion to the scroller's children (Chrome
 * 156: 165 us per point over 10,000 rows), so the grid yields every STEP_MS and goes on only while `still()` says nothing it tests has changed.
 * @param {Document} doc @param {Element} scroller @param {DOMRect} port viewport rect of the scrollport @param {ScrollPlan['round']} round
 * @param {() => number} now @param {number} t0  when the current step began @param {() => boolean} still
 * @returns {Generator<void, boolean, void>}
 */
function* portUnobstructed(doc, scroller, port, round, now, t0, still) {
  const win = doc.defaultView;
  if (!win || port.left < 0 || port.top < 0 || port.right > win.innerWidth || port.bottom > win.innerHeight) return false;
  const root = /** @type {Document|ShadowRoot} */ (scroller.getRootNode());
  const hit = typeof root.elementFromPoint === 'function' ? root : doc;
  const cols = Math.min(32, Math.ceil(port.width / 32) + 1);
  const rows = Math.min(32, Math.ceil(port.height / 32) + 1);
  for (let c = 0; c < cols; c++) {
    const x = port.left + 1 + ((port.width - 2) * c) / Math.max(1, cols - 1);
    for (let r = 0; r < rows; r++) {
      const y = port.top + 1 + ((port.height - 2) * r) / Math.max(1, rows - 1);
      if (round && outsideCorner(x - port.left, y - port.top, port.width, port.height, round)) continue;
      if (now() - t0 > STEP_MS) { yield; if (!still()) return false; t0 = now(); }
      const top = hit.elementFromPoint(x, y);
      if (!top || (top !== scroller && !scroller.contains(top))) return false;
    }
  }
  return true;
}

/** @param {number} x @param {number} y point in the port @param {number} w @param {number} h port size @param {NonNullable<ScrollPlan['round']>} r inner radii @returns {boolean} */
function outsideCorner(x, y, w, h, r) {
  const out = (/** @type {number} */ dx, /** @type {number} */ dy, /** @type {{x: number, y: number}} */ c) => dx < c.x && dy < c.y && ((c.x - dx) / c.x) ** 2 + ((c.y - dy) / c.y) ** 2 > 1;
  return out(x, y, r.tl) || out(w - x, y, r.tr) || out(w - x, h - y, r.br) || out(x, h - y, r.bl);
}

/**
 * PURE. The layout grid of the snapshot image on an engine whose pages the compositor can reproduce (ScrollPlan.grid), or undefined when it does not compose there.
 * - Chromium lays the image out at device scale (svg-builder.js scaleMode 'zoom'): edges and scroll offsets land on surface pixels. No grid (0).
 * - WebKit lays it out at css scale and a CSS transform scales it ('transform'): every box edge is snapped to whole css px and a scroll offset is rendered at whole
 *   css px, then scaled. Measured in Mobile Safari 26.4 at DPR 3 (test/bench/scroll-jank-ios.mjs oracle): pages at the device-pixel offsets of the Chromium path
 *   came out one device pixel lower than the tile at the same offset, and the port one device row taller. Grid 1.
 * - Gecko lays it out at css scale and the image scales it ('viewBox'): every box edge is snapped to surface pixels as on Chromium (Firefox 157, a box at top 10.2 px,
 *   20.3 px tall: surface rows 31-91 at scale 3, 13-37 at 1.25), but a scroll offset is rendered at its exact value: only whole-pixel offsets compose
 *   (ScrollPlan.whole, scroll-compose.js wholeRow), and only on a 1x page with content whose painting no clip edge changes (planSteps).
 * @param {string} engine
 * @returns {number|undefined}
 */
export function composeGrid(engine) {
  return engine === 'chromium' || engine === 'gecko' ? 0 : engine === 'webkit' ? 1 : undefined;
}

/**
 * Plan the composition of `scroller` (a vertical scroller inside `drawable`, or the drawable itself). Expensive (a computed-style scan of the subtree and a hit-test grid):
 * the store caches it until something other than this scroller's own scrolling damages the drawable.
 * @param {Document} doc @param {LiveLayer} layer @param {Element} scroller @param {Element} drawable
 * @returns {ScrollPlan|null}
 */
export function planScrollPages(doc, layer, scroller, drawable) {
  const steps = planSteps(doc, layer, scroller, drawable);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/**
 * planScrollPages in steps: the scan of a large scroller yields after every SCAN_STEP elements or STEP_MS, and the hit-test grid every STEP_MS, so the store can
 * spread it over several post-frame tasks (Capture.scrollPlan). A step that finds the scroller changed in between (its subtree's size, its place in the viewport,
 * the viewport's size) answers null (the store plans it again after newer damage or a move).
 * @param {Document} doc @param {LiveLayer} layer @param {Element} scroller @param {Element} drawable @param {string} [engine]  the engine (tests pass one)
 * @returns {Generator<void, ScrollPlan|null, void>}
 */
export function* planSteps(doc, layer, scroller, drawable, engine = currentEngine().engine) {
  unpinnable.delete(scroller);
  const win = doc.defaultView;
  const grid = composeGrid(engine);
  if (!win || grid === undefined || layer.nearestDrawable(scroller) !== drawable && scroller !== drawable) return null;
  const gecko = engine === 'gecko';
  // Gecko lays an SVG image out with the font metrics and border widths of a 1x display whatever the page's devicePixelRatio, while the page snaps both to its device
  // pixels (Firefox 157, 30 rows of 13 px text: 420 css px in the image at every ratio, 408 / 420 / 405 live at 1.25 / 1.5 / 2; 30 rows with a 1 px border: 630 in the
  // image, 624 / 620 live at 1.25 / 1.5). The port, the pinned elements and the spacers of pruned rows come from the live layout, so only a 1x page composes
  if (gecko && win.devicePixelRatio !== 1) return null;
  const s = /** @type {HTMLElement} */ (scroller);
  const cs = win.getComputedStyle(s);
  // the bar gutters from whole-pixel sizes: offsetWidth and clientWidth are rounded each on its own, so a fractional layout (a 400.4 px track at DPR 1.25: 400 and 399)
  // shows a gutter of -1 or +1 px that is not there; a classic bar is far wider
  const gutter = (/** @type {number} */ g) => (Math.abs(g) <= 1 ? 0 : g);
  const gutterX = gutter(s.offsetWidth - s.clientWidth - px(cs.borderLeftWidth) - px(cs.borderRightWidth));
  const gutterY = gutter(s.offsetHeight - s.clientHeight - px(cs.borderTopWidth) - px(cs.borderBottomWidth));
  // a vertical classic bar is composed from its track and thumb tiles; a horizontal one (or a corner) is not
  if (!/^(auto|scroll)$/.test(cs.overflowY) || s.scrollHeight <= s.clientHeight || s.scrollWidth > s.clientWidth + 1 || s.scrollLeft !== 0 || gutterX < -0.5 || Math.abs(gutterY) > 0.5) return null;
  // the author's values: the scroll synchronisation (LiveLayer.syncScroll) overrides these three on the live scroller while it scrolls
  const own = layer.scrollAuthorStyle?.(s) ?? cs;
  if (/ inset/.test(` ${own.boxShadow}`) || !plainEffects(cs) || (own.backgroundImage !== 'none' && !/^local/.test(own.backgroundAttachment))) return null;
  const frame = layer.frameRect(s);
  // offsetWidth is rounded to an integer (a fractional layout at DPR 1.25 / 1.5 is still a plain box)
  if (!frame || Math.abs(frame.width - s.offsetWidth) > 0.51 || Math.abs(frame.height - s.offsetHeight) > 0.51) return null;
  const bl = px(cs.borderLeftWidth);
  const bt = px(cs.borderTopWidth);
  // the padding box at its layout size: clientWidth / clientHeight are rounded to whole css px, and in a fractional layout (a grid track of 541.33 px) a port of
  // 541 px left the last device pixel column out of every page, and refused the sticky header, which is 541.33 px wide (a classic bar keeps the client size)
  const port = { x: frame.x + bl, y: frame.y + bt, width: gutterX > 0.5 ? s.clientWidth : frame.width - bl - px(cs.borderRightWidth), height: frame.height - bt - px(cs.borderBottomWidth) };
  for (let a = s.parentElement; a && scroller !== drawable; a = a.parentElement) {
    const acs = win.getComputedStyle(a);
    if (!plainEffects(acs) || (a !== drawable && acs.transform !== 'none')) return null;
    // a rounded clip of an ancestor over the port is not offset-invariant: the pages would carry it along
    if (acs.overflowX !== 'visible' && !square(acs)) {
      const ar = layer.frameRect(a);
      const o = ar && outerRadii(acs, ar.width, ar.height);
      if (!ar || !o) return null;
      const near = [[ar.x, ar.y, o.tl], [ar.x + ar.width - o.tr.x, ar.y, o.tr], [ar.x + ar.width - o.br.x, ar.y + ar.height - o.br.y, o.br], [ar.x, ar.y + ar.height - o.bl.y, o.bl]];
      for (const [x, y, r] of /** @type {Array<[number, number, {x: number, y: number}]>} */ (near)) {
        if (port.x < x + r.x && port.x + port.width > x && port.y < y + r.y && port.y + port.height > y) return null;
      }
    }
    if (a === drawable) break;
  }
  const round = square(cs) ? null : innerRadii(cs, frame.width, frame.height);
  const root = /** @type {Document|ShadowRoot} */ (s.getRootNode());
  const sel = doc.getSelection();
  // focus or a selection inside the scroller (a page would carry its caret or highlight along); read again between two steps
  const held = () => {
    const active = root.activeElement;
    return (!!active && s.contains(active) && active !== s) || (!!sel && !sel.isCollapsed && !!sel.rangeCount && sel.getRangeAt(0).intersectsNode(s));
  };
  if (held()) return null;
  // the scroller's own generated boxes scroll with its content
  if (gecko && !['::before', '::after', '::first-letter'].every((p) => clipInvariant(win.getComputedStyle(s, p)))) return null;
  const all = s.getElementsByTagName('*');
  if (all.length > MAX_SCAN) return null;
  const drawables = new Set(layer.drawableElements());
  const animated = new Set((doc.getAnimations?.() ?? []).map((a) => /** @type {KeyframeEffect|null} */ (a.effect)?.target).filter(Boolean));
  /** @type {Element[]} */
  const pinned = [];
  let otherZ = -Infinity;
  // a stacking context without a z-index outside the pinned elements: painted above a pinned element of z-index auto or 0 when it comes later in tree order
  let layered = false;
  /** flex and grid containers (the scroller among them), and boxes of display: contents (their children are items of the box around them) */
  /** @type {Set<Element>} */
  const boxes = new Set(/flex|grid/.test(cs.display) ? [s] : []), through = new Set();
  const count = all.length;
  const clock = win.performance ?? Date, now = () => clock.now();
  // between two steps: the subtree's size, the scroller's place in the viewport and the viewport's size are those the plan read, and nothing inside it took the focus
  // or a selection (a change of the content meanwhile is damage: scroll-compose.js plans again after one an installed plan would not survive, and checks the port of
  // the others for an obstruction; the pages are built from the DOM of their own time)
  const vr = s.getBoundingClientRect();
  const vw = win.innerWidth, vh = win.innerHeight;
  const still = () => {
    if (all.length !== count || !s.isConnected || win.innerWidth !== vw || win.innerHeight !== vh || held()) return false;
    const r = s.getBoundingClientRect();
    return r.left === vr.left && r.top === vr.top && r.width === vr.width && r.height === vr.height;
  };
  let t0 = now();
  for (let i = 0; i < count; i++) {
    if (i && (i % SCAN_STEP === 0 || (i % SCAN_CLOCK === 0 && now() - t0 > STEP_MS))) {
      yield;
      if (!still()) return null;
      t0 = now();
    }
    const el = all[i];
    if (drawables.has(el) || UNSAFE_TAGS.has(el.localName) || animated.has(el) || el.shadowRoot) return null;
    const ecs = win.getComputedStyle(el);
    if (gecko && (GECKO_UNVERIFIED.has(el.localName) || !clipInvariant(ecs) || !['::before', '::after', '::first-letter'].every((p) => clipInvariant(win.getComputedStyle(el, p))))) return null;
    const pos = ecs.position;
    if (/flex|grid/.test(ecs.display)) boxes.add(el);
    else if (ecs.display === 'contents') through.add(el);
    // inside a pinned element: drawn with it, from its tile (it has nothing outside its border box), so its stacking order does not matter
    const inPin = pinned.some((p) => p.contains(el));
    if (pos === 'static') {
      if (inPin) continue;
      // a z-index applies without a position to a flex or grid item (CSS Flexbox 4.3, Grid 9.4)
      let box = el.parentElement;
      while (box && through.has(box)) box = box.parentElement;
      if (ecs.zIndex !== 'auto' && box && boxes.has(box)) otherZ = Math.max(otherZ, Number(ecs.zIndex));
      else if (ownLayer(ecs)) layered = true;
      continue;
    }
    if (pos === 'fixed' || (pos === 'absolute' && cs.position === 'static')) return null;
    if (pos === 'sticky') {
      if (inPin || !pinnable(el, ecs)) { unpinnable.add(s); return null; }
      pinned.push(el);
      continue;
    }
    if (!inPin) otherZ = Math.max(otherZ, zOf(ecs));
  }
  // every pinned element paints above everything else of the scroller (a pinned element of z-index auto or 0 is painted under a later positioned box of z-index
  // auto / 0 or stacking context of its own: a header without a z-index over a row with opacity or position: relative)
  if (pinned.some((p) => { const z = zOf(win.getComputedStyle(p)); return z <= otherZ || (z === 0 && layered); })) { unpinnable.add(s); return null; }
  const portView = new DOMRect(vr.left + bl, vr.top + bt, s.clientWidth, s.clientHeight);
  if (!(yield* portUnobstructed(doc, s, portView, round, now, t0, still))) return null;
  /** @type {Element[]} the drawable's elements outside the scroller, its ancestors left out: read at admission (an element added later is a first
   * sighting, whole-drawable damage, which drops the plan) */
  const outside = outsideOf(doc, drawable, s);
  if (outside.length > MAX_SCAN || !(yield* unblended(win, s, portView, vr.width / frame.width || 1, outside, now, now(), still, paintsBackdrop(engine)))) return null;
  let bar = null;
  if (gutterX > 0.5) {
    // a classic bar is composed where the thumb's geometry is the one the clone paints and moves by whole surface pixels: Chromium's bars (chromiumVerticalBar /
    // verticalBar), WebKit's author-styled bars (webkitStyledBar) and its system bars (webkitSystemKnob). Not Gecko's
    if (engine !== 'chromium' && engine !== 'webkit') return null;
    const f = scrollFacts(s, cs);
    if (!f || !f.scrollableY) return null;
    let v;
    if (engine === 'webkit') {
      v = webkitBar(win, s, f);
      if (!v) return null;
    } else {
      const look = chromiumBarLook(win, s, cs, f.styled);
      v = look ? chromiumVerticalBar(look, f.gv, f.ch ?? s.clientHeight, s.clientHeight, s.scrollHeight)
        : verticalBar(f.gv, s.clientHeight, s.scrollHeight, f.styled, !f.styled && !!parseScrollbarColor(cs.scrollbarColor), f.styled ? styledMinThumb(win, s) : 0);
    }
    bar = { gutter: { x: port.x + (f.cw ?? s.clientWidth), y: port.y, width: f.gv, height: s.clientHeight }, ...v };
  }
  /** @type {Element[]|undefined} the scroller's elements outside its pinned elements: read at the first change inside its content, for a pin of z-index auto or 0 */
  let inside;
  const lowPin = pinned.some((p) => zOf(win.getComputedStyle(p)) === 0);
  return {
    port, frame, pinned, bar, maxTop: s.scrollHeight - s.clientHeight, scrollHeight: s.scrollHeight, client: { width: s.clientWidth, height: s.clientHeight }, round,
    ...(grid ? { grid, softCorners: true } : {}), ...(gecko ? { whole: true } : {}), opaque: (parseColor(cs.backgroundColor)?.[3] ?? 0) >= 1, cover: COVERS,
    pinnable: (el) => el.isConnected && pinnable(el, win.getComputedStyle(el)),
    clear: (rects) => clearOver(doc, layer, s, port, rects) && quietOutside(win, s, port, rects, layer, outside, paintsBackdrop(engine)),
    ...(lowPin ? { unlayered: (/** @type {Rect[]} */ rects) => unlayered(win, s, rects, layer, (inside ??= insideOf(s, pinned))) } : {}),
  };
}

/**
 * The vertical bar of a WebKit scroller the compositor can move, or null. On macOS only (iOS / iPadOS: refused):
 * - an author-styled bar (`::-webkit-scrollbar` with a width; webkitStyledBar, the geometry paintClassicScrollbars draws) whose thumb has a minimum the polyfill resolves
 *   and shows a thumb, and whose track is the whole bar (no buttons, no track margins: the clone paints neither);
 * - the system's bar (webkitSystemBar).
 * @param {Window} win @param {HTMLElement} s @param {import('./scroll-emulation.js').ScrollFacts} f
 * @returns {ReturnType<typeof webkitStyledBar>|null}
 */
function webkitBar(win, s, f) {
  if (currentEngine().os !== 'desktop') return null;
  if (!f.styled) return webkitSystemBar(win, s, f);
  const pseudo = (/** @type {string} */ p) => win.getComputedStyle(s, p);
  const button = pseudo('::-webkit-scrollbar-button');
  if (px(button.height) > 0 || px(button.width) > 0) return null;
  for (const part of [pseudo('::-webkit-scrollbar-track'), pseudo('::-webkit-scrollbar-track-piece')]) if (px(part.marginTop) !== 0 || px(part.marginBottom) !== 0) return null;
  const min = webkitStyledMinThumb(pseudo('::-webkit-scrollbar-thumb'));
  if (min === null) return null;
  const v = webkitStyledBar(f.gv, f.ch ?? s.clientHeight, s.clientHeight, s.scrollHeight, min);
  return v.thumbH > 0 ? v : null;
}

/**
 * WebKit's system classic bar (an unstyled scroller under "Show scroll bars: Always" or with a mouse attached) in the numbers of verticalBar, or null: the knob the
 * engines bundle paints (paintWebkitBars, a `data-hic-bar="thumb"` box) where AppKit puts it (webkitSystemKnob), 3 css px into the gutter and as thick as the lane.
 * Composed for the measured bars only: a regular (17 px) or thin (13 px) gutter and a knob that fits. Refused: a scrollbar-color (the clone draws another bar) and a
 * page without the engines bundle (the clone then draws the generic bar). The lane is the rounded client height less 6, as the painter takes it.
 * @param {Window} win @param {HTMLElement} s @param {import('./scroll-emulation.js').ScrollFacts} f
 * @returns {ReturnType<typeof webkitStyledBar>|null}
 */
function webkitSystemBar(win, s, f) {
  const min = WEBKIT_SYSTEM_MIN[f.gv];
  if (min === undefined || !engineSkins() || parseScrollbarColor(win.getComputedStyle(s).scrollbarColor)) return null;
  // the sizes of the plan (the plan is dropped when they change)
  const client = s.clientHeight, total = s.scrollHeight, lane = client - 2 * WEBKIT_SYSTEM_INSET;
  const at = (/** @type {number} */ top) => webkitSystemKnob(lane, client, total, top, min);
  const k = at(0);
  return k ? { thumbX: WEBKIT_SYSTEM_INSET, thumbW: f.gv - 2 * WEBKIT_SYSTEM_INSET, thumbH: k.length, thumbY: (top) => WEBKIT_SYSTEM_INSET + (at(top)?.start ?? 0) } : null;
}

/**
 * ScrollPlan.clear: at most this many elements outside the scroller are checked against a change inside the port (quietOutside), about 1.2 us each (headless Chrome
 * 156, a getBoundingClientRect apiece: 1.2 ms over 1,000 elements, 6.4 ms over 5,000, inside the frame of the step); with more, such a change drops the plan
 */
const MAX_OUTSIDE = 1000;
/** elements whose content box paints whatever their style says (replaced elements, form controls), or whose painting the computed style does not tell */
const PAINTERS = /^(img|picture|svg|math|video|canvas|iframe|embed|object|input|textarea|select|button|meter|progress|hr|frame|fieldset)$/;

/** @param {Document} doc @param {Element} drawable @param {Element} s @returns {Element[]} the elements of the drawable outside the scroller, its ancestors left out */
function outsideOf(doc, drawable, s) {
  /** @type {Element[]} */
  const out = [];
  if (s === drawable) return out;
  // 1: SHOW_ELEMENT; the scroller's subtree is skipped (FILTER_REJECT, 2)
  const w = doc.createTreeWalker(drawable, 1, { acceptNode: (n) => (n === s ? 2 : 1) });
  for (let n = /** @type {Element|null} */ (w.nextNode()); n; n = /** @type {Element|null} */ (w.nextNode())) if (!n.contains(s)) out.push(n);
  return out;
}

/** the scroller's descendants outside its pinned elements @param {HTMLElement} s @param {Element[]} pinned @returns {Element[]} */
const insideOf = (s, pinned) => [...s.getElementsByTagName('*')].filter((e) => !pinned.some((p) => p.contains(e)));

/**
 * ScrollPlan.unlayered, for a pinned element of z-index auto or 0, which CSS paints under a later box of its layer: no element of the scroller whose box meets a
 * change inside its content (frame css px, also outside the port: a row scrolls under the pin later) now has a stacking context of its own, a position or a
 * z-index (a row that gets opacity or a transform on :hover). A change of position or z-index alone damages the whole drawable and drops the plan anyway. Beyond
 * MAX_OUTSIDE elements a change is not checked one by one: not unlayered.
 * @param {Window} win @param {HTMLElement} s @param {Rect[]} rects @param {LiveLayer} layer @param {Element[]} inside @returns {boolean}
 */
function unlayered(win, s, rects, layer, inside) {
  const fr = layer.frameRect(s);
  if (!fr || !(fr.width > 0) || !(fr.height > 0) || inside.length > MAX_OUTSIDE) return false;
  const vr = s.getBoundingClientRect();
  const kx = vr.width / fr.width, ky = vr.height / fr.height;
  const vs = rects.map((r) => ({ x: vr.left + (r.x - fr.x) * kx, y: vr.top + (r.y - fr.y) * ky, width: r.width * kx, height: r.height * ky }));
  for (const e of inside) {
    if (!e.isConnected) continue;
    const b = e.getBoundingClientRect();
    if (!vs.some((r) => b.left < r.x + r.width && b.right > r.x && b.top < r.y + r.height && b.bottom > r.y)) continue;
    const ecs = win.getComputedStyle(e);
    if (ecs.position !== 'static' || ecs.zIndex !== 'auto' || ownLayer(ecs)) return false;
  }
  return true;
}

/** @typedef {(e: Element, p?: string) => CSSStyleDeclaration} StyleOf getComputedStyle within one check (outsideCheck) */

/** @param {StyleOf} style @param {Element} e @returns {string[]} its ::before and ::after that generate a box */
const generated = (style, e) => ['::before', '::after'].filter((p) => !/^(none|normal)$/.test(style(e, p).content));

/**
 * @param {CSSStyleDeclaration} cs @param {boolean} bd  the snapshot paints a backdrop-filter (paintsBackdrop)
 * @returns {boolean} composited with what lies under it: a blend mode other than normal, or a backdrop-filter the snapshot paints
 */
const blending = (cs, bd) => (cs.mixBlendMode ?? 'normal') !== 'normal' || (bd && (cs.backdropFilter ?? 'none') !== 'none');

/**
 * @param {string} engine @returns {boolean} the snapshot paints a backdrop-filter inside the drawable: Chromium 157 does (for an element that paints something, which
 *   the clone ensures); WebKit and Gecko paint none inside an SVG image (measured, iPadOS Safari 27.2 and Firefox 160, with and without the clone's layer), so
 *   there a backdrop-filter changes nothing the compositor reproduces; an engine not known counts it
 */
const paintsBackdrop = (engine) => engine !== 'webkit' && engine !== 'gecko';

/**
 * One check of the elements outside the scroller `s` (unblended, quietOutside): every computed style is read once in it, an element's own and its generated boxes',
 * and so are the answers of faded and blended for its ancestors. Nothing of it outlives the check: the next one reads the styles of its own time.
 * @param {Window} win @param {Element} s @param {boolean} bd  the snapshot paints a backdrop-filter (paintsBackdrop)
 */
function outsideCheck(win, s, bd) {
  /** @type {Map<Element, Record<string, CSSStyleDeclaration>>} */
  const styles = new Map();
  /** @type {StyleOf} */
  const style = (e, p = '') => { const m = styles.get(e) ?? {}; styles.set(e, m); return (m[p] ??= win.getComputedStyle(e, p || null)); };
  /** @type {Map<Element, boolean>} */
  const fade = new Map(), blend = new Map();
  /** `e` or one of its ancestors below the first one it shares with `s` has a blend mode other than normal @param {Element|null} e @returns {boolean} */
  const blended = (e) => !!e && !e.contains(s) && (blend.get(e) ?? (blend.set(e, blending(style(e), bd) || blended(e.parentElement)).get(e) ?? false));
  return { style, blended, bd, faded: (/** @type {Element} */ e) => faded(style, e, s, fade) };
}

/** @param {string} v a computed shadow list @returns {number} css px it may reach beyond the box: every length of it added up (offsets, blur and spread), twice */
const shadowReach = (v) => (v === 'none' ? 0 : 2 * (v.match(/-?[\d.]+px/g) ?? []).reduce((a, n) => a + Math.abs(parseFloat(n)), 0));

/**
 * @param {CSSStyleDeclaration} cs @returns {number} css px its shadows and outline reach beyond the box; a filter or a border image: anywhere. A backdrop-filter paints
 *   inside the border box only (Filter Effects 2: its result is clipped to it): painting counts it as the box's own paint
 */
const inkReach = (cs) => (cs.filter !== 'none' || (/** @type {any} */ (cs).borderImageSource ?? 'none') !== 'none' ? Infinity
  : Math.max(shadowReach(cs.boxShadow), shadowReach(cs.textShadow), cs.outlineStyle === 'none' ? 0 : px(cs.outlineWidth) + Math.max(0, px(cs.outlineOffset))));

/**
 * What `e` (outside the scroller) may paint: `self` inside its border box (its descendants are judged on their own; unknown: yes), and how far beyond it, css px per
 * side (`x`, `y`: ink, content that overflows a box that does not clip it, a generated box; one positioned out of the box: anywhere); `mix`: a generated box of it
 * has a blend mode other than normal. A backdrop-filter the snapshot paints (`bd`) is paint of its own box.
 * @param {StyleOf} style @param {Element} e @param {boolean} bd @returns {{self: boolean, x: number, y: number, mix: boolean}}
 */
function painting(style, e, bd) {
  const h = /** @type {HTMLElement} */ (e), cs = style(e);
  const shown = cs.visibility === 'visible';
  let self = !!e.shadowRoot || e.localName.includes('-') || e.namespaceURI !== 'http://www.w3.org/1999/xhtml' || (shown && (PAINTERS.test(e.localName)
    || (parseColor(cs.backgroundColor)?.[3] ?? 1) > 0 || cs.backgroundImage !== 'none' || (bd && (cs.backdropFilter ?? 'none') !== 'none') || cs.display === 'list-item'
    || px(cs.borderTopWidth) + px(cs.borderRightWidth) + px(cs.borderBottomWidth) + px(cs.borderLeftWidth) > 0 || [...e.childNodes].some((n) => n.nodeType === 3 && /\S/.test(/** @type {Text} */ (n).data))));
  let r = shown ? inkReach(cs) : cs.filter !== 'none' ? Infinity : 0, mix = false;
  for (const p of generated(style, e)) {
    const pc = style(e, p);
    self = true;
    mix ||= blending(pc, bd);
    r = Math.max(r, /^(absolute|fixed|sticky)$/.test(pc.position) ? Infinity : inkReach(pc));
  }
  // overflowing content is a child's (judged on its own) or text and generated boxes of this one (scrollWidth / scrollHeight reach right and down)
  return { mix, self, x: r + (cs.overflowX === 'visible' ? Math.max(0, h.scrollWidth - h.clientWidth) : 0), y: r + (cs.overflowY === 'visible' ? Math.max(0, h.scrollHeight - h.clientHeight) : 0) };
}

/**
 * `e` (outside the scroller `s`) paints nothing for an opacity of exactly 0 on it or on one of its ancestors below the first one it shares with the scroller: opacity
 * applies to the element and its whole subtree as one group (CSS Color 4 section 11.2; a descendant cannot undo it, as it can visibility), its generated boxes, shadows
 * and outline included. Any other opacity paints (0.02 of an opaque box shifts its pixels by 5 levels). A change of it back to a value above 0 is damage, checked
 * again here. Not faded by an opacity of 0: a box of display: contents (it generates no box; its children paint), and, under it, an element in the top layer (a
 * popover or modal dialog paints outside its ancestors). Memoised per check over the ancestors (`memo`).
 * @param {StyleOf} style @param {Element|null} e @param {Element} s @param {Map<Element, boolean>} memo @returns {boolean}
 */
function faded(style, e, s, memo) {
  if (!e || e.contains(s)) return false;
  let v = memo.get(e);
  if (v === undefined) {
    const cs = style(e);
    // a box of display: contents has no box for its opacity to apply to; an element in the top layer is not painted inside its ancestors
    memo.set(e, (v = (cs.display !== 'contents' && parseFloat(cs.opacity) === 0) || (!topLayer(e) && faded(style, e.parentElement, s, memo))));
  }
  return v;
}

/** @param {Element} e @returns {boolean} in the top layer (a modal dialog, an open popover, a fullscreen element; a selector the engine does not know: no) */
const topLayer = (e) => { try { return e.matches(':modal, :popover-open, :fullscreen'); } catch { return false; } };

/**
 * ScrollPlan.clear, beside the hit test: no element of the drawable outside the scroller (its ancestors aside) may paint over the damage inside the port. A hit test
 * sees only what is hit-testable at its points; a change there can also be a box with `pointer-events: none`, one between the points, or the shadow, outline,
 * overflowing text or generated box of an element beside the port (a damage rect holds the box of the element it comes from and the ink it paints). An element
 * whose box touches a damage rect is checked: whatever it paints inside its box where that box lies over the damaged part of the port, and its ink where that reaches
 * it; one of an effective opacity of 0 paints nothing (faded). One that blends (blended, ScrollPlan.cover) may not paint over any part of the port. Frame css px are
 * mapped to the viewport through the scroller's own box, as clearOver does.
 * @param {Window} win @param {HTMLElement} s @param {Rect} port @param {Rect[]} rects @param {LiveLayer} layer @param {Element[]} outside @param {boolean} bd paintsBackdrop
 * @returns {boolean}
 */
function quietOutside(win, s, port, rects, layer, outside, bd) {
  const fr = layer.frameRect(s);
  if (!fr || !(fr.width > 0) || !(fr.height > 0)) return false;
  const vr = s.getBoundingClientRect();
  const kx = vr.width / fr.width, ky = vr.height / fr.height;
  const view = (/** @type {Rect} */ r) => ({ x: vr.left + (r.x - fr.x) * kx, y: vr.top + (r.y - fr.y) * ky, width: r.width * kx, height: r.height * ky });
  const pv = view(port);
  const near = /** @type {Array<[Rect, Rect]>} */ (rects.map(view).map((r) => [r, intersectRect(r, pv)]).filter(([, p]) => p));
  if (!near.length) return true;
  if (outside.length > MAX_OUTSIDE) return false;
  const c = outsideCheck(win, s, bd);
  for (const e of outside) {
    if (!e.isConnected) continue;
    const b = e.getBoundingClientRect();
    if (!near.some(([r]) => meets(r, b, 0.5, 0.5))) continue;
    const g = paints(c, e);
    if (!g) continue;
    if ((g.mix || c.blended(e)) && over(g, b, pv, kx, ky)) return false;
    for (const [, p] of near) if (over(g, b, p, kx, ky)) return false;
  }
  return true;
}

/** a box (grown by gx, gy) meets a rect: edges that only touch do not count, a box of no size inside it does @param {Rect} a @param {DOMRect} b */
const meets = (a, b, gx = 0, gy = 0) => b.left - gx < a.x + a.width && b.right + gx > a.x && b.top - gy < a.y + a.height && b.bottom + gy > a.y;

/** what `g` paints (painting) of the box `b` reaches the rect `a` (viewport px; `kx`, `ky` css px to viewport px) @returns {boolean} */
const over = (/** @type {ReturnType<typeof painting>} */ g, /** @type {DOMRect} */ b, /** @type {Rect} */ a, /** @type {number} */ kx, /** @type {number} */ ky) =>
  (g.self && meets(a, b)) || (!!(g.x || g.y) && meets(a, b, g.x * kx, g.y * ky));

/**
 * What `e`, outside the scroller, paints (painting), or null for nothing: a box inside a display: none subtree (or of display: contents: no rect of its own, and no
 * generated box), or one of an effective opacity of 0 (faded).
 * @param {ReturnType<typeof outsideCheck>} c @param {Element} e
 */
const paints = (c, e) => ((!e.getClientRects().length && !generated(c.style, e).length) || c.faded(e) ? null : painting(c.style, e, c.bd));

/**
 * The admission side of ScrollPlan.cover: no element of the drawable outside the scroller (its ancestors aside) that blends with what lies under it paints over the
 * port. The cover check reads the port over one uniform colour at a time, and a blend can leave a uniform colour as it was and still change the content: an
 * overlay of rgb(1, 254, 3) with mix-blend-mode: saturation keeps both cover colours (their saturation is that of the overlay, 253) and changes every less
 * saturated row (15,878 of 104,000 pixels, up to 72 levels in the first composed step; Chrome 156 and iPad Safari 27.2). No set of colours tells that for every
 * blend mode, so an element painted over the port with a blend mode other than normal, on itself, on an ancestor below the first one it shares with the scroller or
 * on its ::before or ::after, refuses the plan. Nothing else outside is refused here (the covers see a normal overlay; one of opacity 0, of visibility: hidden or
 * with nothing to paint passes). A backdrop-filter refuses it as a blend does where the snapshot paints it (paintsBackdrop: Chrome 157, clone.js), as a blur leaves
 * a uniform colour as it was while it changes the content under it. In steps, as the scan.
 * @param {Window} win @param {Element} s @param {DOMRect} port viewport rect @param {number} k css px to viewport px @param {Element[]} outside
 * @param {() => number} now @param {number} t0 @param {() => boolean} still @param {boolean} bd paintsBackdrop
 * @returns {Generator<void, boolean, void>}
 */
function* unblended(win, s, port, k, outside, now, t0, still, bd) {
  const c = outsideCheck(win, s, bd);
  for (let i = 0; i < outside.length; i++) {
    if (i && i % SCAN_CLOCK === 0 && now() - t0 > STEP_MS) { yield; if (!still()) return false; t0 = now(); }
    const e = outside[i];
    if (!c.blended(e) && !generated(c.style, e).some((p) => blending(c.style(e, p), bd))) continue;
    const g = paints(c, e), b = e.getBoundingClientRect();
    if (g && over(g, b, port, k, k) && !clippedAway(c, e, g, b, s, k)) return false;
  }
  return true;
}

/** @param {CSSStyleDeclaration} cs @returns {boolean} drawn away from its laid-out box (a transform, a motion path) or through a filter */
const moves = (cs) => { const c = /** @type {any} */ (cs); return cs.transform !== 'none' || cs.filter !== 'none' || ['translate', 'rotate', 'scale', 'offsetPath'].some((p) => (c[p] ?? 'none') !== 'none'); };

/**
 * An element whose overflow clips what it contains to its padding box, and that box has no area, so nothing inside it paints wherever it lies or scrolls: an HTML
 * block, flex or grid container (no replaced element, form control or details) of overflow hidden or clip on both axes, no overflow-clip-margin, not drawn away.
 * @param {CSSStyleDeclaration} cs @param {Element} a @param {number} k css px to viewport px
 */
function emptyClip(cs, a, k) {
  if (!/^(hidden|clip)$/.test(cs.overflowX) || !/^(hidden|clip)$/.test(cs.overflowY) || !/^(block|inline-block|flow-root|flex|inline-flex|grid|inline-grid|list-item)$/.test(cs.display)
    || a.namespaceURI !== 'http://www.w3.org/1999/xhtml' || PAINTERS.test(a.localName) || a.localName === 'details' || moves(cs)
    || !/^((content|padding)-box )?0px$/.test((/** @type {any} */ (cs)).overflowClipMargin ?? '0px')) return null;
  const r = a.getBoundingClientRect();
  return r.width - (px(cs.borderLeftWidth) + px(cs.borderRightWidth)) * k < 1e-3 || r.height - (px(cs.borderTopWidth) + px(cs.borderBottomWidth)) * k < 1e-3 ? r : null;
}

/**
 * unblended: `e` (outside the scroller `s`, `g` what it paints, `b` its viewport rect) paints nothing because an ancestor below the first one it shares with `s` clips
 * it whole (emptyClip): a wrapper of no size with overflow: hidden keeps a blended overlay out of sight, and the cover check sees nothing of it. Proven only when
 * - `e` paints nothing beyond its border box (no ink, overflowing content or generated box out of it), which lies right of and below the clipper's corner: a later
 *   change of the clipper is damage over its reach, its box grown right and down to its scrollable overflow (damage-rect.js), so over `e`, and ScrollPlan.clear
 *   then refuses `e` wherever it shows (the clipper grows or turns overflow: visible);
 * - from `e` up to the clipper nothing escapes its clip: no element in the top layer, of position: fixed, drawn away (moves) or a shadow host's child (laid out in
 *   its shadow tree), and an absolute element's containing block (at most its nearest positioned ancestor) is the clipper or lies inside it.
 * Anything else (a clip-path, contain: paint, a clipper with area) is not proven: false.
 * @param {ReturnType<typeof outsideCheck>} c @param {Element} e @param {ReturnType<typeof painting>} g @param {DOMRect} b @param {Element} s @param {number} k
 */
function clippedAway(c, e, g, b, s, k) {
  if (g.x || g.y) return false;
  // an absolute element on the way whose containing block is not reached yet
  let open = false;
  for (let x = e; ;) {
    const cs = c.style(x);
    if (topLayer(x) || cs.position === 'fixed' || moves(cs)) return false;
    open ||= cs.position === 'absolute';
    const a = x.parentElement;
    if (!a || a.contains(s) || a.shadowRoot) return false;
    const as = c.style(a), positioned = as.position !== 'static' && as.display !== 'contents';
    const r = !open || positioned ? emptyClip(as, a, k) : null;
    if (r) return b.left >= r.left - 1e-3 && b.top >= r.top - 1e-3;
    if (positioned) open = false;
    x = a;
  }
}

/**
 * ScrollPlan.clear: a hit test on a small grid of each rect (inside the port): only the scroller or its descendants are hit. Frame css px are mapped to the viewport
 * through the scroller's own box (the layer may carry a transform).
 * @param {Document} doc @param {LiveLayer} layer @param {HTMLElement} s @param {Rect} port @param {Rect[]} rects @returns {boolean}
 */
function clearOver(doc, layer, s, port, rects) {
  const fr = layer.frameRect(s);
  if (!fr || !s.isConnected || !(fr.width > 0) || !(fr.height > 0)) return false;
  const vr = s.getBoundingClientRect();
  const kx = vr.width / fr.width, ky = vr.height / fr.height;
  const root = /** @type {Document|ShadowRoot} */ (s.getRootNode());
  const hit = typeof root.elementFromPoint === 'function' ? root : doc;
  for (const r of rects) {
    const x0 = Math.max(r.x, port.x) + 1, x1 = Math.min(r.x + r.width, port.x + port.width) - 1;
    const y0 = Math.max(r.y, port.y) + 1, y1 = Math.min(r.y + r.height, port.y + port.height) - 1;
    if (x1 < x0 || y1 < y0) continue;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const at = hit.elementFromPoint(vr.left + (x0 + ((x1 - x0) * i) / 2 - fr.x) * kx, vr.top + (y0 + ((y1 - y0) * j) / 2 - fr.y) * ky);
        if (!at || (at !== s && !s.contains(at))) return false;
      }
    }
  }
  return true;
}
