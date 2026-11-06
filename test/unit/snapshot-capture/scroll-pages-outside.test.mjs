// scroll-pages.js, the elements outside a scroller over a minimal DOM: how many computed styles one check of them reads (ScrollPlan.clear), and the admission
// refusal of one that blends over the port (planSteps). The browser tests (scroll-pages.browser.test.mjs) and G-scroll-cadence's covers cover real layouts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSteps } from '../../../src/snapshot/capture/scroll-pages.js';

class Rect {
  /** @param {number} x @param {number} y @param {number} w @param {number} h */
  constructor(x, y, w, h) { Object.assign(this, { x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h }); }
}
globalThis.DOMRect ??= /** @type {any} */ (Rect);

const BASE = {
  overflowX: 'visible', overflowY: 'visible', position: 'static', transform: 'none', perspective: 'none', isolation: 'auto', filter: 'none', backdropFilter: 'none',
  mixBlendMode: 'normal', clipPath: 'none', maskImage: 'none', boxShadow: 'none', textShadow: 'none', backgroundImage: 'none', backgroundAttachment: 'scroll',
  borderLeftWidth: '0px', borderRightWidth: '0px', borderTopWidth: '0px', borderBottomWidth: '0px', borderTopLeftRadius: '0px', borderTopRightRadius: '0px',
  borderBottomLeftRadius: '0px', borderBottomRightRadius: '0px', zIndex: 'auto', backgroundColor: 'rgba(0, 0, 0, 0)', outlineStyle: 'none', outlineWidth: '0px',
  outlineOffset: '0px', visibility: 'visible', display: 'block', opacity: '1', content: 'none',
};

/**
 * A scroller 400 x 400 at 20,20 of a drawable, and one box outside it (`own`: its style; `wrap`: the style of an element around it, below the drawable; `pseudo`: the
 * style of its ::before), over the whole port or beside it (`at`). Counts the computed styles read of the box and its wrapper.
 * @param {{own?: object, wrap?: object, pseudo?: object, at?: Rect}} [o]
 */
function scene(o = {}) {
  const port = new Rect(20, 20, 400, 400), at = o.at ?? port;
  const doc = /** @type {any} */ ({ activeElement: null, getSelection: () => null, getAnimations: () => [] });
  const reads = { plain: 0, pseudo: 0 };
  const root = { contains: () => true, parentElement: null };
  const row = { localName: 'div', shadowRoot: null };
  const s = {
    ownerDocument: doc, localName: 'div', offsetWidth: 400, clientWidth: 400, offsetHeight: 400, clientHeight: 400, scrollWidth: 400, scrollHeight: 1000, scrollLeft: 0,
    scrollTop: 0, parentElement: root, isConnected: true, getElementsByTagName: () => [row], getRootNode: () => doc, contains: (/** @type {any} */ e) => e === row, getBoundingClientRect: () => port,
  };
  const el = (/** @type {any} */ parent) => ({
    localName: 'div', namespaceURI: 'http://www.w3.org/1999/xhtml', shadowRoot: null, childNodes: [], isConnected: true, scrollWidth: 400, clientWidth: 400,
    scrollHeight: 400, clientHeight: 400, parentElement: parent, contains: () => false, matches: () => false, getBoundingClientRect: () => at, getClientRects: () => [at],
  });
  const wrap = el(root), box = el(o.wrap ? wrap : root);
  const win = {
    innerWidth: 1000, innerHeight: 1000, devicePixelRatio: 1, performance: { now: () => 0 },
    getComputedStyle(/** @type {any} */ e, /** @type {string|null} */ p) {
      if (e === box || e === wrap) reads[p ? 'pseudo' : 'plain']++;
      if (p) return e === box && o.pseudo ? { ...BASE, ...o.pseudo } : BASE;
      return e === s ? { ...BASE, overflowY: 'auto', position: 'relative', backgroundColor: 'rgb(255, 255, 255)' } : e === box ? { ...BASE, ...o.own } : e === wrap ? { ...BASE, ...o.wrap } : BASE;
    },
  };
  doc.defaultView = win;
  doc.elementFromPoint = () => row;
  const kids = o.wrap ? [wrap, box] : [box];
  doc.createTreeWalker = () => { let i = 0; return { nextNode: () => kids[i++] ?? null }; };
  const layer = /** @type {any} */ ({ nearestDrawable: () => root, drawableElements: () => [root], frameRect: () => ({ x: 0, y: 0, width: 400, height: 400 }) });
  const it = planSteps(doc, layer, /** @type {any} */ (s), /** @type {any} */ (root), 'chromium');
  let r;
  while (!(r = it.next()).done);
  return { plan: r.value, reads };
}

test('ScrollPlan.clear: one check reads the computed style of an outside box over the damage once (faded and painting share it), and every check reads it again', () => {
  const { plan, reads } = scene();
  assert.ok(plan?.clear, 'planned');
  for (let n = 0; n < 2; n++) {
    reads.plain = reads.pseudo = 0;
    assert.equal(plan.clear([{ x: 10, y: 10, width: 20, height: 20 }]), true, 'a transparent box paints nothing');
    // 0.1.0-preview.25: 2 ordinary reads (faded, then painting) and 2 of its generated boxes
    assert.deepEqual(reads, { plain: 1, pseudo: 2 }, `check ${n + 1}: its own style once, ::before and ::after once each`);
  }
  const hidden = scene({ own: { opacity: '0' } });
  hidden.reads.plain = hidden.reads.pseudo = 0;
  assert.equal(hidden.plan?.clear?.([{ x: 10, y: 10, width: 20, height: 20 }]), true, 'a box of opacity 0');
  assert.deepEqual(hidden.reads, { plain: 1, pseudo: 0 }, 'faded: nothing more is read');
});

test('admission: an outside box over the port that blends (itself, an element around it, its ::before) and paints refuses the plan; normal, unpainted, faded or beside the port does not', () => {
  const fill = { backgroundColor: 'rgb(1, 254, 3)' };
  assert.ok(scene({ own: fill }).plan, 'control: a normal box (the cover check sees it)');
  for (const mode of ['saturation', 'multiply', 'difference', 'luminosity']) assert.equal(scene({ own: { ...fill, mixBlendMode: mode } }).plan, null, mode);
  assert.equal(scene({ own: fill, wrap: { mixBlendMode: 'saturation' } }).plan, null, 'on an element around it');
  assert.equal(scene({ pseudo: { content: '""', position: 'absolute', mixBlendMode: 'saturation' } }).plan, null, 'on its ::before');
  assert.ok(scene({ pseudo: { content: 'none', mixBlendMode: 'saturation' } }).plan, 'control: a ::before that generates no box');
  assert.ok(scene({ own: { mixBlendMode: 'saturation' } }).plan, 'control: blended, nothing painted');
  assert.ok(scene({ own: { ...fill, mixBlendMode: 'saturation', opacity: '0' } }).plan, 'control: blended, opacity 0');
  assert.ok(scene({ own: { ...fill, mixBlendMode: 'saturation', visibility: 'hidden' } }).plan, 'control: blended, visibility: hidden');
  assert.ok(scene({ own: fill, wrap: { mixBlendMode: 'saturation', opacity: '0' } }).plan, 'control: under a blended wrapper of opacity 0');
  assert.ok(scene({ own: { ...fill, mixBlendMode: 'saturation' }, at: new Rect(20, 430, 400, 30) }).plan, 'control: blended, below the port');
  assert.equal(scene({ own: { ...fill, mixBlendMode: 'saturation' }, at: new Rect(20, 400, 400, 40) }).plan, null, 'blended, half over the port');
});
