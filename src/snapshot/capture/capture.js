/**
 * CaptureFn: synchronous clone + css + serialise + encode of one drawable crop.
 * Module: snapshot-capture (src/snapshot/capture/*).
 */

import { BUS } from '../../contracts/events.js';
import { intersectRect } from '../../util/rect.js';
import { evaluateBudget } from './budget.js';
import { BudgetExceeded, cloneDrawable } from './clone.js';
import { createCssCollector } from './css-collector.js';
import { hasStructuralSelectors, shakeCss } from './css-shake.js';
import { setInlineStyle } from './inline-style.js';
import { placeholderElement } from './placeholder.js';
import { collectVarNames, inheritCustomProperties } from './custom-props.js';
import { createResourceCache } from './inline-resources.js';
import { addOutsideMasks, addReferencedFilters, settleFilterImages } from './svg-refs.js';
import { buildSvgDataUrl, cropPixels } from './svg-builder.js';
import { engineSkins } from './engine-skins.js';
import { planTextOverlay } from './text-overlay.js';
import { measureCaret } from './caret-overlay.js';
import { planSteps } from './scroll-pages.js';

/** @typedef {import('../../contracts/types.js').Capture} Capture */
/** @typedef {import('../../contracts/types.js').CaptureFn} CaptureFn */
/** @typedef {import('../../contracts/types.js').CaptureRequest} CaptureRequest */
/** @typedef {import('../../contracts/types.js').CaptureResult} CaptureResult */
/** @typedef {import('../../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../../contracts/types.js').Rect} Rect */
/** @typedef {import('../../contracts/types.js').ResourceCache} ResourceCache */
/** @typedef {import('../../contracts/types.js').UnsupportedEntry} UnsupportedEntry */

const SHAKE_CACHE_SIZE = 8;

/**
 * Returns the CaptureFn. MUST NOT throw: any failure becomes result.unsupported + placeholder markup. Reuses one CssCollector and one ResourceCache per env.
 * Pipeline order: clone -> shakeCss(bundle, tokens) cached per (bundle.key, tokens.signature) -> svg build -> data: URL; fills result.layoutOffset (layer.borderBoxRectInLayer of the drawable) and result.caret; timings include shakeMs and bytes
 * (cost is per byte: encodeURIComponent ~2.6 ms/MB, decode ~6 ms/MB, a 96 KB base64 font ~2.6 ms per tile, so bytes are the lever, not node count alone).
 * @param {HicEnv} env
 * @returns {Capture}
 */
