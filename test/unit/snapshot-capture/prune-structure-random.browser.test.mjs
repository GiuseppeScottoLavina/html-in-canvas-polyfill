// G-prune-structure, the random part (docs/TEST-PLAN.md): lists of mixed block children (three types, classes a / b / k, an attribute, nested groups) under one to
// four random selectors that count siblings, cropped at a random place. Every element of the pruned clone matches exactly the selectors its live element matches;
// every fourth case also compares the pruned tile with the full one. A quarter of the cases add a :has() rule (the rows under the tile are
// then merged, not left out). The generator is seeded: a failure names its case.
// Control: a clone with one spacer removed by hand does not pass the selector comparison (the oracle sees a shifted sibling).
import { test, assert } from '/test/unit/lib/t.js';
import { mismatches, rng, rows, runCase } from './_structure-matrix.mjs';

const TYPES = ['', '', 'div', 'p', 'section'];
const CLASSES = ['', '.c', '.a', '.b', '.k', '.c.a'];
const COUNT = [':nth-child(odd)', ':nth-child(even)', ':nth-child(3n+1)', ':nth-child(4)', ':nth-of-type(2n)', ':nth-last-child(2)', ':nth-last-child(odd)', ':last-of-type', ':only-of-type', ':nth-last-of-type(3)',
  ':last-child', ':first-child', ':only-child', ':first-of-type', ':not(:last-child)', ':not(:first-child)', ':not(:nth-child(3n))', ':is(:nth-child(2), .k)'];
const PLAIN = ['', '', '', '[data-x]', ':not(.a)', ':not([data-x])'];

/** @param {ReturnType<typeof rng>} r @param {boolean} counting */
const compound = (r, counting) => { const s = r.pick(TYPES) + r.pick(CLASSES) + (counting ? r.pick(COUNT) : r.pick(PLAIN)); return s || '*'; };
/** a complex selector that counts siblings in one of the ways the analysis knows @param {ReturnType<typeof rng>} r */
function selector(r) {
  const parent = r.chance(0.5) ? r.pick(['.l > ', '.g > ', '.l ', '.g ', '.l > .g > ']) : '';
  const kind = r.int(4);
  let s;
  if (kind === 0) s = compound(r, true);
  else if (kind === 1) s = `${compound(r, false)} ${r.pick(['+', '~'])} ${compound(r, false)}`;
  else if (kind === 2) s = `${compound(r, false)} ${r.pick(['+', '~'])} ${compound(r, r.chance(0.5))}`;
  else s = `${compound(r, r.chance(0.3))} ${r.pick(['+', '~'])} ${compound(r, false)} ${r.pick(['+', '~'])} ${compound(r, false)}`;
  return parent + s + (r.chance(0.2) ? ' span' : '');
}
const DECLS = ['background:#c8d8ff', 'color:#a00', 'margin-top:3px', 'border-top:2px solid #06c', 'padding-left:6px', 'outline:1px solid #f0f', 'margin-bottom:5px', 'font-weight:700'];

const CASES = 144;
for (let part = 0; part < 4; part++) {
  test(`random lists and selectors, cases ${part * CASES / 4} to ${(part + 1) * CASES / 4 - 1}: every clone element matches the selectors its live element matches; every fourth pruned tile shows the full one`, async () => {
    let reduced = 0, whole = 0;
    for (let i = part * CASES / 4; i < (part + 1) * CASES / 4; i++) {
      const r = rng(1000 + i);
      const selectors = Array.from({ length: 1 + r.int(4) }, () => selector(r));
      // a :has() rule in a quarter of the cases: the rows under the tile are then merged instead of left out
      const css = selectors.map((s) => `${s}{${r.pick(DECLS)}}`).join('') + (r.chance(0.25) ? '.l:has(span){color:#111}' : '');
      const html = rows(r, 30 + r.int(25), { nested: i % 3 === 0 ? 0.15 : 0 });
      const c = await runCase(html, css, selectors, r.int(1200), { pixels: i % 4 === 0 });
      assert.deepEqual(c.bad.slice(0, 6), [], `case ${i}: ${css}`);
      assert.ok(c.diff <= 0.002, `case ${i}: the pruned tile shows the full tile (${(c.diff * 100).toFixed(2)} % differ): ${css}`);
      // elements of the list that are in the clone: fewer than live when a run was merged or a tail left out
      if (c.ids < c.live) reduced++; else whole++;
    }
    assert.ok(reduced >= 6 && whole >= 3, `both kinds of clone occur: ${reduced} with rows merged or left out, ${whole} with every row`);
  });
}

test('control: with one spacer taken out of a clone by hand, the comparison reports the rows behind it', async () => {
  const r = rng(7);
  const c = await runCase(rows(r, 40, { tags: ['div'] }), '.c:nth-child(even){background:#c8d8ff}', ['.c:nth-child(even)'], 500);
  assert.deepEqual(c.bad, [], 'the clone as built');
  const svg = decodeURIComponent(c.pruned.url.slice(c.pruned.url.indexOf(',') + 1));
  const cut = svg.replace(/<div[^>]*data-hic-sp=""[^>]*><\/div>|<div[^>]*data-hic-sp=""[^>]*\/>/, '');
  assert.notEqual(cut, svg, 'a spacer was removed');
  const bad = mismatches({ url: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(cut) }, ['.c:nth-child(even)']);
  assert.ok(bad.length >= 5, `the rows behind it no longer match as they do live (${bad.length})`);
});
