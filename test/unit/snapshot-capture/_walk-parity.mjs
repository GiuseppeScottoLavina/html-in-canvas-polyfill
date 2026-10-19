// Shared helpers of the walk-parity tests (not a test file). Walk parity: every snapshot of a corpus (the examples, the F1-F6 fixtures, edge cases: transforms, sticky, scrollers, rounded boxes, long lists, shadow DOM,
// forms, selections) is built by the current clone walk and by the walk as released (reference/clone-0.1.0.js), on a REAL live layer, and the two must be
// identical: markup, node count, completeness, CSS tokens, frame, layout offset, caret, extra CSS, unsupported entries. The cheaper walk measures less; it may
// not answer differently.
import { assert, fixture, frames } from '/test/unit/lib/t.js';
import { setup } from '/test/unit/live/lib.mjs';
import { cloneDrawable } from '/src/snapshot/capture/clone.js';
import { createResourceCache } from '/src/snapshot/capture/inline-resources.js';
import { flushGeometryWrites } from '/src/live/geometry-apply.js';
import { cloneDrawable as releasedWalk } from './reference/clone-0.1.0.js';

/** @returns {Promise<void>} */
const tick = () => new Promise((ok) => { setTimeout(ok, 0); });

const inertNew = document.implementation.createHTMLDocument('');
const inertOld = document.implementation.createHTMLDocument('');
const NO_IX = { hover: new Set(), active: new Set(), focus: null, focusVisible: false, caretVisible: true };
/** [fold, trunc, wrapSelection] as capture.js passes them: plain CSS, CSS with sibling selectors, CSS with :has() */
const FLAGS = [[true, true, true], [false, false, true], [true, false, false]];

/** Everything a walk hands to the rest of the pipeline, as one comparable string. */
export function outcome(walk, env, req, doc, flags) {
  let r;
  try { r = walk(env, req, doc, ...flags); } catch (err) { return `THROWS ${err?.constructor?.name}: ${err?.message}`; }
  const t = r.tokens;
  return JSON.stringify({
    markup: new XMLSerializer().serializeToString(r.root), nodes: r.nodes, complete: r.complete, signature: t.signature, classes: [...t.classes].sort(), ids: [...t.ids].sort(),
    tags: [...t.tags].sort(), fonts: [...t.fonts].sort(), vars: [...t.vars].sort(), attrNeed: t.hasAttributeSelectorNeed, frame: r.frame, layoutOffset: r.layoutOffset, caret: r.caret,
    extraCss: r.extraCss, unsupported: r.unsupported.map((e) => `${e.feature}|${e.path}|${e.message}`),
  });
}

/** @returns {string|null} null when the released walk and `current` agree, else where they first differ */
export function mismatch(env, req, flags, current = cloneDrawable) {
  const before = outcome(releasedWalk, env, req, inertOld, flags);
  const now = outcome(current, env, req, inertNew, flags);
  if (before === now) return null;
  let i = 0;
  while (i < before.length && before[i] === now[i]) i++;
  return `first difference at ${i}:\n  released: …${before.slice(Math.max(0, i - 120), i + 120)}…\n  current:  …${now.slice(Math.max(0, i - 120), i + 120)}…`;
}

/** A managed canvas with `inner` as its content, mounted on a real live layer. */
export function mountCase(t, { css = '', inner, canvasAttrs = 'width="600" height="400"', canvasStyle = 'display:block;width:600px;height:400px', wrapStyle = '' }) {
  const { env, managed } = setup({ t, options: { nodeBudget: { soft: 100000, hard: 200000, absolute: 400000 } } });
  const root = fixture(`<style>${css}</style><div class="parity-wrap" style="${wrapStyle}"><canvas ${canvasAttrs} style="${canvasStyle}">${inner}</canvas></div>`);
  const canvas = /** @type {HTMLCanvasElement} */ (root.querySelector('canvas'));
  const record = managed(canvas);
  const resources = createResourceCache(env);
  const request = (el, over = {}) => ({ record, element: el, rect: null, scale: 2, ink: { left: 3, top: 2, right: 5, bottom: 4 }, generation: 1, resources, prune: false, interaction: NO_IX, ...over });
  return { env, root, canvas, record, layer: record.layer, request };
}

/** Elements of `el` (itself included) that scroll: a scroll container with something to scroll. */
export function scrollersIn(el) {
  return [el, ...el.querySelectorAll('*')].filter((e) => {
    const cs = getComputedStyle(e);
    return /auto|scroll|hidden/.test(cs.overflowX + cs.overflowY) && (e.scrollHeight > e.clientHeight || e.scrollWidth > e.clientWidth);
  });
}

