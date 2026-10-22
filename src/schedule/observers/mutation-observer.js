/**
 * MutationObserver on the layer subtree -> damage + DRAWABLES_CHANGED.
 * Module: schedule (src/schedule/observers/*).
 */

import { BUS, MARK } from '../../contracts/events.js';
import { createDamageBatch, getRectMemory } from './damage-rect.js';

/** @typedef {import('../../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../../contracts/types.js').DamageCause} DamageCause */
/** @typedef {import('../../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../../contracts/types.js').LiveLayer} LiveLayer */

/** Attributes the polyfill itself writes on author nodes. */
const OWN_ATTRIBUTE = /^(data-hic-|aria-owns$)/;
/** Attributes that decide which elements are drawables. */
const DRAWABLE_ATTRIBUTES = new Set(['drawable', 'layoutsubtree']);

/**
 * Map each mutation to its nearest drawable via record.layer.nearestDrawable and a frame rect via layer.frameRect; structural changes -> whole drawable; ignore polyfill nodes/attributes (env.isManagedLayerNode, MARK).
 * A mutation that can move a drawable inside the layer (movesDrawables) also asks the layer to re-measure its geometry offsets, once per batch (LiveLayer.revalidateGeometry). childList is structural (rect null: the store widens it and bumps the epoch). Attribute and text changes use the rect memory: the union of the element's old and new reach while its box keeps its size, otherwise
 * the whole drawable, because siblings may have moved. A mutation outside every drawable paints nothing and is ignored, except that the drawable set is recomputed and BUS.DRAWABLES_CHANGED is emitted when it differs.
 * @param {HicEnv} env
 * @param {CanvasRecord} record
 * @returns {() => void}
 */
