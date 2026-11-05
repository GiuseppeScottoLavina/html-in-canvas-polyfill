// Scroll compositor, real install (the run of _cover-run.mjs: a list of 120 rows in a 400 x 260 drawable, planned, three scroll steps each read in the paint that
// follows it and compared with the settled canvas half a second later), what lies outside the list over its port:
//   - A box of exactly a cover colour (opaque or at alpha 0.5; pointer-events: none): one colour alone, that of 0.1.0-preview.24, passed the first and the box
//     travelled with the list (24,000 pixels wrong over the three steps); the check renders the port in two colours, and the plan is refused (refusedBy.cover).
//   - A box of opacity 0 (its own or a wrapper's) paints nothing: a row that changes under it after the plan keeps the cache, the steps are composed (before the fix
//     the change was an obstruction and the cache was dropped). Once it turns opacity 1 or 0.02 after the plan, the step falls back to the plain path.
import { test, assert } from '/test/unit/lib/t.js';
import { run } from './_cover-run.mjs';

for (const [what, extra] of [
  ['a box of exactly the first cover colour, rgb(1, 254, 3)', '<div class="cv-o" style="pointer-events:none;background:rgb(1,254,3)"></div>'],
  ['a box of the first cover colour at alpha 0.5', '<div class="cv-o" style="pointer-events:none;background:rgba(1,254,3,0.5)"></div>'],
  ['a box of exactly the second cover colour, rgb(254, 1, 252)', '<div class="cv-o" style="pointer-events:none;background:rgb(254,1,252)"></div>'],
]) {
  test(`${what}: the plan is refused (refusedBy.cover), the step is not composed and shows what the settled canvas shows`, async (t) => {
    const r = await run(t, { extra });
    assert.equal(r.bad, 0, `no pixel differs from the settled canvas (${r.bad})`);
    assert.equal(r.composed, 0, 'not composed');
    assert.ok(r.planned.refusedBy.cover >= 1, `refused for the cover (${JSON.stringify(r.planned.refusedBy)})`);
  });
}

for (const [what, extra] of [['a box of opacity 0', '<div class="cv-o" style="pointer-events:none;opacity:0"></div>'], ['a box in a wrapper of opacity 0', '<div class="cv-w" style="position:absolute;left:0;top:0;opacity:0"><div class="cv-o" style="pointer-events:none"></div></div>']]) {
  test(`after the plan, a row of the list under ${what} changes: the box paints nothing, the step is still composed`, async (t) => {
    // the row under the box (60-90 css px of the port) at scrollTop 1; before the fix the change was an obstruction, and the cache was dropped (0 of 3 composed)
    const r = await run(t, { extra, seen: '.cv-o, .cv-w, .cv-r:nth-child(3)', after: (h) => { /** @type {HTMLElement} */ (h.querySelectorAll('.cv-r')[2]).style.background = 'rgb(255,128,0)'; } });
    assert.ok(r.composed >= 1, `composed (${r.composed} of 3 steps)`);
    assert.equal(r.bad, 0, `equals the settled canvas (${r.bad})`);
    assert.equal(r.after.obstructed, 0, 'no obstruction');
  });
}

for (const [what, extra, sel, to] of [['a box of opacity 0', '<div class="cv-o" style="pointer-events:none;opacity:0"></div>', '.cv-o', '1'], ['a box of opacity 0', '<div class="cv-o" style="pointer-events:none;opacity:0"></div>', '.cv-o', '0.02'],
  ['a wrapper of opacity 0', '<div class="cv-w" style="position:absolute;left:0;top:0;opacity:0"><div class="cv-o" style="pointer-events:none"></div></div>', '.cv-w', '1']]) {
  test(`after the plan, ${what} over the port turns opacity ${to}: the step falls back to the plain path`, async (t) => {
    const r = await run(t, { extra, seen: '.cv-o, .cv-w', after: (h) => { /** @type {HTMLElement} */ (h.querySelector(sel)).style.opacity = to; } });
    assert.ok(r.planned.pages >= 2 && r.planned.refusals === 0, 'planned, pages built');
    assert.equal(r.bad, 0, `no pixel differs from the settled canvas (${r.bad})`);
    assert.equal(r.composed, 0, 'not composed');
    assert.ok(r.after.obstructed >= 1, 'counted as an obstruction');
  });
}
