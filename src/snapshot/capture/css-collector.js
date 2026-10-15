/**
 * Collects and flattens the page CSS for a clone (cached by CssBundle.key).
 * Module: snapshot-capture (src/snapshot/capture/*).
 */

import { inlineCssUrls, resolveResource } from './inline-resources.js';
import { engineSkins } from './engine-skins.js';
import {
  detectPseudos, dropUnclonableSelectors, parseRules, rewriteLinkPseudos, rewriteCanvasSelectors, rewriteHostSelectors, rewriteInteractionPseudos, rewriteRootSelectors, rewriteViewportUnits, serializeRules,
} from './css-rewrite.js';

/** @typedef {import('../../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../../contracts/types.js').CssBundle} CssBundle */
/** @typedef {import('../../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../../contracts/types.js').ResourceCache} ResourceCache */
/** @typedef {import('./css-rewrite.js').RuleNode} RuleNode */

/**
 * @typedef {Object} CssCollector
 * @property {(record: CanvasRecord, resources: ResourceCache) => CssBundle} bundle
 * @property {() => void} invalidate  stylesheet epoch changed
 */

/**
 * Rules every clone gets first: bars are painted by the polyfill, animations are frozen by value, ancestors' own pseudo-elements and the UA focus ring. The rules for the
 * controls the engines bundle paints on Gecko / WebKit (EngineSkins.css) follow them when that bundle is registered.
 */
const BASE_CSS = [
  '*{scrollbar-width:none!important;animation:none!important;transition:none!important}',
  '*::-webkit-scrollbar{display:none!important}',
  ':where(.hic-focus-visible){outline:-webkit-focus-ring-color auto 1px}',
  // UA link look, which the inert clone document does not apply (no URL, so no :any-link); one tag of specificity, first in the sheet: any author rule wins
  'a:where([href]){color:-webkit-link;text-decoration:underline}',
  // pruned sibling stand-ins (clone.js spacerFor): their box is fixed, only the width/height differ per element; the tripled attribute outranks author rules
  '[data-hic-sp][data-hic-sp][data-hic-sp]{box-sizing:border-box!important;min-width:0!important;min-height:0!important;max-width:none!important;max-height:none!important;flex:none!important;overflow:hidden!important;contain:strict!important;visibility:hidden!important}',
  '[data-hic-shell]::before,[data-hic-shell]::after{content:none!important;display:none!important}',
].join('\n');

/** @returns {string} the engines bundle's rules for the controls it paints ('' without it: on Chromium nothing carries those attributes) */
const engineCss = () => (engineSkins()?.css ? '\n' + engineSkins()?.css : '');

