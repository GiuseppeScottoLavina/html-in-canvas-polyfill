// native-controls.js pinnedSize: the size a control's pinned box gets in the image document (docs/TEST-PLAN.md, G-xbrowser and G-mobile `controls`).
// A control drawn by the engines bundle (WebKit, Gecko) has its live border box pinned. A width in px gives that box, but not what the control contributes to the
// intrinsic sizes of its container when the page sized it with a percentage: a percentage counts as `auto` there, a length counts in full (measured in Safari on
// an iPad and in Firefox: a range of `width: 100%` across a grid of `1fr auto` left the `auto` column at its item's min-width, and the readout in it was drawn out
// of its row). Where the page's width holds a percentage, that expression is kept, with the page's own min-width and max-width.
//  - With the CSS Typed OM (WebKit; Chromium has it too, which is how these tests run that path) the page's width is the computed one.
//  - Without it (Gecko; here an element whose computedStyleMap is hidden) it is the width the page's rules declare, where they agree on one.
import { test, assert } from '/test/unit/lib/t.js';
import { pinnedSize } from '/src/snapshot/capture/native-controls.js';
import { declaredWidth } from '/src/snapshot/capture/webkit-caret.js';

const TYPED = typeof Element.prototype.computedStyleMap === 'function';
const tyTest = TYPED ? test : (/** @type {string} */ name) => test.skip(`SKIPPED: no CSS Typed OM in this browser - ${name}`, () => {});

/** A control in a grid of 400 px. @param {any} t @param {string} css of the control @param {{type?: string, typed?: boolean, sheet?: string, cls?: string}} [o] `typed: false` hides the Typed OM */
function control(t, css, { type = 'range', typed = true, sheet = '', cls = '' } = {}) {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:0;top:0;width:400px;display:grid;grid-template-columns:1fr auto';
  if (sheet) host.append(Object.assign(document.createElement('style'), { textContent: sheet }));
  const el = document.createElement('input');
  el.type = type;
  el.className = cls;
  el.style.cssText = css;
  if (!typed) Object.defineProperty(el, 'computedStyleMap', { value: undefined });
  host.append(el);
  document.body.append(host);
  t.cleanup(() => host.remove());
  const cs = getComputedStyle(el);
  return { el, cs, box: { w: el.offsetWidth, h: el.offsetHeight } };
}
const HEIGHT = (/** @type {number} */ h) => `height:${h}px!important;min-height:0!important;max-height:none!important;`;
const FIXED = (/** @type {{w: number, h: number}} */ b, grow = 0) => `box-sizing:border-box!important;width:${b.w + grow}px!important;min-width:0!important;max-width:none!important;${HEIGHT(b.h)}`;
const KEPT = (/** @type {string} */ w, /** @type {number} */ h, min = 'auto', max = 'none') => `box-sizing:border-box!important;width:${w}!important;min-width:${min}!important;max-width:${max}!important;${HEIGHT(h)}`;

for (const typed of [true, false]) {
  const run = typed ? tyTest : test;
  const how = typed ? 'Typed OM' : 'no Typed OM (the page\'s rules)';

  run(`${how}: a control the page sized in px, or left at its own width, is pinned to its live border box with no other limit`, (t) => {
    const a = control(t, 'width:180px;margin:0', { typed });
    assert.equal(pinnedSize(a.el, a.cs, a.box), FIXED(a.box));
    const b = control(t, 'margin:0', { typed });
    assert.equal(pinnedSize(b.el, b.cs, b.box), FIXED(b.box));
    const c = control(t, 'margin:0', { typed, cls: 'k', sheet: '.k{width:12em;min-width:50px;max-width:600px}' });
    assert.equal(pinnedSize(c.el, c.cs, c.box), FIXED(c.box), 'a length: the pinned px is the same box and the same contribution');
    assert.equal(pinnedSize(c.el, c.cs, c.box, 8), FIXED(c.box, 8), 'grown by what the caller adds');
  });

  run(`${how}: a control the page sized with a percentage keeps the percentage, and the page's own limits`, (t) => {
    const a = control(t, 'margin:0', { typed, cls: 'k', sheet: '.k{grid-column:1 / -1;width:100%}' });
    assert.equal(a.box.w, 400);
    assert.equal(pinnedSize(a.el, a.cs, a.box), KEPT('100%', a.box.h));
    assert.equal(pinnedSize(a.el, a.cs, a.box, 8), KEPT('calc(100% + 8px)', a.box.h), 'grown by what the caller adds');
    const b = control(t, 'width:50%;min-width:40px;max-width:90%;margin:0;box-sizing:border-box', { typed, type: 'text' });
    assert.equal(pinnedSize(b.el, b.cs, b.box), KEPT('50%', b.box.h, '40px', '90%'), 'an inline width');
    const c = control(t, 'margin:0;box-sizing:border-box', { typed, type: 'text', cls: 'k2', sheet: '@media (min-width: 1px){@layer page{.k2{grid-column:1 / -1;width:calc(100% - 26px)}}}' });
    assert.equal(pinnedSize(c.el, c.cs, c.box), KEPT('calc(100% - 26px)', c.box.h), 'a calc(), from a rule in a layer under a media condition');
  });

  run(`${how}: under content-box the page's widths leave the padding and the border out: they are added, since the pinned box is a border box`, (t) => {
    const css = 'grid-column:1 / -1;width:calc(100% - 26px);max-width:90%;min-width:30px;padding:3px 8px;border:2px solid;margin:0;';
    const a = control(t, `box-sizing:content-box;${css}`, { typed, type: 'text' });
    const got = pinnedSize(a.el, a.cs, a.box);
    assert.equal(got, KEPT('calc(calc(100% - 26px) + 20px)', a.box.h, 'calc(30px + 20px)', 'calc(90% + 20px)'));
    // the same control laid out again with what was returned has the live box (the box that is pinned)
    const again = control(t, `${css}${got}`, { type: 'text' });
    assert.deepEqual(again.box, a.box);
  });
}

