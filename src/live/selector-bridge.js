/**
 * Selector bridge: document-level query wrappers + mirrored stylesheet. The pure rewriter lives in util/selector-rewrite.js (shared with the snapshot clone) and is re-exported here.
 * Module: live (src/live/*).
 */

import { BUS } from '../contracts/events.js';
import { isLayerElement, nativeDom } from './drawables.js';
import { isOwnedSheet, markOwnedSheet } from './geometry-sheet.js';
import { compoundSpec, padReplacement, rewriteSelectorForCanvas } from '../util/selector-rewrite.js';

/** @typedef {import('../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../contracts/types.js').PatchLedger} PatchLedger */

export { compoundSpec, padReplacement, rewriteSelectorForCanvas };

/** @param {number} id @returns {string} */
const layerSelector = (id) => `hic-layer[data-hic-layer="${id}"]`;

// ---------------------------------------------------------------------------------------------- structural twins
/** Every sibling that is not a live layer: `:where` keeps the specificity of the structural pseudo-class unchanged. */
const NOT_LAYER = ':not(:where(hic-layer))';
const STRUCTURAL = /:(last-child|only-child|nth-last-child)\b/;

/** @param {string} selector @returns {string[]} the members of a selector list (top-level commas only) */
function splitList(selector) {
  /** @type {string[]} */
  const parts = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) { parts.push(selector.slice(start, i)); start = i + 1; }
  }
  parts.push(selector.slice(start));
  return parts.map((p) => p.trim());
}

/**
 * PURE. For every member of a selector list that counts siblings from the END (`:last-child`, `:only-child`, `:nth-last-child(an+b)`): the member made blind to the live layer, which follows its canvas
 * as an extra sibling (the original no longer matches the canvas, the twin does), and `relaxed`, the member with those pseudo-classes replaced by `:is(*)`: it matches wherever the twin could.
 * @param {string} selectorList
 * @returns {Array<{twin: string, relaxed: string}>}
 */
export function structuralTwins(selectorList) {
  if (!STRUCTURAL.test(selectorList)) return [];
  return splitList(selectorList).filter((s) => STRUCTURAL.test(s)).map((s) => ({
    twin: s
      .replace(/:last-child\b/g, `:nth-last-child(1 of ${NOT_LAYER})`)
      .replace(/:only-child\b/g, `:not(:nth-child(n+2 of ${NOT_LAYER}), :nth-last-child(n+2 of ${NOT_LAYER}))`)
      .replace(/:nth-last-child\(\s*([^()]*?)\s*\)/g, (all, arg) => (/\bof\b/.test(arg) ? all : `:nth-last-child(${arg} of ${NOT_LAYER})`)),
    relaxed: s.replace(/:(?:last-child|only-child)\b/g, ':is(*)').replace(/:nth-last-child\(\s*[^()]*?\s*\)/g, ':is(*)'),
  }));
}

// ---------------------------------------------------------------------------------------------- mirrored stylesheet
/** @param {CSSRule} rule @returns {rule is CSSStyleRule} */
const isStyleRule = (rule) => 'selectorText' in rule && 'style' in rule;

/** @typedef {(el: Element, selector: string) => boolean} Matcher  Element.prototype.matches as it was before the bridge wrapped it */

/**
 * The rule re-aimed at the canvas through its structural twins. A twin is kept when its relaxed form selects the canvas (whether the canvas is the last child NOW is the browser's business, so the sheet needs no rebuild when siblings change).
 * @param {CSSStyleRule} rule @param {Element} canvas @param {Matcher} matches @returns {string|null}
 */
function twinRule(rule, canvas, matches) {
  if (!rule.style.length) return null;
  const twins = structuralTwins(rule.selectorText).filter(({ relaxed }) => {
    try { return matches(canvas, relaxed); } catch { return false; }
  });
  return twins.length ? `${twins.map((t) => t.twin).join(', ')}{${rule.style.cssText}}` : null;
}

