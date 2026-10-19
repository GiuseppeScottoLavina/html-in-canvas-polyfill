/**
 * Scroll synchronisation of the live scrollers (Chromium, docs/ARCHITECTURE.md ADR-E "Scroll").
 *
 * During a precise scroll (trackpad, a wheel without smooth scrolling) of a composited scroller, Chromium's compositor lets impl latency take priority: it draws the
 * scroll at once without waiting for the main frame, and it does not send the next main frame while a committed one waits to be drawn. Content painted by the main
 * thread that follows the scroll offset, as the canvas does, then gets a new offset in every second frame only (measured on Chrome 155 and Canary 158 at 120 Hz: 61
 * scroller updates per second with a canvas drawn per update, 116 without; the same 61 for a plain page that changes any style per scroll event). A scroller with a
 * main-thread repaint reason makes the compositor wait for the main frame instead (tree priority "new content"), which is what the scrollers inside a native drawable
 * get: 116 updates per second. While a live scroller inside a drawable scrolls it carries MARK.SCROLL_ATTR, and a rule of the polyfill sheet gives it such a reason
 * (background-needs-repaint-on-scroll): a transparent inset box-shadow, which keeps the background in the border-box space, and a transparent local-attachment image.
 * Both paint nothing, the layer is invisible, and neither the attribute nor the polyfill sheet reaches a snapshot. The author's own values are kept in the rule.
 * SIDE EFFECTS kept out of the author's sight: the bottom layer keeps the author's background-clip (it clips the background colour); an author transition that covers
 * box-shadow is held for box-shadow alone while the rule applies (else the added shadow ran a transition with its transitionrun / start / end events at every mark and
 * unmark), and the rule is taken off in two steps so that the removal starts none either; a scroller whose shadow or background is animated is not synchronised (the
 * rule would hold the animation still), nor a shadow host or a slotted scroller (the snapshot copies their computed style). Chromium only: elsewhere the canvas
 * already follows every scroll step.
 * Module: live (src/live/*).
 */

import { MARK } from '../contracts/events.js';
import { currentEngine } from '../util/engine.js';

/** @typedef {import('../contracts/types.js').GeometryRules} GeometryRules */
/** @typedef {{boxShadow: string, backgroundImage: string, backgroundAttachment: string}} ScrollAuthorStyle */
/** @typedef {ScrollAuthorStyle & {backgroundClip?: string}} ScrollLook */
/** @typedef {{transitionProperty: string, transitionDuration: string, transitionDelay: string}} TransitionStyle */

const SYNC_SHADOW = 'inset 0 0 0 0 transparent';
const SYNC_IMAGE = 'linear-gradient(transparent, transparent)';
/** form controls scroll their own text: their look must stay readable by the text overlay (capture/text-overlay.js reads the field's box-shadow) */
const SKIP = new Set(['input', 'textarea', 'select']);

/** @param {string} v a computed list value @returns {string[]} its top-level comma-separated items */
export function splitList(v) {
  /** @type {string[]} */
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { out.push(v.slice(start, i).trim()); start = i + 1; }
  }
  out.push(v.slice(start).trim());
  return out.filter(Boolean);
}

/**
 * PURE. The declarations that give a scroller with these computed values a main-thread repaint reason, keeping what the author wrote; null when it already has one
 * (an inset shadow and a local-attachment image of its own).
 * @param {ScrollLook} cs
 * @returns {Record<string, string>|null}
 */
export function syncDeclarations(cs) {
  const inset = / inset/.test(` ${cs.boxShadow}`);
  const images = cs.backgroundImage && cs.backgroundImage !== 'none' ? splitList(cs.backgroundImage) : [];
  const attachments = splitList(cs.backgroundAttachment || 'scroll');
  const at = (/** @type {number} */ i) => attachments[i % attachments.length] ?? 'scroll';
  const local = images.some((img, i) => img !== 'none' && at(i) === 'local');
  if (inset && local) return null;
  /** @type {Record<string, string>} */
  const decl = {};
  if (!inset) decl['box-shadow'] = !cs.boxShadow || cs.boxShadow === 'none' ? SYNC_SHADOW : `${cs.boxShadow}, ${SYNC_SHADOW}`;
  if (!local) {
    decl['background-image'] = [...images, SYNC_IMAGE].join(', ');
    decl['background-attachment'] = [...images.map((_, i) => at(i)), 'local'].join(', ');
    // the background colour is clipped by the bottom layer: the added one takes the clip the colour had (a cycled list would give it another)
    const clips = splitList(cs.backgroundClip || 'border-box');
    const clip = (/** @type {number} */ i) => clips[i % clips.length] ?? 'border-box';
    decl['background-clip'] = [...images.map((_, i) => clip(i)), clip(Math.max(0, images.length - 1))].join(', ');
  }
  return decl;
}

/** @param {string} v a computed time ("0.3s", "250ms") @returns {number} seconds */
const seconds = (v) => (v.endsWith('ms') ? parseFloat(v) / 1000 : parseFloat(v)) || 0;