/** The requests of one drawable: full, damage-pruned bands, scrolled scrollers, compositor pages, focus + hover, hidden text, a page selection. */
export function* variants(c, el) {
  const size = c.layer.borderBoxSize(el);
  if (!size) { yield ['not laid out', c.request(el)]; return; }
  const { width: w, height: h } = size;
  const bands = () => [0, 0.33, 0.66, 0.9].map((f) => ({ x: 0, y: h * f, width: w, height: Math.max(30, h * 0.12) })).concat([{ x: w * 0.5, y: h * 0.2, width: w * 0.3, height: h * 0.3 }]);
  yield ['full', c.request(el)];
  for (const rect of bands()) yield [`pruned ${JSON.stringify(rect)}`, c.request(el, { rect, prune: true })];
  yield ['not pruned, cropped', c.request(el, { rect: bands()[1] })];
  const scrollers = scrollersIn(el).slice(0, 4);
  for (const s of scrollers) {
    s.scrollTop = Math.round(0.37 * (s.scrollHeight - s.clientHeight)) + 0.5;
    s.scrollLeft = Math.round(0.21 * (s.scrollWidth - s.clientWidth));
  }
  if (scrollers.length) {
    yield ['scrolled', c.request(el)];
    for (const rect of bands()) yield [`scrolled, pruned ${JSON.stringify(rect)}`, c.request(el, { rect, prune: true })];
    for (const s of scrollers) {
      const top = Math.round(0.61 * (s.scrollHeight - s.clientHeight));
      const sticky = [...s.querySelectorAll('*')].filter((e) => getComputedStyle(e).position === 'sticky');
      for (const bars of [undefined, 'track', 'thumb']) yield [`page of ${s.localName}.${s.className} bars=${bars}`, c.request(el, { scroll: { el: s, top, hide: sticky, bars }, rect: bands()[2], prune: true })];
    }
  }
  // a compositor page asks for a box that does not scroll: the released walk emulated its offset all the same
  const still = [...el.querySelectorAll('*')].find((e) => { const cs = getComputedStyle(e); return cs.overflowX === 'visible' && cs.overflowY === 'visible' && e.scrollHeight > e.clientHeight; });
  if (still) yield ['page of a box that does not scroll', c.request(el, { scroll: { el: still, top: 7, hide: [] } })];
  const field = /** @type {HTMLInputElement|null} */ (el.querySelector('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]), textarea, [contenteditable]'));
  if (field) {
    field.focus({ preventScroll: true });
    try { field.setSelectionRange?.(1, 4); } catch { /* not a text field */ }
    const hover = new Set(); for (let e = /** @type {Element|null} */ (field); e && e !== c.layer.element; e = e.parentElement) hover.add(e);
    const ix = { hover, active: new Set([field]), focus: field, focusVisible: true, caretVisible: true };
    yield ['focused field with a selection', c.request(el, { interaction: ix })];
    yield ['focused field, pruned', c.request(el, { interaction: ix, rect: bands()[1], prune: true })];
    yield ['hidden text of the focused field', c.request(el, { interaction: ix, hideText: field })];
    field.blur();
  }
  const text = [...el.querySelectorAll('p, span, li, td, div')].find((e) => /\S/.test(e.textContent ?? '') && e.getClientRects().length);
  if (text) {
    const sel = document.getSelection();
    sel?.selectAllChildren(text);
    yield ['page selection', c.request(el)];
    sel?.removeAllRanges();
  }
}

/** Run every variant of every drawable, plus the drawables under an applied scale, an applied rotation, an author transform and a scaled ancestor. */
export async function checkCase(t, spec) {
  const c = mountCase(t, spec);
  spec.setup?.(c.root);
  await frames(2);
  const drawables = c.layer.drawableElements();
  assert.ok(drawables.length > 0, 'the case has drawables');
  let compared = 0;
  const failures = [];
  const run = async (stage) => {
    for (const el of c.layer.drawableElements()) {
      for (const [label, req] of variants(c, el)) {
        for (const flags of spec.flags ?? FLAGS) {
          const diff = mismatch(c.env, req, flags);
          compared++;
          if (diff && failures.length < 3) failures.push(`${stage} / ${el.localName}#${el.id} / ${label} / flags ${flags}: ${diff}`);
        }
        await tick(); // the runner reads a page that is busy for 2 s as hung
      }
    }
  };
  await run('plain');
  const first = drawables[0];
  c.layer.setHitTestOrder([first]);
  for (const [name, m] of [['applied scale', new DOMMatrix().translate(5, 7).scale(1.5, 1.25)], ['applied rotation', new DOMMatrix().rotate(12)]]) {
    c.layer.applyGeometry(first, { transform: m, clip: null }, null);
    flushGeometryWrites();
    await run(name);
  }
  c.layer.applyGeometry(first, null, null);
  flushGeometryWrites();
  /** @type {HTMLElement} */ (first).style.setProperty('transform', 'rotate(3deg) scale(0.9)');
  await run('author transform');
  /** @type {HTMLElement} */ (first).style.removeProperty('transform');
  /** @type {HTMLElement} */ (c.root.querySelector('.parity-wrap')).style.transform = 'scale(0.75)';
  await run('scaled ancestor');
  assert.ok(compared > 20, `compared ${compared} snapshots`);
  assert.equal(failures.length, 0, failures.join('\n\n'));
}

/** The canvas of a page served by the repo: its inline <style> sheets, the canvas attributes and content (scripts never run). */
export async function pageCase(url, extra = {}) {
  const d = new DOMParser().parseFromString(await (await fetch(url)).text(), 'text/html');
  const cv = d.querySelector('canvas');
  if (!cv) throw new Error(`no canvas in ${url}`);
  const attrs = [...cv.attributes].filter((a) => a.name !== 'style' && a.name !== 'content').map((a) => `${a.name}="${a.value.replace(/"/g, '&quot;')}"`).join(' ');
  const css = [...d.querySelectorAll('style')].map((s) => s.textContent).join('\n').replace(/(^|[\s,}])(html|body)(?=[\s,{.:#])/g, '$1.parity-wrap');
  return { css, inner: cv.innerHTML, canvasAttrs: attrs, canvasStyle: `${cv.getAttribute('style') ?? ''};display:block`, ...extra };
}