/** @param {CSSRuleList} rules @param {Element} canvas @param {string} replacement @param {string[]} out @param {Matcher} matches */
function mirrorRules(rules, canvas, replacement, out, matches) {
  for (const rule of rules) {
    if (isStyleRule(rule)) {
      const rewritten = rewriteSelectorForCanvas(rule.selectorText, canvas, replacement);
      if (rewritten && rule.style.length) out.push(`${rewritten}{${rule.style.cssText}}`);
      const twin = twinRule(rule, canvas, matches);
      if (twin) out.push(twin);
    } else if ('styleSheet' in rule && rule.styleSheet) {
      mirrorSheet(/** @type {CSSStyleSheet} */ (rule.styleSheet), canvas, replacement, out, matches);
    } else if ('cssRules' in rule && rule.cssRules) {
      const inner = /** @type {string[]} */ ([]);
      mirrorRules(/** @type {CSSRuleList} */ (rule.cssRules), canvas, replacement, inner, matches);
      if (inner.length) out.push(`${rule.cssText.slice(0, rule.cssText.indexOf('{'))}{${inner.join('\n')}}`);
    }
  }
}

/** @param {CSSStyleSheet} sheet @param {Element} canvas @param {string} replacement @param {string[]} out @param {Matcher} matches */
function mirrorSheet(sheet, canvas, replacement, out, matches) {
  if (sheet.disabled || isOwnedSheet(sheet)) return;
  /** @type {CSSRuleList} */
  let rules;
  try { rules = sheet.cssRules; } catch { return; /* cross-origin sheet */ }
  const inner = /** @type {string[]} */ ([]);
  mirrorRules(rules, canvas, replacement, inner, matches);
  const media = sheet.media?.mediaText;
  if (inner.length) out.push(media ? `@media ${media}{${inner.join('\n')}}` : inner.join('\n'));
}

/**
 * Mirror every style rule whose selector has a canvas-matching compound with `[data-hic-layer="id"]` substituted (cached per stylesheet epoch by the caller).
 * @param {CSSStyleSheet[]} sheets
 * @param {Element} canvas
 * @param {string} replacement
 * @param {Matcher} [matches]  the platform `matches` (the default is the current one: the bridge passes the one from before it wrapped it)
 * @returns {string}
 */
