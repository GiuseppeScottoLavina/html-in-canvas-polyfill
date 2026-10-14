// Regression tests of the correctness review (M2): hit-test geometry of several elements drawn in one task.
import { test, assert } from '/test/unit/lib/t.js';
import { inst, mk, frames } from '../api-core/_real.mjs';

const HTML = '<div id="p" drawable style="width:100px;height:50px;background:red">p</div><div id="q" drawable style="width:100px;height:50px;background:blue">q</div>';

/** @param {DOMRect} r @param {number} x @param {number} y @returns {string} */
const topAt = (r, x, y) => (document.elementsFromPoint(r.left + x, r.top + y)[0]?.id || document.elementsFromPoint(r.left + x, r.top + y)[0]?.localName);

for (const [name, order] of /** @type {Array<[string, string[]]>} */ ([['p then q', ['p', 'q']], ['q then p', ['q', 'p']]])) {
  test(`M2: ${name} drawn in the same task are both hit-testable`, async t => {
    const i = inst(t);
    const c = await mk(t, i, { w: 300, h: 150, inner: HTML });
    const ctx = /** @type {any} */ (c.getContext('2d'));
    const at = { p: [10, 10], q: [60, 20] };
    for (const id of order) ctx.drawElementImage(c.querySelector(`#${id}`), ...at[/** @type {'p'|'q'} */ (id)]);
    await frames(3);
    const r = c.getBoundingClientRect();
    assert.equal(topAt(r, 20, 20), 'p', 'a point only p covers');
    assert.equal(topAt(r, 150, 40), 'q', 'a point only q covers');
  });
}
