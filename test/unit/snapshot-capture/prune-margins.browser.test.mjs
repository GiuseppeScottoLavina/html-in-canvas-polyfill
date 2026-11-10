// A pruned child's descendants are gone, and with them the margins that collapsed through it (clone.js cloneChildList, throughMargin). Found by the G-prune-structure
// matrix: a group of rows above the tile whose first row has a top margin was replaced by a spacer without that margin, and the tile showed its rows that margin
// too high (a 10 px margin: the whole tile 10 px off, 42 % of its pixels). The spacer takes the live gap, or, at an edge of its container, the margin that reached
// its edge. Each case: the pruned tile shows what the full tile shows, at three crops under the group. Controls: margins that do not collapse through (a padding,
// a formatting context of its own) leave the clone as it was, with no top margin written on a spacer.
import { test, assert } from '/test/unit/lib/t.js';
import { mount, rasterize, diffFraction, inkFraction } from './_support.mjs';

const BASE = '.l{width:200px;font:12px/20px sans-serif}.l div{min-height:20px;background:#fafafa}.l .g{display:block;background:#e8eefc}';
const row = (i, cls = 'c') => `<div class="${cls}"><span>row ${i}</span></div>`;
const many = (n, cls = 'c') => Array.from({ length: n }, (_, i) => row(i, cls)).join('');
// a section among div rows: a run of spacers is merged of one type only, and a merged run spans the live boxes, gaps included (so the same type would hide the case)
const group = (inner, cls = 'g') => `<section class="${cls}">${inner}</section>`;

/** @type {Array<[string, string, string, boolean]>} what, css, the rows, whether a spacer is given a top margin (the clone wrote none before) */
const CASES = [
  ['the first row of a group above the tile has a top margin', '.t{margin-top:10px}', `${many(3)}${group(row('g0', 'c t') + many(5))}${many(40)}`, true],
  ['the last row of a group above the tile has a bottom margin', '.t{margin-bottom:10px}', `${many(3)}${group(many(5) + row('g5', 'c t'))}${many(40)}`, true],
  ['both, and the group has a smaller margin of its own', '.t{margin:14px 0}.g{margin:6px 0}', `${many(3)}${group(row('g0', 'c t') + many(4) + row('g5', 'c t'))}${many(40)}`, true],
  ['a margin two levels down (a group in a group)', '.t{margin-top:12px}', `${many(3)}${group(group(row('g0', 'c t') + many(3)) + many(2))}${many(40)}`, true],
  ['the group is the first child of the list', '.t{margin-top:9px}', `${group(row('g0', 'c t') + many(5))}${many(44)}`, true],
  ['a negative margin beside a positive one', '.t{margin-top:16px}.g{margin-top:-6px}', `${many(3)}${group(row('g0', 'c t') + many(5))}${many(40)}`, true],
  ['merged groups: three groups in a row, each with a margin on its first row', '.t{margin-top:8px}', `${many(2)}${[0, 1, 2].map(() => group(row('g0', 'c t') + many(3))).join('')}${many(40)}`, true],
  ['a kept group under pruned rows: its first rows are spacers', '.t{margin-top:10px}', `${many(20)}${group(row('g0', 'c t') + many(30))}${many(10)}`, false],
  ['rows of one type under a selector that counts them (no run is merged): the first row of a group has a top margin', '.t{margin-top:10px}.l > div:nth-child(odd){color:#024}', `${many(3)}<div class="g">${row('g0', 'c t') + many(5)}</div>${many(40)}`, true],
  ['control: a group with a padding (the margin stays inside it)', '.t{margin-top:10px}.l .g{padding-top:1px}', `${many(3)}${group(row('g0', 'c t') + many(5))}${many(40)}`, false],
  ['control: a group that is a flow root', '.t{margin-top:10px}.l .g{display:flow-root}', `${many(3)}${group(row('g0', 'c t') + many(5))}${many(40)}`, false],
  ['control: the first child of the list is a group with a padding', '.t{margin-top:10px}.l .g{padding-top:1px}', `${group(row('g0', 'c t') + many(5))}${many(44)}`, false],
  ['control: the last child of the list is a flow root whose last row has a bottom margin', '.t{margin-bottom:10px}.l .g{display:flow-root}', `${many(44)}${group(many(5) + row('g5', 'c t'))}`, false],
  ['control: plain rows with margins of their own', '.t{margin:7px 0}', `${many(3)}${row('x', 'c t')}${row('y', 'c t')}${many(40)}`, false],
  ['control: no margin anywhere', '', `${many(3)}${group(many(6))}${many(40)}`, false],
];

for (const [what, css, html, own] of CASES) {
  test(`${what}: the pruned tile shows the full tile under it${own ? '' : '; no top margin is written on a spacer'}`, async () => {
    const m = mount(`<div class="l" drawable>${html}</div>`, { css: BASE + css, height: 3000 });
    const el = m.layerEl.firstElementChild;
    let wrote = 0;
    for (const y of [260, 400, 640]) {
      const rect = { x: 0, y, width: 200, height: 80 };
      const full = await rasterize(m.capture(m.request(el, { rect })));
      const pruned = m.capture(m.request(el, { rect, prune: true }));
      const svg = decodeURIComponent(pruned.url);
      assert.ok(/data-hic-sp/.test(svg), 'rows became spacers');
      wrote += (svg.match(/data-hic-sp=""[^>]*margin-top:/g) ?? []).length;
      assert.ok(inkFraction(full) > 0.5);
      const d = diffFraction(await rasterize(pruned), full);
      assert.ok(d <= 0.002, `crop at ${y}: ${(d * 100).toFixed(2)} % of the tile differs`);
    }
    assert.equal(wrote > 0, own, `top margins written on spacers: ${wrote}`);
  });
}
