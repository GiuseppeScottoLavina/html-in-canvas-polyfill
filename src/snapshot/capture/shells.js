/**
 * Shell elements between the layer and a drawable in the clone: display:contents by default, a REAL sized box when the ancestor affects descendants' layout (docs/ARCHITECTURE.md ADR-D.1).
 * Module: snapshot-capture (src/snapshot/capture/*).
 */

import { MARK } from '../../contracts/events.js';
import { cleanAttributes } from './state-sync.js';
import { appendInlineStyle, setInlineStyle } from './inline-style.js';

/**
 * @typedef {Object} ShellFacts  computed-style facts of one logical ancestor
 * @property {string} containerType  'normal' | 'size' | 'inline-size' | 'scroll-state' ...
 * @property {string} contain
 * @property {string} overflow
 * @property {string} transform
 * @property {string} filter
 * @property {string} display
 */

const CANVAS_ONLY_ATTRS = ['width', 'height', 'content', 'layoutsubtree', 'drawable', 'framecap', 'aria-owns'];
/** Sibling stubs never load or show anything: these attributes could make the image document fetch a resource. */
const LOADING_ATTRS = ['src', 'srcset', 'href', 'poster', 'data', 'action'];
const CONTAINMENT = /(?:^|\s)(?:layout|paint|size|inline-size|style|strict|content)(?:\s|$)/;
const NEUTRAL_LOOK = 'background:none!important;border-color:transparent!important;border-image:none!important;box-shadow:none!important;outline:none!important;transform:none!important;'
  + 'translate:none!important;rotate:none!important;scale:none!important;filter:none!important;backdrop-filter:none!important;opacity:1!important;clip-path:none!important;mask:none!important;';

/**
 * PURE. true when display:contents would change the result: container-type != normal (a display:contents shell is NOT a query container, measured), contain with layout/paint/size/style, overflow != visible, transform/filter != none.
 * @param {ShellFacts} facts
 * @returns {boolean}
 */
export function shellNeedsBox(facts) {
  if (facts.display === 'contents' || facts.display === 'none') return false;
  if (facts.containerType && facts.containerType !== 'normal') return true;
  if (facts.contain && facts.contain !== 'none' && CONTAINMENT.test(facts.contain)) return true;
  if (facts.overflow && facts.overflow.split(/\s+/).some((v) => v && v !== 'visible')) return true;
  if (facts.transform && facts.transform !== 'none') return true;
  return !!facts.filter && facts.filter !== 'none';
}

/**
 * Computed-style facts of one logical ancestor.
 * @param {CSSStyleDeclaration} cs
 * @returns {ShellFacts}
 */
export function shellFactsOf(cs) {
  return {
    containerType: cs.containerType, contain: cs.contain, overflow: `${cs.overflowX} ${cs.overflowY}`, transform: cs.transform, filter: cs.filter, display: cs.display,
  };
}

/**
 * Build the shell element for `source` (same tag and attributes of the clone). The canvas itself becomes a `hic-canvas[data-hic-root]` that carries its attributes, so rules written for the canvas keep matching.
 * A real-box shell gets the measured border-box size, is absolutely positioned at box.left/top (clone.js computes them so the drawable lands at the crop origin), and shows none of its own
 * painting (background, border colour, shadow, transform, filter, opacity: a drawable snapshot does not contain the look of its ancestors) and does not clip.
 * @param {Document} doc
 * @param {Element} source
 * @param {boolean} asBox
 * @param {{width: number, height: number, left?: number, top?: number}|null} box
 * @param {boolean} [forCanvas]  `source` is the managed canvas (or what stands in for it); defaults to "it is a <canvas>"
 * @returns {Element}
 */
export function buildShell(doc, source, asBox, box, forCanvas = source.localName === 'canvas') {
  const isCanvas = forCanvas;
  // A custom tag, not `div`: the drawable's parent in the clone must not match author rules such as `div > div` or `div div` (WPT css-blend-mode), the live parent is the <canvas>.
  const shell = isCanvas ? doc.createElement('hic-canvas') : doc.importNode(source, false);
  if (isCanvas) {
    for (const a of Array.from(source.attributes)) if (!CANVAS_ONLY_ATTRS.includes(a.name) && a.name !== 'style') shell.setAttribute(a.name, a.value);
    if (source.hasAttribute('style')) setInlineStyle(shell, source.getAttribute('style') ?? '');
    shell.setAttribute('data-hic-root', '');
    // the canvas's own zoom scales the canvas box, not the drawables (the live layer is its sibling): never in the clone
    appendInlineStyle(shell, 'zoom:1!important');
  }
  cleanAttributes(shell);
  shell.setAttribute('data-hic-shell', '');
  if (!asBox || !box) {
    appendInlineStyle(shell, 'display:contents!important');
    return shell;
  }
  const pos = box.left !== undefined && box.top !== undefined ? `position:absolute!important;left:${box.left}px!important;top:${box.top}px!important;right:auto!important;bottom:auto!important;` : '';
  appendInlineStyle(shell, `${pos}box-sizing:border-box!important;width:${box.width}px!important;height:${box.height}px!important;min-width:0!important;min-height:0!important;max-width:none!important;max-height:none!important;`
    + `margin:0!important;float:none!important;overflow:visible!important;contain:none!important;flex:none!important;${NEUTRAL_LOOK}`);
  return shell;
}

/**
 * An attribute-only `display:none` stand-in of a sibling element: it keeps `.a + .b`, `~`, :nth-child, :first/:last/:only-child answering as in the live tree.
 * @param {Document} doc
 * @param {Element} sibling
 * @returns {Element}
 */
export function siblingStub(doc, sibling) {
  const stub = doc.importNode(sibling, false);
  cleanAttributes(stub);
  for (const name of LOADING_ATTRS) stub.removeAttribute(name);
  setInlineStyle(stub, 'display:none!important');
  return stub;
}

/**
 * Append `node` (the clone of `source`) to `parent` between stand-ins of every other element sibling of `source`, in live order.
 * @param {Document} doc
 * @param {Element} parent  clone parent
 * @param {Element} source  live element
 * @param {Element} node    its clone
 * @param {Element} liveParent  the logical parent of `source`
 * @returns {number} stubs added (they count against the node budget)
 */
export function appendWithStubs(doc, parent, source, node, liveParent) {
  let added = 0;
  for (const sib of Array.from(liveParent.children)) {
    if (sib === source) { parent.appendChild(node); continue; }
    if (sib.hasAttribute(MARK.NODE_ATTR)) continue;
    parent.appendChild(siblingStub(doc, sib));
    added++;
  }
  if (!node.parentNode) parent.appendChild(node);
  return added;
}
