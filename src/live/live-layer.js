/**
 * Live layer of one canvas: mount/unmount, children relocation, presentation sync, queries (docs/ARCHITECTURE.md ADR-A).
 * Module: live (src/live/*).
 */

import { BUS, MARK } from '../contracts/events.js';
import { onCanvasSuspension } from '../util/suspension.js';
import { createA11yLink } from './a11y-link.js';
import { createAncestorClip } from './ancestor-clip.js';
import { collectDrawables, cssPath, nativeDom, nearestDrawableOf } from './drawables.js';
import { installEventBridge } from './event-bridge.js';
import { installCanvasSelection } from './canvas-selection.js';
import {
  appliedMatrixOf, appliedOffsetOf, applyGeometryToElement, applyHitTestOrder, clearGeometry, flushGeometryWrites, revalidateOffsets, revalidateScrolled, scrollMovedElements,
} from './geometry-apply.js';
import { borderBoxSize, frameMeasurerOf, frameRectOf, inkOverflowOf, isLaidOut, paintInkOf, rectInLayer } from './measure.js';
import { resetLayerStyle, syncPresentation } from './presentation.js';
import { sameContentRect } from '../util/rect.js';
import { auditStacking } from './stacking-audit.js';
import { installParentFacade, installTreeFacade } from './tree-facade.js';
import { createScrollSync } from './scroll-sync.js';

/** @typedef {import('../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../contracts/types.js').ChildrenChange} ChildrenChange */
/** @typedef {import('../contracts/types.js').ElementGeometry} ElementGeometry */
/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../contracts/types.js').LiveLayer} LiveLayer */
/** @typedef {import('../contracts/types.js').LayerStyleHandle} LayerStyleHandle */

const AUDIT_INTERVAL_MS = 500;
const OWN_ATTRS = new Set([MARK.CANVAS_ATTR, 'aria-owns']);

/**
 * Reparenting blurs the focused element of the moved subtree; this remembers it and returns the function that focuses it again.
 * Scroll offsets cannot be kept: once the children are back in the canvas they are fallback content without a layout box, where scrollTop reads and writes 0.
 * @param {HTMLElement} layerEl
 * @param {Document|ShadowRoot} root
 * @returns {() => void}
 */
function rememberFocus(layerEl, root) {
  const focused = root.activeElement && layerEl.contains(root.activeElement) ? /** @type {HTMLElement} */ (root.activeElement) : null;
  return () => {
    if (focused?.isConnected && root.activeElement !== focused) focused.focus({ preventScroll: true });
  };
}

/**
 * A listbox select (size > 1 or multiple) laid out while the page loads shows its selected option: every engine scrolls it into view once the select has a box
 * (measured Chrome 155 desktop and Chromium 158 Android: scrollTop 34 for the 5th of 6 options in a size-3 list). Children of a canvas are fallback content without a
 * box while the page parses, so a select moved into the layer kept scrollTop 0 and showed its first options (G-mobile controls on Android). Once mounted, each such
 * select whose first selected option lies outside its scrollport is scrolled the nearest way, as the engine does.
 * @param {HTMLElement} layerEl
 */
function revealSelectedOptions(layerEl) {
  if (!layerEl.isConnected) return;
  for (const sel of /** @type {NodeListOf<HTMLSelectElement>} */ (layerEl.querySelectorAll('select'))) {
    if (!(sel.multiple || sel.size > 1) || sel.selectedIndex < 0 || sel.scrollTop !== 0 || sel.scrollHeight <= sel.clientHeight) continue;
    const r = sel.getBoundingClientRect();
    const o = sel.options[sel.selectedIndex].getBoundingClientRect();
    const k = r.height > 0 ? sel.offsetHeight / r.height : 1; // the layer may be scaled (transform mode)
    const bottom = (o.bottom - r.top) * k - sel.clientTop;
    if (bottom > sel.clientHeight) sel.scrollTop = bottom - sel.clientHeight;
  }
}

/**
 * Factory for the LiveLayer typedef. mount() is idempotent and SYNCHRONOUS (also callable from the content setter / setAttribute patch and from registry.ensure(canvas), so a getBoundingClientRect() right after `canvas.content='drawable'` already sees laid-out children):
 * create the <hic-layer>, relocate logical children in order, insert after the canvas, set data-hic-canvas, install facade (+ parent facade), event bridge, a11y link (aria-owns, ADR-M), ancestor clip (ADR-L), syncPresentation; the style handle comes from env.roots.style(record.root).
 * unmount() is the exact inverse (children back in original order, aria-owns and generated ids restored). While mounted, calling mount() again re-homes the layer: it follows a canvas that was moved (new parent / tree scope) or removes the layer while the canvas is disconnected.
 * @param {HicEnv} env
 * @param {CanvasRecord} record
 * @returns {LiveLayer}
 */