/** @param {string} dataUrl @returns {string} text of a text/css data: URL */
function textOfDataUrl(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const head = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  if (!head.includes(';base64')) return decodeURIComponent(body);
  const bin = atob(body);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/**
 * Evaluate `@media` blocks nested inside style rules (CSS nesting): the SVG image has its own viewport, so they cannot stay.
 * @param {string} css
 * @param {(query: string) => boolean} matches
 * @returns {string}
 */
function flattenNestedMedia(css, matches) {
  /** @param {RuleNode[]} nodes @returns {RuleNode[]} */
  const walk = (nodes) => {
    /** @type {RuleNode[]} */
    const out = [];
    for (const n of nodes) {
      if (n.k === 'group' && /^\s*@media/i.test(n.pre)) {
        if (matches(n.pre.replace(/^\s*@media/i, '').trim())) out.push(...walk(n.kids ?? []));
      } else if (n.k === 'group') out.push({ ...n, kids: walk(n.kids ?? []) });
      else if (n.k === 'style' && n.body.includes('@media')) out.push({ ...n, body: flattenNestedMedia(n.body, matches) });
      else out.push(n);
    }
    return out;
  };
  return serializeRules(walk(parseRules(css)));
}

/**
 * Walk document.styleSheets + adoptedStyleSheets (imports followed), evaluate @media with matchMedia, rewrite via css-rewrite.js, inline url()s via the ResourceCache.
 * @param {HicEnv} env
 * @returns {CssCollector}
 */
export function createCssCollector(env) {
  const win = env.window;
  /** What the canvas-naming selectors were rewritten for: they match `canvas.matches(compound)`, so a class/id/attribute change of the canvas outdates the bundle. @param {HTMLCanvasElement} canvas */
  const canvasIdentity = (canvas) => `${canvas.id}.${canvas.getAttribute('class') ?? ''}.${canvas.getAttribute('lang') ?? ''}.${canvas.getAttribute('dir') ?? ''}`;
  const doc = env.document;
  /** @type {Map<number, {key: string, bundle: CssBundle}>} */
  const cache = new Map();
  /** @type {WeakSet<ResourceCache>} */
  const watched = new WeakSet();
  let epoch = 0;
  let ready = 0;
  const dark = win.matchMedia('(prefers-color-scheme: dark)');
  const reduced = win.matchMedia('(prefers-reduced-motion: reduce)');

  /** @param {string} q @returns {boolean} */
  const matches = (q) => { try { return !q.trim() || win.matchMedia(q).matches; } catch { return false; } };

  /** @param {CSSStyleSheet} sheet @returns {boolean} the polyfill's own layer/geometry sheet */
  const isOwnSheet = (sheet) => {
    const owner = /** @type {Element|null} */ (sheet.ownerNode);
    if (owner) return env.isManagedLayerNode(owner);
    try { return /hic-layer|\[data-hic/.test(sheet.cssRules[0]?.cssText ?? ''); } catch { return false; }
  };

  /**
   * @param {CSSRuleList} rules
   * @param {string[]} out
   */
  const walk = (rules, out) => {
    for (const r of Array.from(rules)) {
      if (r instanceof CSSStyleRule) out.push(r.cssText.includes('@media') ? flattenNestedMedia(r.cssText, matches) : r.cssText);
      else if (r instanceof CSSMediaRule) { if (matches(r.media.mediaText)) walk(r.cssRules, out); } else if (r instanceof CSSSupportsRule) { if (CSS.supports(r.conditionText)) walk(r.cssRules, out); } else if (r instanceof CSSImportRule) {
        if (!r.styleSheet || !matches(r.media.mediaText) || (r.supportsText && !CSS.supports(r.supportsText))) continue;
        const inner = /** @type {string[]} */ ([]);
        try { walk(r.styleSheet.cssRules, inner); } catch { continue; }
        const layer = r.layerName;
        out.push(layer === null ? inner.join('\n') : `@layer${layer ? ' ' + layer : ''}{${inner.join('\n')}}`);
      } else if (r instanceof CSSPageRule || r instanceof CSSNamespaceRule) continue;
      else if (r instanceof CSSGroupingRule) {
        out.push(r.cssText.slice(0, r.cssText.indexOf('{')) + '{');
        walk(r.cssRules, out);
        out.push('}');
      } else out.push(r.cssText);
    }
  };

  /** @param {CanvasRecord} record @returns {CSSStyleSheet[]} */
  const sheetsOf = (record) => {
    const roots = [doc, ...(record.root && record.root !== doc ? [record.root] : [])];
    const all = [];
    for (const root of roots) all.push(...Array.from(root.styleSheets), ...root.adoptedStyleSheets);
    return [...new Set(all)].filter((s) => !s.disabled && !isOwnSheet(s) && matches(s.media.mediaText));
  };

  /**
   * CSS text of one sheet, or null when it cannot be read (pending or refused).
   * @param {CSSStyleSheet} sheet @param {ResourceCache} resources @param {CanvasRecord} record @param {string[]} pending
   * @returns {string|null}
   */
  const textOfSheet = (sheet, resources, record, pending) => {
    const parts = /** @type {string[]} */ ([]);
    const base = sheet.href ?? doc.baseURI;
    let inlined;
    try {
      walk(sheet.cssRules, parts);
      inlined = inlineCssUrls(parts.join('\n'), base, resources);
    } catch {
      const r = resolveResource(resources, sheet.href ?? '', 'css');
      if (r.state === 'pending') { pending.push(sheet.href ?? ''); return null; }
      if (r.state === 'failed') {
        env.reporter.unsupported({ feature: r.error.feature, message: r.error.message, hint: r.error.hint, path: r.error.path }, record.canvas);
        return null;
      }
      const constructed = new CSSStyleSheet();
      constructed.replaceSync(inlineCssUrls(textOfDataUrl(r.url), base, resources).css);
      parts.length = 0;
      walk(constructed.cssRules, parts);
      inlined = inlineCssUrls(parts.join('\n'), base, resources);
    }
    pending.push(...inlined.pending);
    for (const f of inlined.failed) env.reporter.unsupported({ feature: f.error.feature, message: f.error.message, hint: f.error.hint, path: f.url }, record.canvas);
    return inlined.css;
  };

  return {
    bundle(record, resources) {
      if (!watched.has(resources)) { watched.add(resources); resources.onReady(() => { ready++; }); }
      const key = [epoch, ready, record.id, win.innerWidth, win.innerHeight, win.devicePixelRatio, canvasIdentity(record.canvas), dark.matches ? 'd' : 'l', reduced.matches ? 'r' : 'n', doc.styleSheets.length, doc.adoptedStyleSheets.length,
        record.root === doc ? '' : 'shadow', engineCss() ? 'e' : ''].join('|');
      const hit = cache.get(record.id);
      if (hit && hit.key === key) return hit.bundle;
      /** @type {string[]} */
      const pending = [];
      const raw = [];
      for (const sheet of sheetsOf(record)) {
        const text = textOfSheet(sheet, resources, record, pending);
        if (text) raw.push(text);
      }
      const joined = raw.join('\n');
      let css = rewriteViewportUnits(joined, { width: win.innerWidth, height: win.innerHeight });
      css = rewriteLinkPseudos(rewriteInteractionPseudos(rewriteRootSelectors(css)));
      css = rewriteCanvasSelectors(dropUnclonableSelectors(css), record.canvas);
      if (record.root !== doc) css = rewriteHostSelectors(css);
      /** @type {CssBundle} */
      const bundle = { css: BASE_CSS + engineCss() + '\n' + css, key, pseudo: detectPseudos(joined), pendingUrls: [...new Set(pending)] };
      cache.set(record.id, { key, bundle });
      return bundle;
    },
    invalidate() { epoch++; },
  };
}