export function createCapture(env) {
  const inert = env.document.implementation.createHTMLDocument('');
  const collector = createCssCollector(env);
  const resources = createResourceCache(env);
  // a control skin decoded after a capture used it cold (Gecko, native-controls.js in the engines bundle): rebuild like a resource that arrived. The engines bundle may
  // register after the core, so the subscription is made at the first build that finds it.
  /** @type {object|null} */
  let skinsSeen = null;
  const watchSkins = () => {
    const skins = engineSkins();
    if (!skins || skins === skinsSeen) return;
    skinsSeen = skins;
    skins.onSkinReady(() => resources.settle?.('native-control-skin'));
  };
  /** @type {Map<string, {css: string, vars: Set<string>}>} */
  const shaken = new Map();
  /** @type {WeakMap<object, boolean>} bundles whose CSS has no sibling-position selectors (pruned spacer runs may be merged) */
  const foldable = new WeakMap();
  /** @type {WeakMap<object, Set<string>>} bundle keys whose @container usage was already checked */
  const containerChecked = new WeakMap();

  /** @param {string} key @param {() => string} make @returns {{css: string, vars: Set<string>}} the shaken sheet and the custom properties it refers to */
  const memoShake = (key, make) => {
    const hit = shaken.get(key);
    if (hit !== undefined) return hit;
    const css = make();
    /** @type {Set<string>} */
    const vars = new Set();
    collectVarNames(css, vars);
    const made = { css, vars };
    shaken.set(key, made);
    if (shaken.size > SHAKE_CACHE_SIZE) shaken.delete(/** @type {string} */ (shaken.keys().next().value));
    return made;
  };

  /** Report `@container` queries whose container lies outside the canvas (they cannot be honoured). @param {CaptureRequest} req @param {string} css @param {string} key */
  const checkContainerQueries = (req, css, key) => {
    let seen = containerChecked.get(req.record);
    if (!seen) containerChecked.set(req.record, (seen = new Set()));
    if (seen.has(key)) return;
    seen.add(key);
    if (!css.includes('@container')) return;
    for (let a = req.record.canvas.parentElement; a; a = a.parentElement) {
      const type = env.window.getComputedStyle(a).containerType;
      if (type && type !== 'normal') {
        env.reporter.unsupported({ feature: 'container-queries', message: '@container rules refer to a container outside the canvas, which is not part of the clone', hint: 'Put container-type on an element inside the canvas.', path: a.localName }, req.record.canvas);
        return;
      }
    }
  };

  /** @param {CaptureRequest} req @returns {CaptureResult} */
  function build(req) {
    watchSkins();
    const t0 = env.now();
    const el = req.element;
    const count = el.getElementsByTagName('*').length + 1;
    const verdict = evaluateBudget(count, env.options.nodeBudget);
    if (verdict === 'refuse') throw new BudgetExceeded(count);
    /** @type {UnsupportedEntry[]} */
    const entries = [];
    if (verdict === 'degrade') entries.push(entry('node-budget', `${count} nodes exceed the hard budget of ${env.options.nodeBudget.hard}: the drawable is updated at most 4 times per second`, 'Split the content into several drawables or render less DOM.', el));
    const bundle = collector.bundle(req.record, req.resources);
    const t1 = env.now();
    let fold = foldable.get(bundle);
    if (fold === undefined) foldable.set(bundle, (fold = !hasStructuralSelectors(bundle.css)));
    const noHas = !bundle.css.includes(':has(');
    const clone = cloneDrawable(env, verdict === 'ok' ? req : { ...req, prune: true }, inert, fold, fold && noHas, noHas);
    const t2 = env.now();
    const shakenCss = memoShake(`${bundle.key}|${clone.tokens.signature}`, () => shakeCss(bundle.css, clone.tokens));
    const css = shakenCss.css + clone.extraCss;
    const filters = addReferencedFilters(env.document, clone.root, css, req.resources);
    clone.nodes += filters.added + addOutsideMasks(env.document, clone.root, css);
    const feImages = settleFilterImages(clone.root, env.document.baseURI, req.resources);
    for (const e of feImages.ignored) entries.push({ ...e, t: 0, count: 1 });
    inheritCustomProperties(clone.root, clone.layerStyle, [...shakenCss.vars, ...clone.tokens.vars]);
    const t3 = env.now();
    checkContainerQueries(req, bundle.css, bundle.key);
    const f = clone.frame;
    const full = { x: f.x, y: f.y, width: f.width, height: f.height };
    const crop = (req.rect && intersectRect(req.rect, full)) || full;
    const cropRel = { x: crop.x - f.x, y: crop.y - f.y, width: crop.width, height: crop.height };
    const { url, bytes } = buildSvgDataUrl(clone.root, css, cropRel, { width: f.width, height: f.height }, req.scale);
    const t4 = env.now();
    const { widthPx, heightPx } = cropPixels(cropRel, req.scale);
    return {
      url, cropCss: crop, widthPx, heightPx, nodes: clone.nodes, complete: clone.complete && bundle.pendingUrls.length === 0 && !filters.pending && !feImages.pending, unsupported: finish(req, [...entries, ...clone.unsupported]),
      layoutOffset: clone.layoutOffset, caret: clone.caret, timings: { cloneMs: t2 - t1, cssMs: t1 - t0, shakeMs: t3 - t2, svgMs: t4 - t3, bytes },
    };
  }

  /** @param {string} feature @param {string} message @param {string|undefined} hint @param {Element} el @returns {UnsupportedEntry} */
  function entry(feature, message, hint, el) {
    return { feature, message, hint, path: el.localName + (el.id ? `#${el.id}` : ''), t: env.now(), count: 1 };
  }

  /** Report every entry to the loud-failure sink (it prints once per feature and path) and stamp the times. @param {CaptureRequest} req @param {UnsupportedEntry[]} list @returns {UnsupportedEntry[]} */
  function finish(req, list) {
    for (const e of list) {
      e.t = env.now();
      env.reporter.unsupported({ feature: e.feature, message: e.message, hint: e.hint, path: e.path }, req.record.canvas);
    }
    return list;
  }

  /** A tile that shows a hatched box where the drawable should be. @param {CaptureRequest} req @param {unknown} err @param {number} t0 @returns {CaptureResult} */
  function failure(req, err, t0) {
    const budget = err instanceof BudgetExceeded;
    const size = req.record.layer?.borderBoxSize(req.element) ?? { width: req.rect?.width ?? 16, height: req.rect?.height ?? 16 };
    const message = budget ? `${err.nodes} nodes exceed the absolute budget of ${env.options.nodeBudget.absolute}` : `capture failed: ${String(/** @type {any} */ (err)?.message ?? err)}`;
    const feature = budget ? 'node-budget' : 'capture-error';
    if (!budget) env.reporter.caught(err, 'capture');
    const e = entry(feature, message, budget ? 'Split the content into several drawables.' : undefined, req.element);
    const ink = req.ink;
    const frame = { width: size.width + ink.left + ink.right, height: size.height + ink.top + ink.bottom };
    const root = inert.createElement('div');
    setInlineStyle(root, `position:relative;overflow:hidden;width:${frame.width}px;height:${frame.height}px;padding:${ink.top}px 0 0 ${ink.left}px;box-sizing:border-box`);
    root.appendChild(placeholderElement(inert, e, size));
    const full = { x: -ink.left, y: -ink.top, width: frame.width, height: frame.height };
    const crop = (req.rect && intersectRect(req.rect, full)) || full;
    const cropRel = { x: crop.x - full.x, y: crop.y - full.y, width: crop.width, height: crop.height };
    const { url, bytes } = buildSvgDataUrl(root, '', cropRel, frame, req.scale);
    const { widthPx, heightPx } = cropPixels(cropRel, req.scale);
    return {
      url, cropCss: crop, widthPx, heightPx, nodes: 0, complete: true, unsupported: finish(req, [e]), layoutOffset: null, caret: null,
      timings: { cloneMs: env.now() - t0, cssMs: 0, shakeMs: 0, svgMs: 0, bytes },
    };
  }

  env.bus.on(BUS.DAMAGE, (/** @type {{cause?: string}} */ d) => { if (d?.cause === 'stylesheet') collector.invalidate(); });

  /** @type {Capture} */
  const capture = Object.assign((/** @type {CaptureRequest} */ req) => {
    const t0 = env.now();
    try {
      return build(req);
    } catch (err) {
      return failure(req, err, t0);
    }
  }, { resources, invalidateStyles: () => collector.invalidate(), cssBundle: (/** @type {import('../../contracts/types.js').CanvasRecord} */ record, /** @type {ResourceCache} */ resources) => collector.bundle(record, resources),
    textOverlay: (/** @type {Element} */ control, /** @type {Element} */ drawable, /** @type {Rect} */ frame, /** @type {number} */ epoch) => planTextOverlay(env.document, control, drawable, frame, epoch),
    scrollPlan: (/** @type {Element} */ scroller, /** @type {Element} */ drawable, /** @type {import('../../contracts/types.js').LiveLayer} */ layer) => planSteps(env.document, layer, scroller, drawable),
    caretOf: (/** @type {Element} */ control, /** @type {Rect} */ frame) => measureCaret(env.document, control, frame) });
  return capture;
}