export function createLiveLayer(env, record) {
  const canvas = record.canvas;
  const nat = nativeDom();
  const layerEl = /** @type {HTMLElement} */ (canvas.ownerDocument.createElement(MARK.LAYER_TAG));
  layerEl.setAttribute(MARK.LAYER_ATTR, String(record.id));
  layerEl.setAttribute(MARK.NODE_ATTR, '');
  layerEl.setAttribute('role', 'presentation');

  let mounted = false;
  let disposed = false;
  /** @type {LayerStyleHandle|null} */
  let style = null;
  /** @type {Document|ShadowRoot|null} */
  let styleRoot = null;
  /** @type {ReturnType<typeof installTreeFacade>|null} */
  let facade = null;
  /** @type {ReturnType<typeof createA11yLink>|null} */
  let a11y = null;
  /** @type {ReturnType<typeof createAncestorClip>|null} */
  let clip = null;
  /** @type {Array<() => void>} */
  let teardown = [];
  /** @type {(() => void)|null} */
  let parentFacadeRemover = null;
  /** @type {Node|null} */
  let parentFacadeFor = null;
  /** @type {Element[]} */
  let drawables = [];
  let drawableSet = /** @type {Set<Element>} */ (new Set());
  /** @type {Map<Element, {geometry: ElementGeometry, offset: {x: number, y: number}|null}>} */
  const desired = new Map();
  let drawnSet = /** @type {Set<Element>} */ (new Set());
  /** @type {Set<(c: ChildrenChange) => void>} */
  const childListeners = new Set();
  let lastAudit = -Infinity;
  let auditedDrawn = 0;
  /** @type {import('../contracts/types.js').StackingFinding[]} */
  let lastFindings = [];
  const reportedCovers = new WeakSet();

  const rules = () => /** @type {LayerStyleHandle} */ (style).geometry;
  /** @type {ReturnType<typeof createScrollSync>|null} */
  let scrollSync = null;

  /** @type {(() => void)|null} removes the scroll listener of syncScrollWatch */
  let scrollWatch = null;
  /**
   * A sticky or fixed drawable with applied geometry moves inside the layer when the page (or a scroller around the canvas) scrolls, and nothing else announces it: while
   * one exists, a passive capture `scroll` listener on the window re-measures those drawables in the scroll event of each frame, so the hit test follows the drawn position.
   * No listener at all otherwise (the design keeps page scroll free of polyfill work), and the listener ignores scrolling inside the layer (the scroll observer's).
   */
  function syncScrollWatch() {
    const want = mounted && !!style && scrollMovedElements(layerEl).length > 0;
    if (want === !!scrollWatch) return;
    if (!want) { scrollWatch?.(); scrollWatch = null; return; }
    const win = env.window;
    const onScroll = (/** @type {Event} */ ev) => {
      const target = /** @type {any} */ (ev.target);
      if (!mounted || !style || typeof target?.contains !== 'function' || !target.contains(layerEl)) return;
      try { revalidateScrolled(env, rules(), layerEl); } catch (err) { env.reporter.caught(err, 'live.page-scroll'); }
    };
    win.addEventListener('scroll', onScroll, { capture: true, passive: true });
    scrollWatch = () => win.removeEventListener('scroll', onScroll, { capture: true });
  }
  const logical = () => (facade ? facade.logicalChildNodes() : [...nat.childNodes.call(canvas)]);

  function place() {
    const parent = nat.parentNode.call(canvas);
    if (!parent) {
      if (layerEl.isConnected) layerEl.remove();
      return;
    }
    const next = nat.nextSibling.call(canvas);
    if (next !== layerEl) parent.insertBefore(layerEl, next);
  }

  function presentation() {
    const box = syncPresentation(env, record, layerEl);
    clip?.update();
    return box;
  }

  function topLevelElements() {
    return /** @type {Element[]} */ (logical().filter((n) => n.nodeType === 1));
  }

  /** @param {boolean} emit */
  function refreshDrawables(emit) {
    const next = collectDrawables(logical(), record.legacy);
    const nextSet = new Set(next);
    const added = next.filter((el) => !drawableSet.has(el));
    const removed = drawables.filter((el) => !nextSet.has(el));
    const reordered = added.length === 0 && removed.length === 0 && next.some((el, i) => el !== drawables[i]);
    drawables = next;
    drawableSet = nextSet;
    for (const el of removed) {
      desired.delete(el);
      drawnSet.delete(el);
      if (style) applyGeometryToElement(env, rules(), layerEl, el, null, false, null);
    }
    if (emit && (added.length || removed.length || reordered)) env.bus.emit(BUS.DRAWABLES_CHANGED, { record, added, removed });
  }

  function watchCanvas() {
    const RO = /** @type {any} */ (env.window).ResizeObserver;
    // the observation an observe() always delivers, and any other that reports the box this layer already measured, has nothing to sync (mount just did)
    const resize = new RO((/** @type {ResizeObserverEntry[]} */ entries) => { if (!sameContentRect(entries, record.contentBox)) syncPresentation(env, record, layerEl); });
    resize.observe(canvas);
    const attrs = new MutationObserver((records) => {
      if (records.some((r) => !OWN_ATTRS.has(/** @type {string} */ (r.attributeName)))) presentation();
    });
    attrs.observe(canvas, { attributes: true });
    const onFocus = (/** @type {Event} */ ev) => { if (ev.target instanceof Element) clip?.reveal(ev.target); };
    layerEl.addEventListener('focusin', onFocus);
    const offSuspension = onCanvasSuspension(env, record, () => resize.disconnect(), () => resize.observe(canvas));
    return () => {
      offSuspension();
      resize.disconnect();
      attrs.disconnect();
      layerEl.removeEventListener('focusin', onFocus);
    };
  }

  function mount() {
    if (disposed) return;
    if (mounted) { rehome(); return; }
    mounted = true;
    styleRoot = record.root;
    style = env.roots.style(styleRoot);
    style.add(record.id);
    canvas.setAttribute(MARK.CANVAS_ATTR, String(record.id));
    place();
    for (const n of [...nat.childNodes.call(canvas)]) layerEl.appendChild(n);
    facade = installTreeFacade(env, record, layerEl);
    installParentFacadeIfWanted();
    teardown = [installEventBridge(canvas, layerEl), installCanvasSelection(canvas, layerEl)];
    a11y = createA11yLink(record, layerEl);
    facade.hooks.authorOwns = () => a11y?.authorValue() ?? null;
    clip = createAncestorClip(env, record, layerEl);
    const offChildren = facade.onChildrenChanged((change) => {
      a11y?.update(topLevelElements());
      for (const cb of [...childListeners]) cb(change);
    });
    const offTree = facade.onTreeChanged(() => refreshDrawables(true));
    // slotted drawables (drawables.js collectDrawables) come and go with the assignment of the layer's slots
    const onSlotChange = () => refreshDrawables(true);
    layerEl.addEventListener('slotchange', onSlotChange);
    teardown.push(offChildren, offTree, () => layerEl.removeEventListener('slotchange', onSlotChange));
    presentation();
    a11y.update(topLevelElements());
    refreshDrawables(true);
    teardown.push(watchCanvas());
    scrollSync = createScrollSync(styleRoot, () => style?.scroll ?? null);
    revealSelectedOptions(layerEl);
  }

  function installParentFacadeIfWanted() {
    parentFacadeRemover?.();
    parentFacadeRemover = null;
    parentFacadeFor = nat.parentNode.call(canvas);
    if (env.options.parentFacade && parentFacadeFor) parentFacadeRemover = installParentFacade(env, record, layerEl);
  }

  function rehome() {
    if (styleRoot !== record.root && style) {
      scrollSync?.clear();
      scrollSync = createScrollSync(record.root, () => style?.scroll ?? null);
      const old = style;
      clearGeometry(old.geometry, layerEl);
      old.remove(record.id);
      old.dispose();
      styleRoot = record.root;
      style = env.roots.style(styleRoot);
      style.add(record.id);
      for (const [el, d] of desired) applyGeometryToElement(env, rules(), layerEl, el, d.geometry, drawnSet.has(el), d.offset);
    }
    place();
    if (parentFacadeFor !== nat.parentNode.call(canvas)) installParentFacadeIfWanted();
    presentation();
  }

  function unmount() {
    if (!mounted) return;
    mounted = false;
    scrollWatch?.();
    scrollWatch = null;
    scrollSync?.clear();
    scrollSync = null;
    for (const off of teardown.reverse()) off();
    teardown = [];
    if (style) clearGeometry(rules(), layerEl);
    clip?.dispose();
    a11y?.dispose();
    parentFacadeRemover?.();
    parentFacadeRemover = null;
    parentFacadeFor = null;
    facade?.uninstall();
    const restoreFocus = rememberFocus(layerEl, record.root);
    for (const n of [...nat.childNodes.call(layerEl)]) canvas.appendChild(n);
    layerEl.remove();
    canvas.removeAttribute(MARK.CANVAS_ATTR);
    resetLayerStyle(layerEl);
    restoreFocus();
    style?.remove(record.id);
    style?.dispose();
    style = null;
    styleRoot = null;
    facade = null;
    a11y = null;
    clip = null;
    drawables = [];
    drawableSet = new Set();
    drawnSet = new Set();
    desired.clear();
  }

  /** @type {LiveLayer} */
  const api = {
    element: layerEl,
    mount,
    unmount,
    isMounted: () => mounted,
    syncPresentation: presentation,
    logicalChildNodes: logical,
    drawableElements() {
      facade?.flush();
      return drawables.slice();
    },
    nearestDrawable(node) {
      facade?.flush();
      return nearestDrawableOf(node, layerEl, drawableSet);
    },
    isLaidOut: (el) => isLaidOut(el),
    borderBoxSize: (el) => borderBoxSize(el, appliedMatrixOf(el, layerEl)),
    borderBoxRectInLayer(el) {
      const size = borderBoxSize(el, appliedMatrixOf(el, layerEl));
      if (!size) return null;
      const cached = appliedOffsetOf(el);
      const at = cached ?? rectInLayer(layerEl, el);
      return at && { x: at.x, y: at.y, width: size.width, height: size.height };
    },
    inkOverflow: (el) => inkOverflowOf(el, appliedMatrixOf(el, layerEl) === null),
    paintInk: (el) => paintInkOf(el),
    frameRect(el) {
      const drawable = nearestDrawableOf(el, layerEl, drawableSet);
      return drawable ? frameRectOf(drawable, el, appliedMatrixOf(drawable, layerEl)) : null;
    },
    frameMeasurer(drawable) {
      /** @type {((el: Element, sized?: boolean) => import('../contracts/types.js').Rect|null)|null} */
      let measure = null; // the drawable is measured at the first question: a build that prunes nothing asks none
      return (el, sized) => (nearestDrawableOf(el, layerEl, drawableSet) === drawable ? (measure ??= frameMeasurerOf(drawable, appliedMatrixOf(drawable, layerEl)))(el, sized) : api.frameRect(el));
    },
    applyGeometry(el, geometry, layoutOffset) {
      if (!mounted || !style) return;
      if (geometry) desired.set(el, { geometry, offset: layoutOffset ?? null }); else desired.delete(el);
      applyGeometryToElement(env, rules(), layerEl, el, geometry, drawnSet.has(el), layoutOffset ?? null);
      // Synchronous: getBoundingClientRect() / elementsFromPoint() right after updateElementGeometry() or drawElementImage() must already see the canvas transform (WPT canvas-transform-*).
      flushGeometryWrites();
      syncScrollWatch();
    },
    stackingAudit() {
      if (!mounted || env.options.stackingAudit === 'off' || !drawnSet.size) return [];
      const now = env.now();
      // An element drawn for the first time is audited at once: the interval is only there to bound the cost of a busy canvas.
      const fresh = drawnSet.size > auditedDrawn;
      if (!fresh && now - lastAudit < AUDIT_INTERVAL_MS) return lastFindings;
      lastAudit = now;
      auditedDrawn = drawnSet.size;
      lastFindings = auditStacking(record, layerEl, [...drawnSet].filter((el) => el.isConnected));
      for (const f of lastFindings) {
        if (reportedCovers.has(f.covered)) continue;
        reportedCovers.add(f.covered);
        env.reporter.unsupported({
          feature: 'stacking-overlap',
          message: f.covered === canvas ? 'the canvas is not hit-testable where its layer content is (a clipping ancestor hides it)' : 'page content paints above the canvas but below its live layer',
          hint: 'give the canvas a positioned stacking context (position:relative; z-index:0)',
          path: cssPath(f.covered),
        }, canvas);
      }
      return lastFindings;
    },
    revalidateGeometry() {
      if (!mounted || !style) return;
      revalidateOffsets(env, rules(), layerEl);
      syncScrollWatch();
    },
    setHitTestOrder(order) {
      if (!mounted || !style) return;
      drawnSet = new Set(order);
      for (const [el, d] of desired) applyGeometryToElement(env, rules(), layerEl, el, d.geometry, drawnSet.has(el), d.offset);
      applyHitTestOrder(rules(), layerEl, order);
      flushGeometryWrites();
      syncScrollWatch();
    },
    onChildrenChanged(cb) {
      childListeners.add(cb);
      return () => { childListeners.delete(cb); };
    },
    syncScroll(el, on) {
      if (on) scrollSync?.mark(el); else scrollSync?.unmark(el);
    },
    scrollAuthorStyle: (el) => scrollSync?.author(el) ?? null,
    elementAtPoint(point) {
      for (const el of record.root.elementsFromPoint(point.x, point.y)) if (el !== layerEl && layerEl.contains(el)) return el;
      return null;
    },
    dispose() {
      unmount();
      disposed = true;
      childListeners.clear();
    },
  };
  return api;
}
