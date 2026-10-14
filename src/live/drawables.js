/**
 * Eligibility and drawable discovery inside the logical tree.
 * Module: live (src/live/*).
 */

import { MARK } from '../contracts/events.js';

/**
 * @typedef {Object} NativeAccessors  original prototype getters. Instance-level facades (tree-facade.js) shadow the public tree properties of canvases, layers and
 *   parents; polyfill code that must see the real tree reads through these.
 * @property {(this: Node) => NodeListOf<ChildNode>} childNodes
 * @property {(this: Node) => ParentNode|null} parentNode
 * @property {(this: Node) => ChildNode|null} firstChild
 * @property {(this: Node) => ChildNode|null} lastChild
 * @property {(this: Node) => ChildNode|null} nextSibling
 * @property {(this: Node) => ChildNode|null} previousSibling
 * @property {(this: Element) => HTMLCollection} children
 * @property {(this: Element) => Element|null} nextElementSibling
 * @property {(this: Element) => Element|null} previousElementSibling
 */

/** @type {NativeAccessors|null} */
let accessors = null;

/** @param {Function} ctor @param {string} key @returns {(this: any) => any} */
function getterOf(ctor, key) {
  const d = Object.getOwnPropertyDescriptor(ctor.prototype, key);
  if (!d || !d.get) throw new Error(`no native getter ${ctor.name}.${key}`);
  return d.get;
}

/** @returns {NativeAccessors} captured once, on first use */
export function nativeDom() {
  accessors ??= {
    childNodes: getterOf(Node, 'childNodes'),
    parentNode: getterOf(Node, 'parentNode'),
    firstChild: getterOf(Node, 'firstChild'),
    lastChild: getterOf(Node, 'lastChild'),
    nextSibling: getterOf(Node, 'nextSibling'),
    previousSibling: getterOf(Node, 'previousSibling'),
    children: getterOf(Element, 'children'),
    nextElementSibling: getterOf(Element, 'nextElementSibling'),
    previousElementSibling: getterOf(Element, 'previousElementSibling'),
  };
  return accessors;
}

/** @param {Node} node @returns {node is Element} */
const isElement = (node) => node.nodeType === 1;

/** @param {Element} el @returns {boolean} the layer of a (nested) managed canvas: never a logical child */
export function isLayerElement(el) {
  return el.localName === MARK.LAYER_TAG && el.hasAttribute(MARK.LAYER_ATTR);
}

/**
 * True when `el` sits below a nested canvas or a nested layer on its way up to (and including) `top`: it belongs to that canvas, not to this one.
 * @param {Element} el  a descendant of `top`
 * @param {Element} top
 * @returns {boolean}
 */
function belongsToNested(el, top) {
  const parentOf = nativeDom().parentNode;
  for (let cur = parentOf.call(el); cur && cur.nodeType === 1; cur = parentOf.call(cur)) {
    const node = /** @type {Element} */ (cur);
    if (node.localName === 'canvas' || isLayerElement(node)) return true;
    if (node === top) break;
  }
  return false;
}

/**
 * Eligible drawables of a canvas in TREE order: descendants with the drawable attribute when content=drawable; every DIRECT child element when record.legacy.
 * Subtrees of nested canvases and their layers are skipped (a nested canvas manages its own children).
 * @param {Node[]} logicalChildren
 * @param {boolean} legacy
 * @returns {Element[]}
 */
export function collectDrawables(logicalChildren, legacy) {
  /** @type {Element[]} */
  const out = [];
  for (const child of logicalChildren) {
    if (!isElement(child) || isLayerElement(child)) continue;
    if (legacy) {
      out.push(child);
      continue;
    }
    if (child.hasAttribute('drawable')) out.push(child);
    if (child.localName === 'canvas') continue;
    for (const el of child.querySelectorAll('[drawable]')) {
      if (!belongsToNested(el, child)) out.push(el);
    }
  }
  return out;
}

/**
 * Nearest inclusive ancestor of node that is an eligible drawable of this canvas, else null (stops at the layer).
 * @param {Node} node
 * @param {HTMLElement} layerEl
 * @param {ReadonlySet<Element>} drawables
 * @returns {Element|null}
 */
export function nearestDrawableOf(node, layerEl, drawables) {
  const parentOf = nativeDom().parentNode;
  /** @type {Node|null} */
  let cur = node;
  while (cur && cur !== layerEl) {
    if (isElement(cur) && drawables.has(cur)) return cur;
    cur = parentOf.call(cur);
  }
  return null;
}

/**
 * Short css-like path of el ("form#f > input.name") for UnsupportedEntry.path; climbs to the first id or six levels.
 * @param {Element} el
 * @param {Element} [stopAt]
 * @returns {string}
 */
export function cssPath(el, stopAt) {
  /** @type {string[]} */
  const parts = [];
  /** @type {Element|null} */
  let cur = el;
  while (cur && cur !== stopAt && parts.length < 6) {
    let part = cur.localName;
    if (cur.id) part += `#${cur.id}`;
    else if (cur.classList.length) part += `.${cur.classList[0]}`;
    parts.unshift(part);
    if (cur.id || cur.localName === 'body') break;
    cur = cur.parentElement;
  }
  return parts.join(' > ');
}
