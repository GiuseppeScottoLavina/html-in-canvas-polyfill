/**
 * DOM-identity facade: canvas child list and relocated children (instance-level, removed on unmount).
 * Module: live (src/live/*).
 */

import { MARK } from '../contracts/events.js';
import { isLayerElement, nativeDom } from './drawables.js';

/** @typedef {import('../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../contracts/types.js').ChildrenChange} ChildrenChange */
/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */

/**
 * Own-property helper with exact undo: defines `key` on `target` and remembers an own descriptor that was there before.
 * @returns {{define: (target: object, key: PropertyKey, descriptor: PropertyDescriptor) => void, restore: () => void}}
 */
export function createOwnProps() {
  /** @type {Array<{target: object, key: PropertyKey, prior: PropertyDescriptor|undefined}>} */
  const entries = [];
  return {
    define(target, key, descriptor) {
      if (!entries.some((e) => e.target === target && e.key === key)) {
        entries.push({ target, key, prior: Object.getOwnPropertyDescriptor(target, key) });
      }
      Object.defineProperty(target, key, { configurable: true, enumerable: false, ...descriptor });
    },
    restore() {
      for (const { target, key, prior } of entries.reverse()) {
        if (prior) Object.defineProperty(target, key, prior);
        else Reflect.deleteProperty(target, key);
      }
      entries.length = 0;
    },
  };
}

/**
 * @typedef {Object} TreeFacade
 * @property {() => Node[]} logicalChildNodes
 * @property {(cb: (c: ChildrenChange) => void) => () => void} onChildrenChanged  top-level logical child list changed (facade write or relocated insertion)
 * @property {(cb: () => void) => () => void} onTreeChanged  anything below the layer changed structurally, or a `drawable` attribute flipped
 * @property {() => void} flush  deliver pending mutation records now (relocate native canvas children first); called by every facade write and by query methods that need a current view
 * @property {{authorOwns: (() => string|null)|null}} hooks  authorOwns: the aria-owns value the author set, restored on clones of the canvas
 * @property {() => void} uninstall  removes every own-property override
 */

/** @param {Node} n @returns {boolean} */
const isHidden = (n) => n.nodeType === 1 && isLayerElement(/** @type {Element} */ (n));

/** @param {Node|null} node @param {(n: Node) => Node|null} step @returns {Node|null} first node from `node` onward that is not a polyfill layer */
function skipHidden(node, step) {
  let cur = node;
  while (cur && isHidden(cur)) cur = step(cur);
  return cur;
}

/** @template T @param {T[]} items @returns {T[] & {item: (i: number) => T|null}} */
function arrayLike(items) {
  return Object.assign(items, { item(/** @type {number} */ i) { return items[i] ?? null; } });
}

/**
 * Define own properties on the canvas (children, childNodes, append, insertBefore, innerHTML, contains, ... and nextSibling/nextElementSibling skipping the layer) and on relocated top-level children (parentNode, parentElement),
 * all routing into the layer. Query methods (querySelector, getElementsBy*) search the layer.
 * @param {HicEnv} env
 * @param {CanvasRecord} record
 * @param {HTMLElement} layerEl
 * @returns {TreeFacade}
 */
