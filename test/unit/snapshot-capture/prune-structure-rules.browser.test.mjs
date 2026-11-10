// G-prune-structure, the rules one by one (docs/TEST-PLAN.md): a list of 60 rows under one selector that counts siblings, cropped at its top, its middle and its
// end. Each crop: every element of the pruned clone matches the selectors its live element matches, and the pruned tile shows what the full tile shows. At the
// middle crop the clone also has the shape the rule allows: `merged` (runs of spacers merged and the rows under the tile left out), `counted` (a spacer for every
// row above the tile, the rows under it left out), `all` (a spacer for every row). The first three rows of the table are the controls of that shape: without a
// counting selector, and with one that reaches no row of this list, the clone is `merged` as it always was.
import { test, assert } from '/test/unit/lib/t.js';
import { runCase } from './_structure-matrix.mjs';

const LIST = Array.from({ length: 60 }, (_, i) => `<div id="r${i}" class="c${i % 7 === 3 ? ' k' : ''}"${i === 20 ? ' data-x="1"' : ''}><span>row ${i}</span></div>`).join('');
// the ids of the matrix helper are e<number>: these rows are named r<number> for the messages, and mapped below
const html = LIST.replace(/id="r(\d+)"/g, (_m, n) => `id="e9${String(n).padStart(3, '0')}"`);

/** @type {Array<[string, string, string[], 'merged'|'counted'|'all']>} what, css, the selectors to compare, the shape */
const RULES = [
  ['no counting selector (control)', '.c{color:#123}', ['.c'], 'merged'],
  [':nth-child() on a class no row has (control)', '.zz:nth-child(even){background:#c8d8ff}', ['.zz:nth-child(even)'], 'merged'],
  [':nth-child() under a parent that is not this list (control)', '.other > .c:nth-child(even){background:#c8d8ff}', ['.other > .c:nth-child(even)'], 'merged'],
  [':nth-child(even) stripes', '.c:nth-child(even){background:#c8d8ff}', ['.c:nth-child(even)'], 'counted'],
  [':nth-child(3n) under a child combinator', '.l > .c:nth-child(3n){color:#a00;background:#eef}', ['.l > .c:nth-child(3n)'], 'counted'],
  [':nth-of-type(odd)', '.l div:nth-of-type(odd){background:#e4e4e4}', ['.l div:nth-of-type(odd)'], 'counted'],
  [':nth-last-child(odd)', '.c:nth-last-child(odd){background:#dfd}', ['.c:nth-last-child(odd)'], 'all'],
  [':last-of-type', '.l > div:last-of-type{background:#f88}', ['.l > div:last-of-type'], 'all'],
  [':only-of-type', '.l > div:only-of-type{background:#f88}', ['.l > div:only-of-type'], 'all'],
  [':last-child', '.c:last-child{background:#fc8;border-bottom:4px solid #000}', ['.c:last-child'], 'merged'],
  [':last-child beside a :has() rule (the rows under the tile are merged, not left out)', '.c:last-child{background:#fc8;border-bottom:4px solid #000}.l:has(span){color:#111}', ['.c:last-child'], 'merged'],
  [':only-child beside a :has() rule', '.c:only-child{background:#f00}.l:has(span){color:#111}', ['.c:only-child'], 'merged'],
  [':not(:nth-child(3n))', '.c:not(:nth-child(3n)){background:#e8f0ff}', ['.c:not(:nth-child(3n))'], 'counted'],
  [':is(:nth-last-child(2), .k)', '.c:is(:nth-last-child(2), .k){background:#ffe0a0}', ['.c:is(:nth-last-child(2), .k)'], 'all'],
  [':not(:last-child) separators', '.c:not(:last-child){border-bottom:1px solid #999}', ['.c:not(:last-child)'], 'merged'],
  [':only-child', '.c:only-child{background:#f00}', ['.c:only-child'], 'merged'],
  [':first-child', '.c:first-child{background:#8f8;border-top:3px solid #000}', ['.c:first-child'], 'merged'],
  ['.c + .c separators', '.c + .c{border-top:2px solid #06c}', ['.c + .c'], 'merged'],
  ['.l > * + * (every child but the first)', '.l > * + *{margin-top:4px}', ['.l > * + *'], 'merged'],
  ['.k + .c (the row after a marked one)', '.k + .c{background:#fd0}', ['.k + .c', '.k'], 'merged'],
  ['.k ~ .c (every row after the first marked one)', '.k ~ .c{color:#a00;background:#fee}', ['.k ~ .c'], 'merged'],
  ['.c:first-child + .c (a pseudo-class beside the combinator)', '.c:first-child + .c{background:#f0f}', ['.c:first-child + .c'], 'counted'],
  ['.c[data-x] + .c (an attribute beside the combinator)', '.c[data-x] + .c{background:#0ff}', ['.c[data-x] + .c'], 'counted'],
  ['.l > :not([hidden]) ~ :not([hidden])', '.l > :not([hidden]) ~ :not([hidden]){margin-top:3px}', ['.l > :not([hidden]) ~ :not([hidden])'], 'counted'],
  [':has() around a counting selector', '.l:has(> .c:nth-child(2)){outline:1px solid #f00}.c:nth-child(even){background:#c8d8ff}', ['.c:nth-child(even)'], 'all'],
  [':nth-child() beside a :has() rule', '.c:nth-child(even){background:#c8d8ff}.c:has(span){color:#024}', ['.c:nth-child(even)'], 'all'],
];
const SHAPE = { merged: (/** @type {number} */ n) => n <= 26, counted: (/** @type {number} */ n) => n >= 30 && n <= 46, all: (/** @type {number} */ n) => n >= 58 };

for (const [what, css, selectors, want] of RULES) {
  test(`${what}: the pruned clone matches as the live list does and shows the full tile, at the top, the middle and the end; ${want} at the middle`, async () => {
    for (const [where, y] of /** @type {Array<[string, number]>} */ ([['top', 0], ['middle', 600], ['end', 1300]])) {
      const r = await runCase(html, css, selectors, y, { pixels: true });
      assert.equal(r.children, 60);
      assert.deepEqual(r.bad, [], `${where}: selector parity`);
      assert.ok(r.diff <= 0.002, `${where}: the pruned tile shows the full tile (${(r.diff * 100).toFixed(2)} % differ)`);
      // the rows of the list (and the list) in the clone: kept ones and spacers
      if (where === 'middle') assert.ok(SHAPE[want](r.ids - 1), `${want}: ${r.ids - 1} rows in the clone (${r.spacers} spacers)`);
    }
  });
}
