/**
 * Stylesheet invalidation: <style>/<link> mutations, adoptedStyleSheets, wrapped CSSStyleSheet/CSSStyleDeclaration methods, document.fonts.
 * Module: schedule (src/schedule/observers/*).
 */

import { BUS, MARK } from '../../contracts/events.js';

/** @typedef {import('../../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../../contracts/types.js').PatchLedger} PatchLedger */

const SHEET_METHODS = ['insertRule', 'deleteRule', 'replace', 'replaceSync', 'addRule', 'removeRule'];
const GROUPING_METHODS = ['insertRule', 'deleteRule', 'appendRule'];
const DECLARATION_METHODS = ['setProperty', 'removeProperty'];
const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * A change -> store.invalidateAll("stylesheet") and whole-canvas 'stylesheet' damage; wrappers go through the ledger of api/patch.js. Sheets, rules and style declarations that belong to the polyfill
 * (RootScope style handles, GeometryRules.owns) are IGNORED: geometry rule updates never invalidate the CSS bundle. Observes the document and every shadow root of env.roots (per-root adoptedStyleSheets,
 * <style>/<link> mutations and load events). Changes are coalesced per microtask: a CSS-in-JS burst of 500 insertRule calls invalidates once.
 * `adoptedStyleSheets.push()` / splice on the live ObservableArray call no setter: the getter returns a cached proxy of the live array that reports every write (optimization 6, no poll).
 * @param {HicEnv} env
 * @param {PatchLedger} ledger
 * @returns {() => void}
 */
