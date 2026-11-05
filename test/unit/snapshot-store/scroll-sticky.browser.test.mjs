// Scroll compositor, real install: a sticky header without a z-index (or of z-index 0) is pinned where nothing else of the list paints in its layer, and the
// composed steps then equal the settled canvas. A row that the engine paints over such a header where it scrolls under it (position: relative, its own stacking
// context: opacity, a transform), or a flex item whose z-index is above the header's, refuses the plan (refusedBy.sticky): a composed step draws the header's tile
// over the pages and would hide the row. Before, every header without a positive z-index refused the plan, as 'plan'. A row that gets such a layer after
// the plan makes it stale (ScrollPlan.unlayered).
import { test, assert } from '/test/unit/lib/t.js';
import { run } from './_cover-run.mjs';

/** the sticky header without a z-index, and what else the test sets @param {(h: HTMLElement) => void} [more] */
const autoHead = (more) => (/** @type {HTMLElement} */ h) => { /** @type {HTMLElement} */ (h.querySelector('.cv-h')).style.zIndex = 'auto'; more?.(h); };
const row3 = (/** @type {HTMLElement} */ h) => /** @type {HTMLElement} */ (h.querySelectorAll('.cv-r')[3]);

for (const [what, before] of /** @type {Array<[string, (h: HTMLElement) => void]>} */ ([
  ['a sticky header without a z-index (nothing else of the list paints in its layer)', autoHead()],
  ['a sticky header without a z-index with a positioned child of its own', autoHead((h) => { /** @type {HTMLElement} */ (h.querySelector('.cv-h')).innerHTML = '<span style="position:relative;left:4px">HEADER</span>'; })],
  ['a sticky header of z-index 0', (h) => { /** @type {HTMLElement} */ (h.querySelector('.cv-h')).style.zIndex = '0'; }],
])) {
  test(`${what}: the steps are composed and equal the settled canvas`, async (t) => {
    const r = await run(t, { head: true, before });
    assert.equal(r.composed, 3, `composed (${JSON.stringify(r.planned.refusedBy)})`);
    assert.equal(r.bad, 0, `equals the settled canvas (${r.bad})`);
  });
}

// a row painted above a sticky header: the engine draws it over the header where it scrolls under it (row 3 lies under the header at the step to 120 px), so a
// composed step, which draws the header's tile over the pages, would hide it
for (const [what, before] of /** @type {Array<[string, (h: HTMLElement) => void]>} */ ([
  ['a sticky header without a z-index and a row of position: relative after it', autoHead((h) => { row3(h).style.position = 'relative'; })],
  ['a sticky header without a z-index and a row of opacity 0.9 after it (a stacking context of its own)', autoHead((h) => { row3(h).style.opacity = '0.9'; })],
  ['a sticky header without a z-index and a row with a transform after it', autoHead((h) => { row3(h).style.transform = 'translateX(1px)'; })],
  ['a sticky header of z-index 2 in a flex list and a row of z-index 5 without a position (a flex item)', (h) => { /** @type {HTMLElement} */ (h.querySelector('.cv-l')).style.cssText = 'display:flex;flex-direction:column'; row3(h).style.cssText = 'z-index:5;flex:none'; for (const r of h.querySelectorAll('.cv-r, .cv-h')) /** @type {HTMLElement} */ (r).style.flex = 'none'; }],
])) {
  test(`${what}: the plan is refused (refusedBy.sticky) and the steps show what the settled canvas shows`, async (t) => {
    const r = await run(t, { head: true, before });
    assert.equal(r.bad, 0, `no pixel differs from the settled canvas (${r.bad})`);
    assert.equal(r.composed, 0, 'not composed');
    assert.ok(r.planned.refusedBy.sticky >= 1, `refused for the sticky header (${JSON.stringify(r.planned.refusedBy)})`);
  });
}

// after the plan: a row of the list gets a layer of its own (a :hover transform, an opacity transition) under a pinned header without a z-index. The engine now
// paints that row over the header where it scrolls under it (row 3 at the step to 120 px), so the plan is stale: the steps fall back and equal the settled canvas
for (const [what, change] of /** @type {Array<[string, (h: HTMLElement) => void]>} */ ([
  ['opacity 0.9', (h) => { row3(h).style.opacity = '0.9'; }],
  ['a transform', (h) => { row3(h).style.transform = 'translateX(1px)'; }],
])) {
  test(`a sticky header without a z-index, and after the plan a row gets ${what}: the plan is stale and the steps show what the settled canvas shows`, async (t) => {
    const r = await run(t, { head: true, seen: '.cv-h, .cv-r', before: autoHead(), after: change });
    assert.ok(r.planned.pages >= 2 && r.planned.refusals === 0, `planned, pages built (${JSON.stringify(r.planned.refusedBy)})`);
    assert.equal(r.bad, 0, `no pixel differs from the settled canvas (${r.bad})`);
    assert.ok(r.after.stale >= 1, `counted as stale (${r.after.stale})`);
  });
}

test('control: a sticky header without a z-index, and after the plan a row changes its background (no layer of its own): the steps are still composed', async (t) => {
  const r = await run(t, { head: true, seen: '.cv-h, .cv-r', before: autoHead(), after: (h) => { row3(h).style.background = 'rgb(255,128,0)'; } });
  assert.ok(r.composed >= 1, `composed (${r.composed} of 3 steps)`);
  assert.equal(r.bad, 0, `equals the settled canvas (${r.bad})`);
  assert.equal(r.after.stale, 0, 'not stale');
});