export function installTreeFacade(env, record, layerEl) {
  const canvas = record.canvas;
  const nat = nativeDom();
  const own = createOwnProps();
  /** @type {Set<Node>} */
  const adopted = new Set();
  /** @type {Set<(c: ChildrenChange) => void>} */
  const childListeners = new Set();
  /** @type {Set<() => void>} */
  const treeListeners = new Set();
  /** @type {MutationRecord[]} */
  const backlog = [];
  let draining = false;
  let installed = true;

  /** @param {Node} n */
  function adopt(n) {
    if (adopted.has(n)) return;
    adopted.add(n);
    Object.defineProperty(n, 'parentNode', { configurable: true, get() { const p = nat.parentNode.call(this); return p === layerEl ? canvas : p; } });
    Object.defineProperty(n, 'parentElement', { configurable: true, get() { const p = nat.parentNode.call(this); return p === layerEl ? canvas : (p && p.nodeType === 1 ? p : null); } });
  }

  /** @param {Node} n */
  function release(n) {
    if (!adopted.delete(n)) return;
    Reflect.deleteProperty(n, 'parentNode');
    Reflect.deleteProperty(n, 'parentElement');
  }

  /** @param {MutationRecord[]} records */
  function process(records) {
    /** @type {Node[]} */
    const added = [];
    /** @type {Node[]} */
    const removed = [];
    for (const r of records) {
      if (r.type === 'attributes') continue;
      if (r.target === layerEl) {
        added.push(...r.addedNodes);
        removed.push(...r.removedNodes);
      }
    }
    for (const n of removed) if (nat.parentNode.call(n) !== layerEl) release(n);
    for (const n of added) if (nat.parentNode.call(n) === layerEl) adopt(n);
    const visible = (/** @type {Node[]} */ list) => list.filter((n) => !isHidden(n));
    const change = { added: visible(added), removed: visible(removed) };
    if (change.added.length || change.removed.length) for (const cb of [...childListeners]) guard(() => cb(change));
    for (const cb of [...treeListeners]) guard(cb);
  }

  /** @param {() => void} fn */
  function guard(fn) {
    try { fn(); } catch (err) { env.reporter.caught(err, 'tree-facade'); }
  }

  /**
   * A node that reached the canvas itself (a native method the facade does not route, e.g. canvas.moveBefore(node, null)) moves on into the layer. With the
   * state-preserving moveBefore() where the engine has it: an appendChild() would remove and re-insert the node, which reloads an iframe (a moved srcdoc frame showed its
   * blank initial document, WPT privacy/box-reflect-images-in-iframe-moved-ignored) and resets focus, animations and playing media that the author's own move kept.
   */
  function relocate() {
    const move = /** @type {any} */ (layerEl).moveBefore;
    for (let n = nat.firstChild.call(canvas); n; n = nat.firstChild.call(canvas)) {
      if (typeof move === 'function') {
        try { move.call(layerEl, n, null); continue; } catch { /* not movable atomically (a disconnected layer, another document): inserted */ }
      }
      layerEl.appendChild(n);
    }
  }

  function drain() {
    if (draining || !installed) return;
    draining = true;
    try {
      relocate();
      for (;;) {
        backlog.push(...layerObserver.takeRecords());
        const batch = backlog.splice(0);
        if (!batch.length) break;
        process(batch);
      }
    } finally { draining = false; }
  }

  const layerObserver = new MutationObserver((records) => { backlog.push(...records); drain(); });
  layerObserver.observe(layerEl, { childList: true, subtree: true, attributes: true, attributeFilter: ['drawable'] });
  const canvasObserver = new MutationObserver(() => drain());
  canvasObserver.observe(canvas, { childList: true });
  for (const n of nat.childNodes.call(layerEl)) adopt(n);

  const hooks = { authorOwns: /** @type {(() => string|null)|null} */ (null) };
  defineCanvasProperties(canvas, layerEl, own, nat, drain, hooks);

  return {
    logicalChildNodes() {
      drain();
      return [...nat.childNodes.call(layerEl)].filter((n) => !isHidden(n));
    },
    onChildrenChanged(cb) { childListeners.add(cb); return () => { childListeners.delete(cb); }; },
    onTreeChanged(cb) { treeListeners.add(cb); return () => { treeListeners.delete(cb); }; },
    flush: drain,
    hooks,
    uninstall() {
      if (!installed) return;
      drain();
      installed = false;
      layerObserver.disconnect();
      canvasObserver.disconnect();
      for (const n of [...adopted]) release(n);
      own.restore();
      childListeners.clear();
      treeListeners.clear();
    },
  };
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLElement} layerEl
 * @param {ReturnType<typeof createOwnProps>} own
 * @param {ReturnType<typeof nativeDom>} nat
 * @param {() => void} flush
 * @param {{authorOwns: (() => string|null)|null}} hooks
 */
function defineCanvasProperties(canvas, layerEl, own, nat, flush, hooks) {
  /** @param {string} key @param {() => any} get @param {(v: any) => void} [set] */
  const accessor = (key, get, set) => own.define(canvas, key, set ? { get, set } : { get });
  /** @param {string} key @param {Function} fn */
  const method = (key, fn) => own.define(canvas, key, { writable: true, value: fn });
  const read = (/** @type {() => any} */ fn) => () => { flush(); return fn(); };
  const L = /** @type {any} */ (layerEl);
  const nativeClone = canvas.cloneNode;

  accessor('childNodes', read(() => L.childNodes));
  accessor('children', read(() => L.children));
  accessor('firstChild', read(() => L.firstChild));
  accessor('lastChild', read(() => L.lastChild));
  accessor('firstElementChild', read(() => L.firstElementChild));
  accessor('lastElementChild', read(() => L.lastElementChild));
  accessor('childElementCount', read(() => L.childElementCount));
  accessor('nextSibling', () => skipHidden(nat.nextSibling.call(canvas), (n) => nat.nextSibling.call(n)));
  accessor('previousSibling', () => skipHidden(nat.previousSibling.call(canvas), (n) => nat.previousSibling.call(n)));
  accessor('nextElementSibling', () => /** @type {Element|null} */ (skipHidden(nat.nextElementSibling.call(canvas), (n) => nat.nextElementSibling.call(/** @type {Element} */ (n)))));
  accessor('previousElementSibling', () => /** @type {Element|null} */ (skipHidden(nat.previousElementSibling.call(canvas), (n) => nat.previousElementSibling.call(/** @type {Element} */ (n)))));
  accessor('innerHTML', read(() => L.innerHTML), (v) => { L.innerHTML = v; flush(); });
  accessor('textContent', read(() => L.textContent), (v) => { L.textContent = v; flush(); });
  accessor('outerHTML', () => { flush(); return /** @type {Element} */ (canvas.cloneNode(true)).outerHTML; });

  method('hasChildNodes', () => { flush(); return layerEl.hasChildNodes(); });
  method('contains', (/** @type {Node|null} */ node) => { flush(); return node === canvas || (!!node && node !== layerEl && layerEl.contains(node)); });
  for (const key of ['append', 'prepend', 'appendChild', 'insertBefore', 'removeChild', 'replaceChild', 'replaceChildren']) {
    method(key, (/** @type {any[]} */ ...args) => { const result = L[key](...args); flush(); return result; });
  }
  // the atomic move (DOM moveBefore) of the engines that have it: relative to a logical child it must run on the layer, where that child is
  if (typeof L.moveBefore === 'function') method('moveBefore', (/** @type {any[]} */ ...args) => { const result = L.moveBefore(...args); flush(); return result; });
  for (const key of ['querySelector', 'querySelectorAll', 'getElementsByTagName', 'getElementsByTagNameNS', 'getElementsByClassName']) {
    method(key, (/** @type {any[]} */ ...args) => { flush(); return L[key](...args); });
  }
  defineAdjacent(canvas, layerEl, method, flush);
  method('cloneNode', (/** @type {boolean} */ deep) => {
    flush();
    const clone = /** @type {HTMLCanvasElement} */ (nativeClone.call(canvas, false));
    clone.removeAttribute(MARK.CANVAS_ATTR);
    const owns = hooks.authorOwns ? hooks.authorOwns() : null;
    if (owns === null) clone.removeAttribute('aria-owns'); else clone.setAttribute('aria-owns', owns);
    if (deep) for (const child of nat.childNodes.call(layerEl)) if (!isHidden(child)) clone.appendChild(child.cloneNode(true));
    return clone;
  });
}

