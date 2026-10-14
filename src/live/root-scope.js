/**
 * Tree scopes (document + shadow roots) that can hold a managed canvas (docs/ARCHITECTURE.md ADR-K).
 * Module: live (src/live/*).
 */

import { BUS } from '../contracts/events.js';
import { installLayerStyle } from './layer-style.js';

/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../contracts/types.js').LayerStyleHandle} LayerStyleHandle */
/** @typedef {import('../contracts/types.js').PatchLedger} PatchLedger */
/** @typedef {import('../contracts/types.js').RootScope} RootScope */

/** @param {Node} node @returns {node is ShadowRoot} */
const isShadowRoot = (node) => node.nodeType === 11 && 'host' in node;

/**
 * Patches Element.prototype.attachShadow through the ledger (the returned ShadowRoot is recorded even when the root is closed, as long as it is created after install),
 * walks existing OPEN roots once at creation, emits BUS.ROOT_ADDED for every new root, and hands out one reference-counted LayerStyleHandle per root
 * (anchor names and adopted sheets are tree-scoped, so the layer sheet must live in the same root as the canvas).
 * A canvas whose root is a closed root created before install is refused with feature 'shadow-canvas' (hint: installed.adoptRoot(root)).
 * Declarative shadow roots created by the parser never call attachShadow: whoever discovers one (registry scan) hands it to adopt().
 * @param {HicEnv} env
 * @param {PatchLedger} ledger
 * @returns {RootScope}
 */
export function createRootScope(env, ledger) {
  /** @type {Set<WeakRef<ShadowRoot>>} */
  const known = new Set();
  /** @type {WeakSet<ShadowRoot>} */
  const seen = new WeakSet();
  /** @type {Set<LayerStyleHandle>} */
  const handles = new Set();
  const listeners = new Set();
  let live = true;

  /** @param {ShadowRoot} root */
  function record(root) {
    if (!live || seen.has(root)) return;
    seen.add(root);
    known.add(new WeakRef(root));
    env.bus.emit(BUS.ROOT_ADDED, { root });
    for (const cb of [...listeners]) {
      try { cb(root); } catch (err) { env.reporter.caught(err, 'root-scope.onRoot'); }
    }
  }

  /** @param {ParentNode} scope */
  function walk(scope) {
    for (const el of scope.querySelectorAll('*')) {
      const root = el.shadowRoot;
      if (!root) continue;
      record(root);
      walk(root);
    }
  }

  ledger.wrap(Element.prototype, 'attachShadow', (original) => /** @this {Element} */ function attachShadow(/** @type {any[]} */ ...args) {
    const root = /** @type {ShadowRoot} */ (original.apply(this, args));
    record(root);
    return root;
  });
  walk(env.document);

  return {
    roots() {
      /** @type {Array<Document|ShadowRoot>} */
      const out = [env.document];
      for (const ref of [...known]) {
        const root = ref.deref();
        if (!root) known.delete(ref);
        else if (root.host.isConnected) out.push(root);
      }
      return out;
    },
    rootOf(node) {
      const root = node.getRootNode();
      if (isShadowRoot(root)) return root;
      return root.nodeType === 9 ? /** @type {Document} */ (root) : env.document;
    },
    adopt(root) { record(root); },
    onRoot(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    style(root) {
      const handle = installLayerStyle(root);
      handles.add(handle);
      const dispose = handle.dispose;
      handle.dispose = () => { handles.delete(handle); dispose(); };
      return handle;
    },
    dispose() {
      live = false;
      for (const handle of [...handles]) handle.dispose();
      listeners.clear();
      known.clear();
    },
  };
}