export function observeStylesheets(env, ledger) {
  const win = /** @type {Window & typeof globalThis} */ (env.window);
  /** @type {Array<() => void>} */
  const stops = [];
  /** @type {Map<Document|ShadowRoot, () => void>} */
  const rootStops = new Map();
  /** @type {WeakMap<Document|ShadowRoot, CSSStyleSheet[]>} */
  const adopted = new WeakMap();
  /** @type {WeakSet<CSSStyleSheet>} */
  const ownedSheets = new WeakSet();
  let pending = false;
  let checkingOwner = false;
  let live = true;

  function bump() {
    if (!live) return;
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      if (live) apply();
    });
  }

  function apply() {
    try {
      env.store.invalidateAll('stylesheet');
    } catch (err) {
      env.reporter.caught(err, 'stylesheet.invalidate');
    }
    for (const record of env.registry.all()) env.scheduler.damage(record, 'stylesheet', null, null);
  }

  /** @param {CSSStyleSheet} sheet @returns {boolean} true for sheets the polyfill created */
  function owns(sheet) {
    if (ownedSheets.has(sheet)) return true;
    const node = sheet.ownerNode;
    if (node) return env.isManagedLayerNode(/** @type {Element} */ (node)) || /** @type {Element} */ (node).id === MARK.STYLE_ID;
    if (checkingOwner) return true;
    checkingOwner = true;
    try {
      for (const root of new Set(env.registry.all().map((r) => r.root))) {
        const handle = env.roots.style(root);
        try {
          if (handle.geometry.owns(sheet)) {
            ownedSheets.add(sheet);
            return true;
          }
        } finally {
          handle.dispose();
        }
      }
    } finally {
      checkingOwner = false;
    }
    return false;
  }

  /** The sheet an API receiver belongs to, null for receivers that are not part of a stylesheet (element.style). @param {any} self */
  function sheetOf(self) {
    if (!self) return null;
    if (self.cssRules && 'ownerRule' in self) return self;
    if (self.parentStyleSheet) return self.parentStyleSheet;
    return self.parentRule?.parentStyleSheet ?? null;
  }

  /** @param {any} self */
  function touch(self) {
    const sheet = sheetOf(self);
    if (sheet && !owns(sheet)) bump();
  }

  function wrapMethod(/** @type {any} */ proto, /** @type {string} */ key, /** @type {(self: any) => void} */ after) {
    if (!proto || typeof proto[key] !== 'function') return;
    try {
      ledger.wrap(proto, key, (original) => /** @this {any} */ function (/** @type {any} */ ...args) {
        const result = Reflect.apply(original, this, args);
        if (result && typeof result.then === 'function') result.then(() => after(this), () => {});
        else after(this);
        return result;
      });
    } catch (err) {
      env.reporter.caught(err, `stylesheet.wrap.${key}`);
    }
  }

  function wrapAccessor(/** @type {any} */ proto, /** @type {string} */ key, /** @type {(self: any) => void} */ after) {
    const d = proto && Object.getOwnPropertyDescriptor(proto, key);
    if (!d?.set) return;
    const { set } = d;
    try {
      ledger.define(proto, key, { ...d, set(/** @type {unknown} */ value) { set.call(this, value); after(this); } });
    } catch (err) {
      env.reporter.caught(err, `stylesheet.define.${key}`);
    }
  }

  /** @param {Document|ShadowRoot} root */
  function authorSheets(root) {
    return Array.from(root.adoptedStyleSheets ?? []).filter((s) => !owns(s));
  }

  /** @param {Document|ShadowRoot} root */
  function checkAdopted(root) {
    const now = authorSheets(root);
    const before = adopted.get(root);
    adopted.set(root, now);
    if (before && (before.length !== now.length || before.some((s, i) => s !== now[i]))) bump();
  }

  function installWrappers() {
    const proto = (/** @type {string} */ name) => /** @type {any} */ (win)[name]?.prototype;
    for (const key of SHEET_METHODS) wrapMethod(proto('CSSStyleSheet'), key, touch);
    for (const key of GROUPING_METHODS) wrapMethod(proto('CSSGroupingRule'), key, touch);
    wrapMethod(proto('CSSKeyframesRule'), 'appendRule', touch);
    wrapMethod(proto('CSSKeyframesRule'), 'deleteRule', touch);
    for (const key of DECLARATION_METHODS) wrapMethod(proto('CSSStyleDeclaration'), key, touch);
    wrapAccessor(proto('CSSStyleDeclaration'), 'cssText', touch);
    wrapAccessor(proto('StyleSheet'), 'disabled', touch);
    for (const name of ['Document', 'ShadowRoot']) {
      wrapAccessor(proto(name), 'adoptedStyleSheets', (self) => checkAdopted(self));
      watchAdoptedInPlace(proto(name));
    }
  }

  /** @type {WeakMap<object, object>} live adoptedStyleSheets array -> its reporting proxy (one per array: identity is stable) */
  const proxies = new WeakMap();
  /** @type {Set<Document|ShadowRoot>} roots whose adopted list changed in place this microtask */
  const changedRoots = new Set();

  /**
   * The adoptedStyleSheets array is mutable in place (push/splice, no setter call): the getter returns a proxy of the live array that reports every write of its owner
   * (replaces the 1 s compare poll, optimization 6). Reads, iteration and the native setter see the live array through the proxy.
   * @param {any} p
   */
  function watchAdoptedInPlace(p) {
    const d = p && Object.getOwnPropertyDescriptor(p, 'adoptedStyleSheets');
    if (!d?.get || typeof Proxy !== 'function') return;
    const current = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(p, 'adoptedStyleSheets'));
    const get = /** @type {() => any} */ (current.get);
    const changed = (/** @type {Document|ShadowRoot} */ root) => {
      if (!changedRoots.size) queueMicrotask(() => { const roots = [...changedRoots]; changedRoots.clear(); for (const r of roots) checkAdopted(r); });
      changedRoots.add(root);
    };
    try {
      ledger.define(p, 'adoptedStyleSheets', {
        ...current,
        /** @this {Document|ShadowRoot} */
        get() {
          const live = get.call(this);
          if (!live || typeof live !== 'object') return live;
          const known = proxies.get(live);
          if (known) return known;
          const root = this;
          const proxy = new Proxy(live, {
            set(t, k, v) { const ok = Reflect.set(t, k, v); changed(root); return ok; },
            deleteProperty(t, k) { const ok = Reflect.deleteProperty(t, k); changed(root); return ok; },
          });
          proxies.set(live, proxy);
          return proxy;
        },
      });
    } catch (err) {
      env.reporter.caught(err, 'stylesheet.adopted-in-place');
    }
  }

  /** @param {Node} node */
  function isSheetNode(node) {
    if (node.nodeType !== 1) return false;
    const el = /** @type {Element} */ (node);
    if (env.isManagedLayerNode(el) || el.id === MARK.STYLE_ID) return false;
    return el.nodeName === 'STYLE' || (el.nodeName === 'LINK' && /stylesheet/i.test(el.getAttribute('rel') ?? ''));
  }

  /** @param {Node} node */
  function carriesSheet(node) {
    if (isSheetNode(node)) return true;
    return node.nodeType === 1 && !!/** @type {Element} */ (node).firstElementChild && !!/** @type {Element} */ (node).querySelector('style,link[rel~="stylesheet"]');
  }

  /** @param {MutationRecord[]} batch */
  function onMutations(batch) {
    for (const m of batch) {
      if (m.type === 'childList') {
        const inStyle = m.target.nodeName === 'STYLE' && !isManagedParent(m.target);
        if (inStyle || [...m.addedNodes, ...m.removedNodes].some(carriesSheet)) return bump();
      } else if (m.type === 'characterData') {
        const parent = m.target.parentNode;
        if (parent?.nodeName === 'STYLE' && !isManagedParent(parent)) return bump();
      } else if (isSheetNode(m.target)) return bump();
    }
  }

  /** @param {Node} node */
  function isManagedParent(node) {
    return node.nodeType === 1 && (env.isManagedLayerNode(/** @type {Element} */ (node)) || /** @type {Element} */ (node).id === MARK.STYLE_ID);
  }

  /** @param {Event} ev */
  function onSheetLoad(ev) {
    if (/** @type {Node|null} */ (ev.target)?.nodeName === 'LINK' && isSheetNode(/** @type {Node} */ (ev.target))) bump();
  }

  /** @param {Document|ShadowRoot} root */
  function watchRoot(root) {
    if (rootStops.has(root)) return;
    const mo = new win.MutationObserver(onMutations);
    mo.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['media', 'disabled', 'href', 'rel'] });
    root.addEventListener('load', onSheetLoad, true);
    root.addEventListener('error', onSheetLoad, true);
    adopted.set(root, authorSheets(root));
    rootStops.set(root, () => {
      mo.disconnect();
      root.removeEventListener('load', onSheetLoad, true);
      root.removeEventListener('error', onSheetLoad, true);
    });
  }

  function watchAllRoots() {
    for (const root of env.roots?.roots() ?? [env.document]) watchRoot(root);
  }

  installWrappers();
  watchAllRoots();
  stops.push(env.bus.on(BUS.ROOT_ADDED, (/** @type {{root: ShadowRoot}} */ e) => watchRoot(e.root)));

  const fonts = env.document.fonts;
  fonts?.addEventListener?.('loadingdone', bump);
  const scheme = win.matchMedia?.(DARK_QUERY);
  scheme?.addEventListener?.('change', bump);

  return () => {
    live = false;
    for (const stop of stops) stop();
    for (const stop of rootStops.values()) stop();
    rootStops.clear();
    fonts?.removeEventListener?.('loadingdone', bump);
    scheme?.removeEventListener?.('change', bump);
  };
}