test('no Typed OM: the page\'s rules must agree; an !important rule wins, an inline width wins over plain rules, and a width nobody can read stays a length', (t) => {
  // (one case at a time in the document: the rules of a case match the control of the next one too)
  const of = (/** @type {string} */ sheet, inline = '') => {
    const c = control(t, `margin:0;${inline}`, { typed: false, cls: 'k', sheet });
    const out = { declared: declaredWidth(c.el), pinned: pinnedSize(c.el, c.cs, c.box), box: c.box };
    /** @type {Element} */ (c.el.parentElement).remove();
    return out;
  };
  const agree = of('.k{width:100%}input.k{width:100%}');
  assert.equal(agree.declared, '100%');
  const differ = of('.k{width:100%}input.k{width:60%}');
  assert.equal(differ.declared, '', 'two rules that differ: the cascade order between rules is not resolved');
  assert.equal(differ.pinned, FIXED(differ.box), 'so the px stay');
  assert.equal(of('.k{width:100%!important}input.k{width:60%}').declared, '100%', 'the !important rule wins');
  assert.equal(of('.k{width:60%}', 'width:100%;').declared, '100%', 'the inline width wins over a plain rule');
  assert.equal(of('.k{width:60%!important}', 'width:100%;').declared, '60%', 'an !important rule wins over a plain inline width');
  assert.equal(of('@media (max-width: 1px){.k{width:100%}}').declared, '', 'a rule under a media condition that does not hold is not read');
  const custom = of('.k{--w:100%;width:var(--w);grid-column:1 / -1}');
  assert.equal(custom.pinned, FIXED(custom.box), 'a width from a custom property is not seen as a percentage: the px stay');
  assert.equal(of('').declared, '', 'no rule, no inline width');
});

test('what it is for: a control across a grid of 1fr and auto leaves the auto column to its item; the same width in px does not', (t) => {
  /** where the readout's text lies in a row whose control has `width` @param {string} width */
  const readout = (width) => {
    const row = document.createElement('label');
    row.style.cssText = 'position:absolute;left:0;top:0;width:300px;display:grid;grid-template-columns:1fr auto;gap:2px 10px;font:700 11px sans-serif';
    row.innerHTML = `<span>Frame cap</span><output style="min-width:6ch;text-align:right;white-space:nowrap">120 fps (display)</output><input type="range" style="grid-column:1 / -1;margin:0;appearance:none;height:20px;box-sizing:border-box;${width}">`;
    document.body.append(row);
    t.cleanup(() => row.remove());
    const range = document.createRange();
    range.selectNodeContents(/** @type {Element} */ (row.children[1]));
    return { left: range.getBoundingClientRect().left, right: range.getBoundingClientRect().right, control: /** @type {HTMLElement} */ (row.children[2]).offsetWidth };
  };
  const page = readout('width:100%');
  assert.equal(page.control, 300);
  assert.ok(Math.abs(page.right - 300) < 0.6, `the page: the readout ends at the row's edge (${page.right})`);
  const kept = readout('width:100%!important;min-width:auto!important;max-width:none!important');
  assert.ok(Math.abs(kept.left - page.left) < 0.1 && kept.control === 300, 'the percentage kept: the same row');
  // control: the px pin is the same box, and moves the readout out of the row (the control's 300 px go to the 1fr column; measured in Chromium, WebKit and Gecko)
  const px = readout('width:300px!important;min-width:0!important;max-width:none!important');
  assert.equal(px.control, 300);
  assert.ok(px.left - page.left > 20 && px.right > 320, `the px pin moves the readout (${page.left} to ${px.left}, ending at ${px.right})`);
});