/** insertAdjacent*: inside positions go to the layer, outside positions stay on the canvas. */
function defineAdjacent(/** @type {HTMLCanvasElement} */ canvas, /** @type {HTMLElement} */ layerEl, /** @type {(key: string, fn: Function) => void} */ method, /** @type {() => void} */ flush) {
  const proto = /** @type {any} */ (Element.prototype);
  for (const key of ['insertAdjacentElement', 'insertAdjacentText', 'insertAdjacentHTML']) {
    method(key, (/** @type {string} */ where, /** @type {any} */ value) => {
      const inside = where.toLowerCase() === 'afterbegin' || where.toLowerCase() === 'beforeend';
      const result = proto[key].call(inside ? layerEl : canvas, where, value);
      if (inside) flush();
      return result;
    });
  }
}

/** @type {WeakMap<Node, {count: number, own: ReturnType<typeof createOwnProps>}>} */
const parentFacades = new WeakMap();

/** @param {Node} parent @param {ReturnType<typeof createOwnProps>} own */
function definePolyfillFreeChildren(parent, own) {
  const nat = nativeDom();
  const nodes = () => [...nat.childNodes.call(parent)].filter((n) => !isHidden(n));
  const elements = () => /** @type {Element[]} */ (nodes().filter((n) => n.nodeType === 1));
  const get = (/** @type {string} */ key, /** @type {() => any} */ fn) => own.define(parent, key, { get: fn });
  get('childNodes', () => arrayLike(nodes()));
  get('children', () => Object.assign(arrayLike(elements()), {
    namedItem(/** @type {string} */ name) { return elements().find((e) => e.id === name || e.getAttribute('name') === name) ?? null; },
  }));
  get('childElementCount', () => elements().length);
  get('firstChild', () => skipHidden(nat.firstChild.call(parent), (n) => nat.nextSibling.call(n)));
  get('lastChild', () => skipHidden(nat.lastChild.call(parent), (n) => nat.previousSibling.call(n)));
  get('firstElementChild', () => elements()[0] ?? null);
  get('lastElementChild', () => elements().at(-1) ?? null);
}

/**
 * options.parentFacade: instance-level own properties on the PARENT of the canvas (children, childNodes, childElementCount, firstChild, lastChild, firstElementChild, lastElementChild) that hide the layer.
 * `children` becomes a snapshot array-like (documented: not a live HTMLCollection). CSS (`:last-child`, `:nth-child`, `+`) and native live collections still see the layer (limit tree-identity). Removed on unmount.
 * One facade per parent however many managed canvases it holds (reference counted).
 * @param {HicEnv} env
 * @param {CanvasRecord} record
 * @param {HTMLElement} layerEl
 * @returns {() => void} remover
 */
export function installParentFacade(env, record, layerEl) {
  const parent = nativeDom().parentNode.call(layerEl) ?? nativeDom().parentNode.call(record.canvas);
  if (!parent) return () => {};
  let state = parentFacades.get(parent);
  if (!state) {
    state = { count: 0, own: createOwnProps() };
    definePolyfillFreeChildren(parent, state.own);
    parentFacades.set(parent, state);
  }
  state.count++;
  let removed = false;
  const shared = state;
  return () => {
    if (removed) return;
    removed = true;
    if (--shared.count > 0) return;
    shared.own.restore();
    parentFacades.delete(parent);
  };
}