/**
 * PURE. An author transition that would animate the added shadow (box-shadow or all, with a positive combined duration): the transition lists with box-shadow appended
 * at 0s (the last entry of a property wins), so the shadow changes at once and fires no transition event; null when no transition covers box-shadow.
 * @param {TransitionStyle} cs
 * @returns {Record<string, string>|null}
 */
export function transitionGuard(cs) {
  const props = splitList(cs.transitionProperty || 'all');
  if (props.length === 1 && props[0] === 'none') return null;
  const durations = splitList(cs.transitionDuration || '0s');
  const delays = splitList(cs.transitionDelay || '0s');
  const at = (/** @type {string[]} */ list, /** @type {number} */ i) => list[i % list.length] ?? '0s';
  if (!props.some((p, i) => (p === 'all' || p === 'box-shadow') && Math.max(0, seconds(at(durations, i))) + seconds(at(delays, i)) > 0)) return null;
  return {
    'transition-property': [...props, 'box-shadow'].join(', '),
    'transition-duration': [...props.map((_, i) => at(durations, i)), '0s'].join(', '),
    'transition-delay': [...props.map((_, i) => at(delays, i)), '0s'].join(', '),
  };
}

const LOOK_KEYS = new Set(['boxShadow', 'background', 'backgroundImage', 'backgroundAttachment', 'backgroundClip']);
const LOOK_PROPS = new Set(['box-shadow', 'background', 'background-image', 'background-attachment', 'background-clip', 'all']);

/** @param {Element} el @returns {boolean} an animation or a running transition of el changes a property the rule would hold */
function animatesLook(el) {
  for (const a of el.getAnimations?.() ?? []) {
    const tp = /** @type {any} */ (a).transitionProperty;
    if (typeof tp === 'string') { if (LOOK_PROPS.has(tp)) return true; continue; }
    const effect = /** @type {KeyframeEffect|null} */ (a.effect);
    if (!effect || effect.pseudoElement) continue;
    for (const kf of effect.getKeyframes()) for (const k of Object.keys(kf)) if (LOOK_KEYS.has(k)) return true;
  }
  return false;
}

/**
 * @param {Document|ShadowRoot} root  tree scope of the layer: a scroller in another scope (an author shadow root) is left alone
 * @param {() => GeometryRules|null} rules  the scroll rules of that root's polyfill sheet (null while unmounted)
 * @returns {{mark: (el: Element) => void, unmark: (el: Element) => void, author: (el: Element) => ScrollAuthorStyle|null, clear: () => void}}
 */
export function createScrollSync(root, rules) {
  /** @type {Map<Element, {key: string|null, author: ScrollAuthorStyle, guard: Record<string, string>|null}>} */
  const marked = new Map();
  let seq = 0;

  /** @param {Element} el */
  function unmark(el) {
    const m = marked.get(el);
    if (!m) return;
    marked.delete(el);
    if (m.key === null) return;
    const r = rules();
    const view = el.ownerDocument.defaultView;
    if (m.guard && r && view && el.isConnected) {
      // first the look goes back to the author's while box-shadow transitions are still held, in a style update of its own; then the hold goes
      r.set(m.key, m.guard);
      void view.getComputedStyle(el).boxShadow;
    }
    r?.remove(m.key);
    if (el.getAttribute(MARK.SCROLL_ATTR) === m.key) el.removeAttribute(MARK.SCROLL_ATTR);
  }

  return {
    mark(el) {
      if (marked.has(el)) {
        // an animation of the shadow or the background that started meanwhile: the rule would hold it still
        if (marked.get(el)?.key && animatesLook(el)) unmark(el);
        return;
      }
      if (SKIP.has(el.localName) || currentEngine().engine !== 'chromium' || el.getRootNode() !== root) return;
      if (el.shadowRoot || /** @type {HTMLElement} */ (el).assignedSlot || animatesLook(el)) return;
      const r = rules();
      const view = el.ownerDocument.defaultView;
      if (!r || !view) return;
      const cs = view.getComputedStyle(el);
      const author = { boxShadow: cs.boxShadow, backgroundImage: cs.backgroundImage, backgroundAttachment: cs.backgroundAttachment };
      const decl = syncDeclarations({ ...author, backgroundClip: cs.backgroundClip });
      const guard = decl && 'box-shadow' in decl ? transitionGuard(cs) : null;
      const key = decl ? `s${++seq}` : null;
      marked.set(el, { key, author, guard });
      if (!key || !decl) return;
      r.set(key, { ...decl, ...guard });
      el.setAttribute(MARK.SCROLL_ATTR, key);
    },
    unmark,
    author: (el) => (marked.get(el)?.key ? /** @type {{author: ScrollAuthorStyle}} */ (marked.get(el)).author : null),
    clear() {
      for (const el of [...marked.keys()]) unmark(el);
    },
  };
}
