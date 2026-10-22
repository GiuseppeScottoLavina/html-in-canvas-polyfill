/**
 * MutationObserver on the layer subtree -> damage + DRAWABLES_CHANGED.
 * Module: schedule (src/schedule/observers/*).
 */

import { BUS, MARK } from '../../contracts/events.js';
import { createDamageBatch, getRectMemory } from './damage-rect.js';
import { INHERITED_PROPS } from '../../util/inherited-props.js';

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
      // `load` and `toggle` are not composed: they never leave the shadow tree they fire in
      sr.addEventListener('load', onLoad, true);
      sr.addEventListener('toggle', onToggle, true);
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
    if (stopped || t.nodeType !== 1) return;
    if (t.localName === 'img') { frameChanged(lightHost(t)); return; }
    if (!/^(iframe|frame|object)$/.test(t.localName)) return;
    watchFrames();
    frameChanged(lightHost(t));
  };

  /**
   * A popover shown or hidden (showPopover/hidePopover/togglePopover, popovertarget) changes no attribute, so no mutation announces it: an open popover is in the top layer and
   * left out of the snapshot (state-sync.js inTopLayer), a hidden one with an author display is drawn in place again (WPT privacy/popover-show-hide-background-image-ignored drew
   * the snapshot taken while it was open). The `toggle` event (HTML "queue a popover toggle event task") repaints the drawable that contains it.
   * @param {Event} e
   */
  const onToggle = (e) => {
    const t = /** @type {Element} */ (e.target);
    if (!stopped && t.nodeType === 1 && t.hasAttribute('popover')) frameChanged(lightHost(t));
  };
  // the listeners on shadow roots are not removed one by one (the roots are only weakly known): they do nothing once stopped
  let stopped = false;

  const mo = new /** @type {Window & typeof globalThis} */ (env.window).MutationObserver(onMutations);
  mo.observe(root, OPTIONS);
  observeShadows(root);
  watchFrames();
  root.addEventListener('load', onLoad, true);
  root.addEventListener('toggle', onToggle, true);
  const stopAncestors = watchAncestors(env, record);
  return () => {
    stopped = true;
    mo.disconnect();
    stopAncestors();
    root.removeEventListener('load', onLoad, true);
    root.removeEventListener('toggle', onToggle, true);
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

/** Attributes whose change on an ancestor always reaches the drawables: the language and the direction (`:lang()`, `:dir()`, fonts and shaping of the text below). */
const ALWAYS_REACHES = new Set(['lang', 'xml:lang', 'dir']);
/** A class, id or attribute name in a selector (CSS escapes kept: they are undone by unescapeIdent). */
const SELECTOR_TOKEN = /([.#])((?:[-\w\u00a0-\uffff]|\\[0-9a-fA-F]{1,6}\s?|\\.)+)|\[\s*(?:[-\w*]*\|)?((?:[-\w\u00a0-\uffff]|\\.)+)/g;

/** @param {string} s @returns {string} a CSS identifier with its escapes undone */
const unescapeIdent = (s) => s.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_, hex, ch) => (hex ? String.fromCodePoint(parseInt(hex, 16)) : ch));

/**
 * PURE. The classes (`.x`), ids (`#x`) and attribute names (`[x`) that one selector list can test on an element ABOVE the subject of a selector: everything before the last
 * top-level combinator of each complex selector, and everything inside parentheses (`:is()`, `:not()`, `:has()`, nested selectors) of its last compound. A token only in
 * a subject compound (`.dark { ... }`) styles that element itself, which reaches its descendants through inheritance only (styleSignature).
 * @param {string} selectorText
 * @param {Set<string>} out  tokens as `.x`, `#x`, `[x`
 */
export function ancestorTokens(selectorText, out) {
  let depth = 0;
  let start = 0;
  /** index of the last top-level combinator of the current complex selector */
  let cut = 0;
  const flush = (/** @type {number} */ end) => {
    const head = selectorText.slice(start, cut);
    const last = selectorText.slice(cut, end);
    const take = (/** @type {string} */ text) => { for (const m of text.matchAll(SELECTOR_TOKEN)) out.add(m[1] ? m[1] + unescapeIdent(m[2]) : `[${unescapeIdent(m[3]).toLowerCase()}`); };
    take(head);
    for (const m of last.matchAll(/\((.*)\)/gs)) take(m[1]);
  };
  for (let i = 0; i < selectorText.length; i++) {
    const c = selectorText[i];
    if (c === '\\') { i++; continue; }
    if (c === '"' || c === "'") { const close = selectorText.indexOf(c, i + 1); i = close < 0 ? selectorText.length : close; continue; }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && c === ',') { cut = Math.max(cut, start); flush(i); start = i + 1; cut = start; }
    else if (depth === 0 && (c === '>' || c === '+' || c === '~' || /\s/.test(c))) cut = i + 1; // white space before a combinator or a comma only moves the cut early: more tokens, never fewer
  }
  cut = Math.max(cut, start);
  flush(selectorText.length);
}

/**
 * The tokens every style rule reachable from `roots` can test on an ancestor (ancestorTokens), or null when a sheet cannot be read (cross-origin without CORS): then every
 * ancestor change counts. Nested style rules count the whole selector of their parent; `@scope` preludes count whole.
 * @param {Array<Document|ShadowRoot>} roots
 * @returns {Set<string>|null}
 */
