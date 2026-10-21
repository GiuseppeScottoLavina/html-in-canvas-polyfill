/**
 * Canvas registry: one record per managed canvas, one MutationObserver per tree scope (dynamic canvases) and the per-canvas
 * lifecycle state machine (docs/ARCHITECTURE.md section 4.2).
 * Module: api-core.
 *
 * The observers only NOMINATE canvases; every decision is taken by `reconcile` from the END state of the DOM, so a removal followed by an
 * insertion in one task is a move by construction, and the order of mutation records never matters.
 */

import { BUS, MARK } from '../contracts/events.js';
import { refusePopoverCanvas } from './fullscreen-guard.js';
import { warnLegacyOnce } from './validate.js';
import { shadowIncludingOrder } from '../util/tree-order.js';

/** @typedef {import('../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../contracts/types.js').LiveLayer} LiveLayer */
/** @typedef {Document|ShadowRoot} Scope */
/**
 * @typedef {import('../contracts/types.js').CanvasRegistry & {
 *   ensure: (canvas: HTMLCanvasElement) => CanvasRecord|undefined,
 *   observe: (root: Scope) => void }} CoreRegistry
 *   ensure = synchronous adopt (env.adopt, the patched `content` setter, API entry points); observe = start watching a tree scope.
 */

/** How long a canvas may stay out of the document before its record is dropped (a removal followed by an insertion in a later task is still a move). */
export const SUSPEND_GRACE_MS = 5000;
/** Attributes whose change can mount, unmount or refuse a canvas. */
const WATCHED_ATTRIBUTES = ['content', 'layoutsubtree', 'popover'];
const MAX_RECONCILE_PASSES = 4;

/** @param {Node|null|undefined} n @returns {n is Element} */
const isElement = (n) => !!n && n.nodeType === 1;
/** @param {Node} n @returns {n is HTMLCanvasElement} */
const isCanvas = (n) => n.nodeType === 1 && /** @type {Element} */ (n).localName === 'canvas';
/** @param {Node} n @returns {Node|null} a shadow root continues at its host */
const parentOf = (n) => n.parentNode ?? (n.nodeType === 11 ? /** @type {ShadowRoot} */ (n).host : null);

/**
 * How the canvas asks to be managed: `content=drawable` wins over the legacy `layoutsubtree` attribute (API-CONTRACT section 3).
 * Reads attributes, never the `content` property, so it does not depend on the patch state.
 * @param {HicEnv} env
 * @param {HTMLCanvasElement} canvas
 * @returns {'drawable'|'legacy'|null}
 */
function activation(env, canvas) {
  const content = canvas.getAttribute('content');
  if (content !== null && content.toLowerCase() === 'drawable') return 'drawable';
  if (env.options.legacyNames && canvas.hasAttribute('layoutsubtree')) return 'legacy';
  return null;
}

/** @param {HTMLCanvasElement} canvas @returns {Scope|null} the tree scope, null for a detached tree */
function scopeOf(canvas) {
  const root = canvas.getRootNode();
  return root.nodeType === 9 || root.nodeType === 11 ? /** @type {Scope} */ (root) : null;
}

/**
 * @param {HicEnv} env
 * @param {number} id
 * @param {HTMLCanvasElement} canvas
 * @param {Scope} root
 * @param {boolean} legacy
 * @returns {CanvasRecord}
 */
function newRecord(env, id, canvas, root, legacy) {
  return {
    id, canvas, state: 'detached', legacy, root, layer: null, store: null,
    geometry: { byElement: new WeakMap(), order: [] },
    paint: { force: false, serial: 0, lastFireAt: 0, everFired: false, microtaskFrame: -1, waitingSince: null, gateReason: null, holdSince: null },
    frameCap: env.options.defaultFrameCap,
    contentBox: { width: 0, height: 0, gridScaleX: 1, gridScaleY: 1 },
    dpr: env.window.devicePixelRatio,
    offscreen: new Set(),
  };
}