export function observeMutations(env, record) {
  const found = record.layer;
  if (!found) return () => {};
  const layer = found;
  const root = layer.element;
  const memory = getRectMemory(env);
  let known = new Set(layer.drawableElements());

  /** @param {Node} node */
  function isManaged(node) {
    const el = node.nodeType === 1 ? /** @type {Element} */ (node) : node.parentElement;
    return !!el && (env.isManagedLayerNode(el) || !!el.closest(`[${MARK.NODE_ATTR}]`));
  }

  /** @param {MutationRecord} m */
  function isOwnWrite(m) {
    if (m.type === 'attributes') {
      const name = m.attributeName ?? '';
      if (m.target === root || OWN_ATTRIBUTE.test(name)) return true;
      return name === 'id' && ((m.oldValue ?? '').startsWith(MARK.OWNS_ID_PREFIX) || /** @type {Element} */ (m.target).id.startsWith(MARK.OWNS_ID_PREFIX));
    }
    if (m.type === 'childList') {
      const moved = [...m.addedNodes, ...m.removedNodes];
      return moved.length > 0 && moved.every(isManaged);
    }
    return isManaged(m.target);
  }

  /** @param {Set<Element>} next */
  function announceDrawables(next) {
    const added = [...next].filter((el) => !known.has(el));
    const removed = [...known].filter((el) => !next.has(el));
    known = next;
    if (added.length || removed.length) env.bus.emit(BUS.DRAWABLES_CHANGED, { record, added, removed });
  }

  /** @param {MutationRecord[]} batch */
  function onMutations(batch) {
    const damage = createDamageBatch();
    /** @type {Set<Element>} */
    const attrOwners = new Set();
    let structural = false;
    let moved = false;
    for (const m of batch) {
      if (isOwnWrite(m)) continue;
      const target = m.target.nodeType === 1 ? /** @type {Element} */ (m.target) : m.target.parentElement ?? /** @type {ShadowRoot} */ (m.target).host ?? null;
      if (!target) continue;
      const element = lightHost(target);
      if (element !== target) {
        // Inside a shadow tree of a drawable: the clone flattens it (capture/clone.js), the whole drawable is repainted; new shadow roots below are observed too.
        const drawable = layer.nearestDrawable(element);
        if (drawable) damage.add(drawable, null);
        if (m.type === 'childList') observeShadows(/** @type {ParentNode} */ (/** @type {unknown} */ (m.target)));
        continue;
      }
      const drawable = layer.nearestDrawable(element);
      if (drawable === element && m.type === 'attributes' && m.attributeName === 'style' && onlyZIndex(m.oldValue, element.getAttribute('style'))) continue;
      moved ||= movesDrawables(m, element, drawable);
      if (m.type === 'childList' && textOnly(m)) {
        // text replaced in place (textContent / innerText / a text node added or removed): local like characterData, bounded by damage-rect.js
        if (drawable) attrOwners.add(element);
      } else if (m.type === 'childList') {
        structural = true;
        if (drawable) damage.add(drawable, null);
      } else if (m.type === 'attributes' && DRAWABLE_ATTRIBUTES.has(m.attributeName ?? '')) {
        structural = true;
        const ancestor = layer.nearestDrawable(element.parentNode ?? element);
        if (ancestor) damage.add(ancestor, null);
      } else if (drawable) attrOwners.add(element);
    }
    if (structural) { announceDrawables(new Set(layer.drawableElements())); observeShadows(root); watchFrames(); }
    for (const element of attrOwners) {
      const drawable = layer.nearestDrawable(element);
      if (drawable) damage.add(drawable, memory.reach(layer, element));
    }
    damage.flush((drawable, rect) => env.scheduler.damage(record, 'mutation', drawable, rect));
    if (moved) layer.revalidateGeometry();
  }

  /** @type {CSSStyleDeclaration|null} */
  let scratchA = null;
  /** @type {CSSStyleDeclaration|null} */
  let scratchB = null;
  /**
   * The inline style of a drawable changed only its z-index. A drawable is always its own stacking context (isolation:isolate in the layer sheet), so its z-index changes
   * nothing in its picture: no damage and no paint event (WPT onpaint-zindex). Its hit-test order is the drawing order, applied at every paint.
   * @param {string|null} before @param {string|null} after @returns {boolean}
   */
  function onlyZIndex(before, after) {
    if (before === after) return false;
    scratchA ??= env.document.createElement('div').style;
    scratchB ??= env.document.createElement('div').style;
    scratchA.cssText = before ?? '';
    scratchB.cssText = after ?? '';
    if (scratchA.getPropertyValue('z-index') === scratchB.getPropertyValue('z-index')) return false;
    for (const [x, y] of [[scratchA, scratchB], [scratchB, scratchA]]) {
      for (let i = 0; i < x.length; i++) {
        const prop = x[i];
        if (prop !== 'z-index' && (x.getPropertyValue(prop) !== y.getPropertyValue(prop) || x.getPropertyPriority(prop) !== y.getPropertyPriority(prop))) return false;
      }
    }
    return true;
  }

  /** @param {MutationRecord} m @returns {boolean} only text nodes were added or removed (no element can appear, vanish or carry a drawable) */
  function textOnly(m) {
    for (const n of m.addedNodes) if (n.nodeType !== 3) return false;
    for (const n of m.removedNodes) if (n.nodeType !== 3) return false;
    return m.addedNodes.length + m.removedNodes.length > 0;
  }

  /**
   * Can this mutation have moved a drawable inside the layer (its layout offset, which the hit-test correction is built from)? Something outside every drawable (a sibling above it), the drawable restyling
   * itself, or a structural change inside one of several drawables. Text and style changes inside a drawable do not: typing never pays for a re-measure.
   * @param {MutationRecord} m @param {Element} element @param {Element|null} drawable
   */
  function movesDrawables(m, element, drawable) {
    if (!drawable) return true;
    if (m.type === 'attributes') return element === drawable;
    return m.type === 'childList' && layer.drawableElements().length > 1;
  }

  const scope = root.getRootNode();
  /** @param {Element} el @returns {Element} the element itself, or the light-tree shadow host it is rendered in (shadow trees INSIDE drawables, not the canvas's own scope) */
  function lightHost(el) {
    let cur = el;
    for (let r = cur.getRootNode(); r !== scope && /** @type {ShadowRoot} */ (r).host; r = cur.getRootNode()) cur = /** @type {ShadowRoot} */ (r).host;
    return cur;
  }

  const OPTIONS = { childList: true, attributes: true, attributeOldValue: true, characterData: true, subtree: true };
  /** @type {WeakSet<ShadowRoot>} */
  const shadows = new WeakSet();
  /** A MutationObserver does not cross shadow boundaries: every open shadow root under `from` (nested ones included) is observed once. @param {ParentNode} from */
  function observeShadows(from) {
    for (const el of Array.from(from.querySelectorAll('*'))) {
      const sr = el.shadowRoot;
      if (!sr || shadows.has(sr)) continue;
      shadows.add(sr);
      mo.observe(sr, OPTIONS);
      observeShadows(sr);
    }
  }

  /**
   * Same-origin frame documents inside the layer: the snapshot draws them (capture/frame-doc.js), so a change in one, or a (re)load, repaints the drawable that contains the frame
   * (WPT onpaint-iframe). A MutationObserver does not cross into a child document: each readable one is observed, and re-observed when the frame loads another document.
   * @type {Map<Element, {doc: Document, mo: MutationObserver}>}
   */
  const frames = new Map();
  /** @param {Element} frame */
  const frameChanged = (frame) => {
    const drawable = layer.nearestDrawable(frame);
    if (drawable) env.scheduler.damage(record, 'mutation', drawable, null);
  };
  function watchFrames() {
    for (const [frame, known] of frames) if (!root.contains(frame)) { known.mo.disconnect(); frames.delete(frame); }
    for (const frame of Array.from(root.querySelectorAll('iframe, frame, object'))) {
      /** @type {Document|null} */
      let doc = null;
      try { doc = /** @type {HTMLIFrameElement} */ (frame).contentDocument; } catch { /* cross-origin */ }
      const known = frames.get(frame);
      if (known?.doc === doc) continue;
      known?.mo.disconnect();
      frames.delete(frame);
      if (!doc) continue;
      const frameMo = new /** @type {Window & typeof globalThis} */ (env.window).MutationObserver(() => frameChanged(frame));
      frameMo.observe(doc, OPTIONS);
      frames.set(frame, { doc, mo: frameMo });
    }
  }
  /**
   * A frame that loads (another) document, and an image that finishes loading: an <img> whose source is chosen after the snapshot was taken (a <picture> source,
   * srcset, lazy loading) had no URL to fetch then and nothing else announces it (WPT privacy/picture-images-ignored drew the snapshot from before the load).
   * @param {Event} e
   */
  const onLoad = (e) => {
    const t = /** @type {Element} */ (e.target);
    if (t.nodeType !== 1) return;
    if (t.localName === 'img') { frameChanged(t); return; }
    if (!/^(iframe|frame|object)$/.test(t.localName)) return;
    watchFrames();
    frameChanged(t);
  };

  const mo = new /** @type {Window & typeof globalThis} */ (env.window).MutationObserver(onMutations);
  mo.observe(root, OPTIONS);
  observeShadows(root);
  watchFrames();
  root.addEventListener('load', onLoad, true);
  const stopAncestors = watchAncestors(env, record);
  return () => {
    mo.disconnect();
    stopAncestors();
    root.removeEventListener('load', onLoad, true);
    for (const known of frames.values()) known.mo.disconnect();
    frames.clear();
  };
}