function ancestorTokensOf(roots) {
  /** @type {Set<string>} */
  const out = new Set();
  /** @param {CSSRuleList} rules @param {boolean} nested */
  const walk = (rules, nested) => {
    for (const rule of Array.from(rules)) {
      const r = /** @type {any} */ (rule);
      if (r.styleSheet) { if (!walkSheet(r.styleSheet)) return false; continue; }
      if (typeof r.selectorText === 'string') {
        if (r.cssRules?.length || nested) for (const m of r.selectorText.matchAll(SELECTOR_TOKEN)) out.add(m[1] ? m[1] + unescapeIdent(m[2]) : `[${unescapeIdent(m[3]).toLowerCase()}`);
        ancestorTokens(r.selectorText, out);
        if (r.cssRules?.length && walk(r.cssRules, true) === false) return false;
        continue;
      }
      for (const prelude of [r.start, r.end]) if (typeof prelude === 'string') for (const m of prelude.matchAll(SELECTOR_TOKEN)) out.add(m[1] ? m[1] + unescapeIdent(m[2]) : `[${unescapeIdent(m[3]).toLowerCase()}`);
      if (r.cssRules && walk(r.cssRules, nested) === false) return false;
    }
    return true;
  };
  /** @param {CSSStyleSheet} sheet @returns {boolean} */
  const walkSheet = (sheet) => {
    let rules;
    try { rules = sheet.cssRules; } catch { return false; }
    return walk(rules, false) !== false;
  };
  for (const root of roots) {
    for (const sheet of [...Array.from(root.styleSheets ?? []), ...Array.from(/** @type {any} */ (root).adoptedStyleSheets ?? [])]) if (!walkSheet(sheet)) return null;
  }
  return out;
}

/** @param {Element} el @returns {string} the values `el` passes on to its descendants: its inherited properties and its custom properties */
function styleSignature(el) {
  const cs = (el.ownerDocument.defaultView ?? window).getComputedStyle(el);
  let sig = '';
  for (const name of INHERITED_PROPS) sig += `${cs.getPropertyValue(name)};`;
  for (let i = 0; i < cs.length; i++) if (cs[i].startsWith('--')) sig += `${cs[i]}:${cs.getPropertyValue(cs[i])};`;
  return sig;
}

/** @param {MutationRecord} m @returns {string[]} the tokens the change can turn on or off in a selector */
function changedTokens(m) {
  const name = m.attributeName ?? '';
  const now = /** @type {Element} */ (m.target).getAttribute(name);
  if (name === 'class') {
    const before = new Set((m.oldValue ?? '').split(/\s+/).filter(Boolean));
    const after = new Set((now ?? '').split(/\s+/).filter(Boolean));
    return [...before, ...after].filter((c) => before.has(c) !== after.has(c)).map((c) => `.${c}`).concat(`[class`);
  }
  if (name === 'id') return [`#${m.oldValue ?? ''}`, `#${now ?? ''}`, '[id'];
  return [`[${name.toLowerCase()}`];
}

/**
 * The clone carries attribute-only shells of the canvas's ancestors and the custom properties computed above it, so a class / data-theme / lang / style change on an ancestor (a theme toggle on <html>, a wrapper's
 * `--accent`) can change every tile of the canvas. One MutationObserver per canvas watches ONLY the attributes of the few ancestor elements (not their subtrees: idle cost is zero).
 * A change damages the whole canvas when it can reach what the drawables paint: a class, id or attribute that a style rule tests on an element above its subject
 * (ancestorTokens; any change when a sheet cannot be read), the language or direction, or a computed value of the canvas itself (what the drawables inherit: its inherited and
 * custom properties; styleSignature). A change that restyles only the ancestor (WPT onpaint 'canvas ancestor changes': its own background) paints nothing in the
 * canvas, and natively fires no paint event.
 * The chain is re-read when the canvas is (re)activated (a moved canvas resumes with forced damage), so a canvas that was moved to another parent is followed at once.
 * @param {HicEnv} env
 * @param {CanvasRecord} record
 * @returns {() => void}
 */
function watchAncestors(env, record) {
  /** @type {Element[]} */
  let watched = [];
  /** @type {Set<string>|null|undefined} undefined: not read since the last stylesheet change */
  let tokens;
  let signature = styleSignature(record.canvas);
  /** @param {MutationRecord[]} batch @returns {boolean} */
  const reaches = (batch) => {
    const next = styleSignature(record.canvas);
    const inherited = next !== signature;
    signature = next;
    if (inherited || batch.some((m) => ALWAYS_REACHES.has(m.attributeName ?? ''))) return true;
    if (tokens === undefined) tokens = ancestorTokensOf([...new Set([env.document, ...watched.map((el) => /** @type {Document|ShadowRoot} */ (el.getRootNode())), record.root])]);
    const known = tokens;
    return !known || batch.some((m) => changedTokens(m).some((t) => known.has(t)));
  };
  const mo = new /** @type {Window & typeof globalThis} */ (env.window).MutationObserver((records) => {
    const batch = records.filter((m) => !OWN_ATTRIBUTE.test(m.attributeName ?? '') && !env.isManagedLayerNode(/** @type {Element} */ (m.target)));
    if (batch.length && reaches(batch)) env.scheduler.damage(record, 'mutation', null, null);
  });
  const observe = () => { for (const el of watched) mo.observe(el, { attributes: true, attributeOldValue: true }); };
  function sync() {
    const next = ancestorsOf(record.canvas);
    signature = styleSignature(record.canvas);
    if (next.length === watched.length && next.every((el, i) => el === watched[i])) return;
    mo.disconnect();
    watched = next;
    tokens = undefined;
    observe();
    if (record.state === 'active') env.scheduler.damage(record, 'mutation', null, null);
  }
  watched = ancestorsOf(record.canvas);
  observe();
  const offDamage = env.bus.on(BUS.DAMAGE, (/** @type {{record: CanvasRecord, cause: string}} */ e) => {
    if (e.cause === 'stylesheet') tokens = undefined;
    else if (e.record === record && e.cause === 'forced') sync();
  });
  return () => { offDamage(); mo.disconnect(); watched = []; };
}