/**
 * @param {HicEnv} env
 * @param {(env: HicEnv, record: CanvasRecord) => LiveLayer} createLiveLayer
 * @returns {CoreRegistry}
 */
export function createCanvasRegistry(env, createLiveLayer) {
  const win = /** @type {Window & typeof globalThis} */ (env.window);
  /** @type {Map<HTMLCanvasElement, CanvasRecord>} */
  const records = new Map();
  /** @type {Map<number, CanvasRecord>} */
  const byId = new Map();
  /** @type {Map<Scope, MutationObserver>} */
  const observers = new Map();
  /** @type {Map<CanvasRecord, number>} */
  const graceTimers = new Map();
  /** Canvases whose mount threw or that were refused: not retried on every mutation, only when the canvas is touched again (attribute change, ensure) or its tree is scanned again. */
  const failed = new WeakSet();
  let nextId = 1;
  let disposed = false;

  /** @param {CanvasRecord} record @param {CanvasRecord['state']} state */
  function setState(record, state) {
    const previous = record.state;
    if (previous === state) return;
    record.state = state;
    env.bus.emit(BUS.CANVAS_STATE, { record, state, previous });
  }

  /** @param {CanvasRecord} record */
  function clearGrace(record) {
    const timer = graceTimers.get(record);
    if (timer === undefined) return;
    win.clearTimeout(timer);
    graceTimers.delete(record);
  }

  /** @param {HTMLCanvasElement} canvas @returns {CanvasRecord} */
  function create(canvas) {
    const existing = records.get(canvas);
    if (existing) return existing;
    const record = newRecord(env, nextId++, canvas, scopeOf(canvas) ?? env.document, activation(env, canvas) === 'legacy');
    records.set(canvas, record);
    byId.set(record.id, record);
    return record;
  }

  /** Children back into the canvas, layer gone, the record stays in state 'detached'. @param {CanvasRecord} record */
  function unmount(record) {
    clearGrace(record);
    if (record.state === 'detached' || record.state === 'disposed') return;
    env.bus.emit(BUS.CANVAS_UNMOUNTING, { record });
    try { record.layer?.unmount(); } catch (err) { env.reporter.caught(err, 'registry.unmount'); }
    setState(record, 'detached');
  }

  /** @param {CanvasRecord} record */
  function remove(record) {
    if (record.state === 'disposed') return;
    unmount(record);
    try { record.layer?.dispose(); } catch (err) { env.reporter.caught(err, 'registry.layer-dispose'); }
    record.layer = null;
    records.delete(record.canvas);
    byId.delete(record.id);
    setState(record, 'disposed');
  }

  /** @param {CanvasRecord} record @returns {boolean} mounted */
  function mount(record) {
    setState(record, 'mounting');
    try {
      record.layer ??= createLiveLayer(env, record);
      record.layer.mount();
    } catch (err) {
      failed.add(record.canvas);
      env.reporter.caught(err, 'registry.mount');
      try { record.layer?.unmount(); } catch { /* the mount already failed; the first error is the one reported */ }
      setState(record, 'detached');
      return false;
    }
    setState(record, 'active');
    env.bus.emit(BUS.CANVAS_MOUNTED, { record });
    return true;
  }

  /** The canvas left the document: its layer goes with it (children are out of the document, as natively). @param {CanvasRecord} record */
  function suspend(record) {
    setState(record, 'suspended');
    record.layer?.element.remove();
    clearGrace(record);
    graceTimers.set(record, win.setTimeout(() => { graceTimers.delete(record); remove(record); }, SUSPEND_GRACE_MS));
  }

  /**
   * The canvas is connected, possibly moved. Same scope: the layer follows the canvas (it is a sibling, ADR-A). Another scope: anchor names and
   * sheets are tree-scoped, so the layer is rebuilt there and observers see an unmount followed by a mount.
   * @param {CanvasRecord} record @param {Scope} root @returns {boolean} changed
   */
  function rehome(record, root) {
    if (record.root !== root) {
      unmount(record);
      record.root = root;
      mount(record);
      return true;
    }
    const layerEl = record.layer?.element;
    if (layerEl && (!layerEl.isConnected || layerEl.parentNode !== record.canvas.parentNode)) {
      // The live layer owns re-homing: mount() on a mounted layer re-inserts it after the canvas and moves the parent facade (live notes).
      try { record.layer?.mount(); } catch (err) { env.reporter.caught(err, 'registry.rehome'); }
      if (!layerEl.isConnected || layerEl.parentNode !== record.canvas.parentNode) record.canvas.after(layerEl); // a layer that did not follow (stand-in layers, a failed mount)
      return true;
    }
    return false;
  }

  /**
   * Can a canvas of this scope be managed at all? An open shadow root nobody announced (a declarative root created by the parser or by setHTMLUnsafe) is adopted; a closed root
   * created before install cannot be observed.
   * @param {HTMLCanvasElement} canvas @param {Scope} root @returns {boolean}
   */
  function scopeUsable(canvas, root) {
    if (root.nodeType === 9 || observers.has(root) || !env.options.autoDiscover) return true;
    let known = false;
    try { known = env.roots.roots().includes(root); } catch { /* root scope unavailable: nothing is known */ }
    if (!known && /** @type {ShadowRoot} */ (root).mode === 'open') {
      try { env.roots.adopt(/** @type {ShadowRoot} */ (root)); known = env.roots.roots().includes(root); } catch { /* root scope unavailable */ }
    }
    if (known) { observe(root); return true; }
    if (!failed.has(canvas)) {
      failed.add(canvas);
      env.reporter.unsupported({
        feature: 'shadow-canvas',
        message: 'canvas inside a shadow root that is not observed (a closed root created before install())',
        hint: 'call installed.adoptRoot(shadowRoot) with the root you hold, or install the polyfill before the component attaches its shadow root',
      }, canvas);
    }
    return false;
  }

  /** @param {HTMLCanvasElement} canvas */
  function refusePopover(canvas) {
    failed.add(canvas);
    refusePopoverCanvas(env, canvas);
  }

  /**
   * One decision for one canvas from the current DOM state. Returns whether something changed (reconcileAll iterates to a fixpoint).
   * @param {HTMLCanvasElement} canvas
   * @returns {boolean}
   */
  function reconcile(canvas) {
    const record = records.get(canvas);
    const connected = canvas.isConnected && canvas.ownerDocument === env.document;
    if (!activation(env, canvas)) {
      if (!record) return false;
      if (record.state !== 'detached') { unmount(record); return true; }
      if (!connected) { remove(record); return true; }
      return false;
    }
    if (!connected) {
      if (!record) return false;
      if (record.state === 'active') { suspend(record); return true; }
      if (record.state === 'detached') { remove(record); return true; }
      return false;
    }
    const root = scopeOf(canvas);
    if (!root || !scopeUsable(canvas, root)) return false;
    if (canvas.hasAttribute('popover')) {
      if (record && record.state !== 'detached') { unmount(record); refusePopover(canvas); return true; }
      if (!failed.has(canvas)) refusePopover(canvas);
      return false;
    }
    // re-read: adopting the canvas's shadow root above scanned that root, which may have created the record already
    const rec = records.get(canvas) ?? create(canvas);
    rec.legacy = activation(env, canvas) === 'legacy';
    if (rec.legacy) warnLegacyOnce(env); // also for the attribute in the markup (the DOM-API paths warn in canvas-patch.js; once per install)
    switch (rec.state) {
      case 'detached': return !failed.has(canvas) && mount(rec);
      case 'suspended':
        clearGrace(rec);
        setState(rec, 'active');
        if (!rehome(rec, root)) { try { rec.layer?.mount(); } catch (err) { env.reporter.caught(err, 'registry.resume'); } }
        return true;
      case 'active': return rehome(rec, root);
      default: return false;
    }
  }

  function reconcileAll() {
    for (let pass = 0, changed = true; changed && pass < MAX_RECONCILE_PASSES; pass++) {
      changed = false;
      for (const canvas of [...records.keys()]) changed = reconcile(canvas) || changed;
    }
  }

  /** Canvases at or below an inserted node in tree order (outer before nested); the polyfill's own nodes are skipped. @param {Node} node @param {Set<HTMLCanvasElement>} into */
  function collectCanvases(node, into) {
    if (!isElement(node) || env.isManagedLayerNode(node)) return;
    if (isCanvas(node)) into.add(node);
    for (const c of node.querySelectorAll('canvas')) into.add(c);
  }

  /** @param {MutationRecord[]} list */
  function onMutations(list) {
    if (disposed) return;
    /** @type {Set<HTMLCanvasElement>} */
    const nominated = new Set();
    let removals = false;
    for (const m of list) {
      if (m.type === 'attributes') {
        if (isCanvas(m.target)) { nominated.add(m.target); failed.delete(m.target); }
        continue;
      }
      for (const n of m.addedNodes) collectCanvases(n, nominated);
      if (!removals) removals = Array.prototype.some.call(m.removedNodes, (/** @type {Node} */ n) => !(isElement(n) && env.isManagedLayerNode(n)));
    }
    let changed = false;
    for (const canvas of nominated) changed = reconcile(canvas) || changed;
    if (removals || changed) reconcileAll();
  }

  /** @param {Scope} root */
  function observe(root) {
    if (disposed || !env.options.autoDiscover || observers.has(root)) return;
    const observer = new win.MutationObserver(onMutations);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: WATCHED_ATTRIBUTES });
    observers.set(root, observer);
  }

  /** @param {ParentNode} [root] */
  function scan(root = env.document) {
    if (root.nodeType === 9 || root.nodeType === 11) observe(/** @type {Scope} */ (root));
    for (const canvas of root.querySelectorAll('canvas')) { failed.delete(canvas); reconcile(canvas); }
    reconcileAll();
  }

  /** @type {CoreRegistry['logicalCanvasAncestor']} */
  function logicalCanvasAncestor(node) {
    for (let n = parentOf(node); n; n = parentOf(n)) {
      if (!isElement(n)) continue;
      if (n.hasAttribute(MARK.LAYER_ATTR)) {
        const owner = byId.get(Number(n.getAttribute(MARK.LAYER_ATTR)));
        if (owner) return owner.canvas;
      } else if (isCanvas(n)) return n;
    }
    return null;
  }

  const offBus = env.bus.on(BUS.ROOT_ADDED, (/** @type {{root: ShadowRoot}} */ { root }) => scan(root));

  return {
    get: (canvas) => records.get(canvas),
    all() {
      const live = [...records.values()].filter((r) => r.state !== 'disposed');
      return live.sort((a, b) => shadowIncludingOrder(a.canvas, b.canvas));
    },
    ownerOfDrawable(el) {
      for (let node = /** @type {Node} */ (el); ;) {
        const canvas = logicalCanvasAncestor(node);
        if (!canvas) return undefined;
        const record = records.get(canvas);
        if (record && record.state !== 'detached') return record;
        node = canvas;
      }
    },
    logicalCanvasAncestor,
    create,
    setState,
    remove,
    scan,
    observe,
    ensure(canvas) {
      const known = records.get(canvas);
      if (known && known.state === 'active' && canvas.isConnected && activation(env, canvas) && !canvas.hasAttribute('popover')) return known;
      failed.delete(canvas);
      if (reconcile(canvas)) reconcileAll();
      return records.get(canvas);
    },
    dispose() {
      if (disposed) return;
      offBus();
      for (const observer of observers.values()) observer.disconnect();
      observers.clear();
      for (const record of [...records.values()]) remove(record);
      disposed = true;
    },
  };
}
