// The truncation test measured once for the pages of a scroller (clone.js tailClear, CaptureRequest.scroll.memo): a page built with the memo the compositor keeps is
// identical to the page built without it, at every offset, while the live scroller moves between builds, and after a layout change the compositor was not told of.
import { test, assert, frames } from '/test/unit/lib/t.js';
import { cloneDrawable } from '/src/snapshot/capture/clone.js';
import { mountCase, outcome } from './_walk-parity.mjs';

const inertA = document.implementation.createHTMLDocument('');
const inertB = document.implementation.createHTMLDocument('');
const TRUNC = [true, true, true];

const rows = (n, extra = () => '') => Array.from({ length: n }, (_, i) => `<li${extra(i)}><b>Name ${i % 8}</b> <span>#${i + 1} Quarterly numbers and notes</span></li>`).join('\n');
const CSS = `#app{box-sizing:border-box;width:600px;height:400px;display:grid;grid-template-columns:300px 1fr;gap:12px;padding:12px;font:14px/1.4 sans-serif}
  #list{min-height:0;overflow-y:auto;border:1px solid #9ab;background:#fbfcfe}#list ol{margin:0;padding:0;list-style:none}#list li{padding:6px 10px;border-bottom:1px solid #e6eaf2}`;

/** pages of #list at `tops` with one shared memo and without, the live scroller moved to `live(i)` before each pair; returns the first difference or null */
function compare(c, list, tops, memo, live = (/** @type {number} */ i) => (i * 97) % 600) {
  const app = /** @type {Element} */ (c.root.querySelector('#app'));
  const port = /** @type {any} */ (c.layer).frameRect(list);
  for (let i = 0; i < tops.length; i++) {
    list.scrollTop = live(i);
    const req = (/** @type {any} */ scroll) => c.request(app, { scroll, rect: port, prune: true });
    const withMemo = outcome(cloneDrawable, c.env, req({ el: list, top: tops[i], hide: [], memo }), inertA, TRUNC);
    const plain = outcome(cloneDrawable, c.env, req({ el: list, top: tops[i], hide: [] }), inertB, TRUNC);
    if (withMemo !== plain) return `page at ${tops[i]} (live ${list.scrollTop}) differs`;
  }
  return null;
}

/** @returns {number} rows the page clone carries */
const rowsIn = (/** @type {string} */ s) => (JSON.parse(s).markup.match(/<li[ >]/g) ?? []).length;

test('pages of a long list: the same with the memo as without, at every offset while the live list moves; the memo is used and the pages are cut', async (t) => {
  const c = mountCase(t, { css: CSS, inner: `<div id="app" drawable><section id="list"><ol>${rows(400)}</ol></section><p>side</p></div>` });
  await frames(2);
  const list = /** @type {HTMLElement} */ (c.root.querySelector('#list'));
  const memo = new Map();
  // far first, then near pages with the live list scrolled back: the memo is extended towards the first row after the content moved down under it
  const tops = [9000, 0, 300, 600, 1800, 1500, 450, 12000, 0, 6800, 7600, 8200];
  const live = [2400, 0, 150, 900, 30, 1200, 0, 2000, 600, 100, 3000, 0];
  assert.equal(compare(c, list, tops.slice(0, 2), memo, (i) => live[i]), null);
  const ol = /** @type {Element} */ (list.querySelector('ol'));
  const m = memo.get(ol);
  assert.ok(m && m.from < m.kids.length, 'the memo holds the tail of the list');
  assert.equal(compare(c, list, tops.slice(2), memo, (i) => live[i + 2]), null);
  assert.equal(memo.get(ol), m, 'measured once: the later pages, the live list elsewhere each time, read it');
  const app = /** @type {Element} */ (c.root.querySelector('#app'));
  const n = rowsIn(outcome(cloneDrawable, c.env, c.request(app, { scroll: { el: list, top: 600, hide: [], memo }, rect: /** @type {any} */ (c.layer).frameRect(list), prune: true }), inertA, TRUNC));
  assert.ok(n > 0 && n < 200, `the page is truncated (the test is not vacuous): ${n} of 400 rows`);
});

test('content that reaches above a later row (a raised child, a negative margin) keeps the rows: the memo answers as the direct test does', async (t) => {
  const raise = (/** @type {number} */ i) => (i === 260 ? ' style="margin-top:-90px"' : '');
  // row 120 keeps its box; a child of it is raised over the rows before it (only the Range rect of the row sees that)
  const html = rows(400, raise).replace('<b>Name 0</b> <span>#121 ', '<b style="position:relative;top:-140px">Name 0</b> <span>#121 ');
  assert.ok(html.includes('top:-140px'));
  const c = mountCase(t, { css: CSS, inner: `<div id="app" drawable><section id="list"><ol>${html}</ol></section><p>side</p></div>` });
  await frames(2);
  const list = /** @type {HTMLElement} */ (c.root.querySelector('#list'));
  const memo = new Map();
  const tops = [];
  for (let top = 0; top < 14000; top += 211) tops.push(top);
  assert.equal(compare(c, list, tops, memo), null);
});

test('a layout change the compositor was not told of: the memo notices the moved rows and measures again (positive control: a stale memo would differ)', async (t) => {
  const c = mountCase(t, { css: CSS, inner: `<div id="app" drawable><section id="list"><ol>${rows(400)}</ol></section><p>side</p></div>` });
  await frames(2);
  const list = /** @type {HTMLElement} */ (c.root.querySelector('#list'));
  const memo = new Map();
  assert.equal(compare(c, list, [0, 2400, 4800], memo), null);
  // a row above the cut points grows, and a row below them is raised over the rows before it: the cached answers are wrong now
  const lis = list.querySelectorAll('li');
  /** @type {HTMLElement} */ (lis[5]).style.height = '300px';
  /** @type {HTMLElement} */ (lis[150]).style.cssText = 'position:relative;top:-2600px';
  await frames(1);
  assert.equal(compare(c, list, [2400, 4800, 0, 3000], memo), null);
});