export function buildMirroredCss(sheets, canvas, replacement, matches = (el, selector) => el.matches(selector)) {
  /** @type {string[]} */
  const out = [];
  for (const sheet of sheets) mirrorSheet(sheet, canvas, replacement, out, matches);
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------- installed bridge
const QUERY_GATE = /[\s>]/;
const OWN_ATTRS = new Set(['data-hic-canvas', 'aria-owns']);

/** @param {Node} a @param {Node} b @returns {number} document order comparator */
const byDocumentOrder = (a, b) => (a === b ? 0 : (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));

/** @template T @param {T[]} items @returns {T[] & {item: (i: number) => T|null}} */
const withItem = (items) => Object.assign(items, { item(/** @type {number} */ i) { return items[i] ?? null; } });

/**
 * Wrap Document/Element querySelector[All], matches, closest when options.selectorBridge is queries|both; keep the css mirror adopted sheet in sync when css|both. Returns the remover (uses the ledger of api/patch.js).
 * Results of rewritten selectors are unioned with the native ones; a union of several results is an Array with item() (not a live or native NodeList).
 * @param {HicEnv} env
 * @param {PatchLedger} ledger
 * @returns {() => void}
 */
export function installSelectorBridge(env, ledger) {
  const mode = env.options.selectorBridge;
  if (mode === 'off') return () => {};
  let live = true;
  let bypass = false;
  let epoch = 0;
  /** @type {Map<string, string[]>} */
  const cache = new Map();
  const mounted = () => env.registry.all().filter((r) => r.layer?.isMounted());
  const platformMatches = /** @type {Function} */ (/** @type {any} */ (env.window).Element.prototype.matches);
  const mirror = mode === 'css' || mode === 'both' ? createMirror(env, mounted, (el, selector) => Reflect.apply(platformMatches, el, [selector])) : null;
  const watcher = watchCanvases(env, mounted, () => { epoch++; cache.clear(); mirror?.schedule(); });

  /** Rewritten selectors, one per canvas where the rewrite changed something. */
  function rewrites(/** @type {string} */ selector) {
    if (bypass || !live || !QUERY_GATE.test(selector)) return [];
    const records = mounted();
    if (!records.length) return [];
    const key = `${epoch}|${records.map((r) => r.id).join(',')}|${selector}`;
    const hit = cache.get(key);
    if (hit) return hit;
    bypass = true;
    /** @type {string[]} */
    const out = [];
    try {
      for (const r of records) {
        const rewritten = rewriteSelectorForCanvas(selector, r.canvas, layerSelector(r.id));
        if (rewritten) out.push(rewritten);
      }
    } finally { bypass = false; }
    if (cache.size > 400) cache.clear();
    cache.set(key, out);
    return out;
  }

  if (mode === 'queries' || mode === 'both') installQueries(env.window, ledger, rewrites, () => live && !bypass, mounted);
  return () => {
    live = false;
    watcher();
    mirror?.dispose();
  };
}

/**
 * @param {Window} win
 * @param {PatchLedger} ledger
 * @param {(selector: string) => string[]} rewrites
 * @param {() => boolean} on
 * @param {() => CanvasRecord[]} records
 */
function installQueries(win, ledger, rewrites, on, records) {
  const w = /** @type {any} */ (win);
  for (const proto of [w.Document.prototype, w.DocumentFragment.prototype, w.Element.prototype]) {
    ledger.wrap(proto, 'querySelectorAll', (original) => /** @this {ParentNode} */ function querySelectorAll(/** @type {string} */ selector) {
      const base = original.call(this, selector);
      if (!on()) return base;
      const extra = rewrites(String(selector));
      if (!extra.length) return base;
      /** @type {Set<Element>} */
      const found = new Set(base);
      for (const rewritten of extra) for (const el of original.call(this, rewritten)) found.add(el);
      return found.size === base.length ? base : withItem([...found].sort(byDocumentOrder));
    });
    ledger.wrap(proto, 'querySelector', (original) => /** @this {ParentNode} */ function querySelector(/** @type {string} */ selector) {
      const base = original.call(this, selector);
      if (!on()) return base;
      let best = base;
      for (const rewritten of rewrites(String(selector))) {
        const candidate = original.call(this, rewritten);
        if (candidate && (!best || byDocumentOrder(candidate, best) < 0)) best = candidate;
      }
      return best;
    });
  }
  ledger.wrap(w.Element.prototype, 'matches', (original) => /** @this {Element} */ function matches(/** @type {string} */ selector) {
    if (original.call(this, selector)) return true;
    return on() && rewrites(String(selector)).some((rewritten) => original.call(this, rewritten));
  });
  ledger.wrap(w.Element.prototype, 'closest', (original) => /** @this {Element} */ function closest(/** @type {string} */ selector) {
    const base = original.call(this, selector);
    return on() ? closestThroughLayer(this, String(selector), base, original, rewrites, records()) : base;
  });
}

/** @param {Element} el @param {CanvasRecord[]} records @returns {CanvasRecord|null} record of the nearest managed layer above el */
function recordAbove(el, records) {
  const parentOf = nativeDom().parentNode;
  for (let cur = parentOf.call(el); cur && cur.nodeType === 1; cur = parentOf.call(cur)) {
    if (isLayerElement(/** @type {Element} */ (cur))) return records.find((r) => r.layer?.element === cur) ?? null;
  }
  return null;
}

/**
 * closest() for an element inside a layer: the canvas takes the layer's place in the ancestor chain, and rewritten selectors reach canvas-as-ancestor patterns.
 * @param {Element} el
 * @param {string} selector
 * @param {Element|null} base  native result
 * @param {Function} original  the native closest
 * @param {(selector: string) => string[]} rewrites
 * @param {CanvasRecord[]} records
 * @returns {Element|null}
 */
function closestThroughLayer(el, selector, base, original, rewrites, records) {
  const record = recordAbove(el, records);
  if (!record) return base;
  const layer = /** @type {Element} */ (record.layer?.element);
  const candidates = [layer.contains(base) && base !== layer ? base : /** @type {Element|null} */ (original.call(record.canvas, selector))];
  for (const rewritten of rewrites(selector)) candidates.push(original.call(el, rewritten));
  /** @type {Element|null} */
  let best = null;
  for (const c of candidates) if (c && (!best || best.contains(c))) best = c;
  return best;
}

/**
 * Observe the attributes of every mounted canvas (class, id, lang, dir, data-*: they decide which compounds match the canvas) and report a change.
 * @param {HicEnv} env
 * @param {() => CanvasRecord[]} mounted
 * @param {() => void} changed
 * @returns {() => void}
 */
function watchCanvases(env, mounted, changed) {
  const observer = new MutationObserver((records) => {
    if (records.some((r) => !OWN_ATTRS.has(/** @type {string} */ (r.attributeName)))) changed();
  });
  const refresh = () => {
    observer.disconnect();
    for (const r of mounted()) observer.observe(r.canvas, { attributes: true });
    changed();
  };
  const offs = [env.bus.on(BUS.CANVAS_MOUNTED, refresh), env.bus.on(BUS.CANVAS_UNMOUNTING, () => queueMicrotask(refresh))];
  refresh();
  return () => { observer.disconnect(); for (const off of offs) off(); };
}

/**
 * Keep an adopted, polyfill-owned sheet per tree scope in sync with the mirrored rules of the canvases of that scope.
 * @param {HicEnv} env
 * @param {() => CanvasRecord[]} mounted
 * @param {Matcher} matches
 * @returns {{schedule: () => void, dispose: () => void}}
 */
function createMirror(env, mounted, matches) {
  /** @type {Map<Document|ShadowRoot, CSSStyleSheet>} */
  const sheets = new Map();
  let queued = false;
  let live = true;

  function schedule() {
    if (queued || !live) return;
    queued = true;
    queueMicrotask(() => { queued = false; if (live) rebuild(); });
  }

  /** @param {Document|ShadowRoot} root @returns {CSSStyleSheet[]} author sheets of the scope */
  function authorSheets(root) {
    return [...root.styleSheets, ...root.adoptedStyleSheets].filter((s) => !isOwnedSheet(s));
  }

  function rebuild() {
    const records = mounted();
    for (const root of new Set([...sheets.keys(), ...records.map((r) => r.root)])) {
      const mine = records.filter((r) => r.root === root);
      const css = mine.map((r) => buildMirroredCss(authorSheets(root), r.canvas, layerSelector(r.id), matches)).filter(Boolean).join('\n');
      let sheet = sheets.get(root);
      if (!css && !sheet) continue;
      if (!sheet) {
        sheet = markOwnedSheet(new (/** @type {any} */ (env.window)).CSSStyleSheet());
        sheets.set(root, sheet);
        root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      }
      sheet.replaceSync(css);
      if (!mine.length) dropSheet(root, sheet);
    }
  }

  /** @param {Document|ShadowRoot} root @param {CSSStyleSheet} sheet */
  function dropSheet(root, sheet) {
    root.adoptedStyleSheets = root.adoptedStyleSheets.filter((s) => s !== sheet);
    sheets.delete(root);
  }

  const offs = [
    env.bus.on(BUS.DAMAGE, (d) => { if (d?.cause === 'stylesheet') schedule(); }),
    env.bus.on(BUS.ROOT_ADDED, schedule),
  ];
  return {
    schedule,
    dispose() {
      live = false;
      for (const off of offs) off();
      for (const [root, sheet] of [...sheets]) dropSheet(root, sheet);
    },
  };
}