/** @param {Element} canvas @returns {Element[]} the elements above the canvas, nearest first, through shadow hosts up to <html> */
function ancestorsOf(canvas) {
  /** @type {Element[]} */
  const chain = [];
  for (let el = canvas.parentElement ?? /** @type {ShadowRoot} */ (canvas.getRootNode()).host ?? null; el; el = el.parentElement ?? /** @type {ShadowRoot} */ (el.getRootNode()).host ?? null) chain.push(el);
  return chain;
}

/**
 * The clone carries attribute-only shells of the canvas's ancestors and the custom properties computed above it, so a class / data-theme / lang / style change on an ancestor (a theme toggle on <html>, a wrapper's
 * `--accent`) changes every tile of the canvas. One MutationObserver per canvas watches ONLY the attributes of the few ancestor elements (not their subtrees: idle cost is zero); a change damages the whole canvas.
 * The chain is re-read when the canvas is (re)activated (a moved canvas resumes with forced damage), so a canvas that was moved to another parent is followed at once.
 * @param {HicEnv} env
 * @param {CanvasRecord} record
 * @returns {() => void}
 */
function watchAncestors(env, record) {
  /** @type {Element[]} */
  let watched = [];
  const mo = new /** @type {Window & typeof globalThis} */ (env.window).MutationObserver((batch) => {
    if (batch.some((m) => !OWN_ATTRIBUTE.test(m.attributeName ?? '') && !env.isManagedLayerNode(/** @type {Element} */ (m.target)))) env.scheduler.damage(record, 'mutation', null, null);
  });
  function sync() {
    const next = ancestorsOf(record.canvas);
    if (next.length === watched.length && next.every((el, i) => el === watched[i])) return;
    mo.disconnect();
    watched = next;
    for (const el of next) mo.observe(el, { attributes: true });
    if (record.state === 'active') env.scheduler.damage(record, 'mutation', null, null);
  }
  const first = ancestorsOf(record.canvas);
  watched = first;
  for (const el of first) mo.observe(el, { attributes: true });
  const offForced = env.bus.on(BUS.DAMAGE, (/** @type {{record: CanvasRecord, cause: string}} */ e) => { if (e.record === record && e.cause === 'forced') sync(); });
  return () => { offForced(); mo.disconnect(); watched = []; };
}
