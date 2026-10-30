// A script write to a form control's state (range.value, checked, selectedIndex, option.selected, textarea.value, stepUp, valueAsNumber, indeterminate, form.reset())
// repaints the control (observers/control-state.js). That state reflects no attribute, so no MutationObserver record announces it: before the observer a slider set by
// script kept its old thumb wherever no other damage covered it (the CRT gallery's Glow slider showed two thumbs after the Monitor and Arcade presets).
// Oracle: the canvas after the write equals a full rebuild of the drawable (an attribute change on it), and (positive control) the write is visible: the canvas
// before the write differs from that rebuild.
import { test, assert } from '/test/unit/lib/t.js';
import { inst, sleep } from '../api-core/_real.mjs';

const FORM = '<form id="f" drawable style="width:236px;padding:8px;background:#fff;color:#000;font:14px/18px sans-serif;accent-color:#0a6">'
  + '<input id="range" type="range" min="0" max="100" value="70" style="display:block;width:220px;margin:4px 0">'
  + '<input id="text" value="first" style="display:block;width:200px">'
  + '<input id="check" type="checkbox" checked><input id="r1" type="radio" name="g" checked><input id="r2" type="radio" name="g">'
  + '<select id="sel" style="display:block;width:120px"><option>Arcade</option><option>Monitor</option></select>'
  + '<textarea id="ta" rows="2" style="display:block;width:200px">one</textarea>'
  + '<input id="num" type="number" value="5" style="display:block;width:80px"></form>';

/** @param {any} t */
async function rig(t) {
  const i = inst(t);
  const host = document.createElement('div');
  host.innerHTML = `<canvas content="drawable" width="260" height="260" style="width:260px;height:260px">${FORM}</canvas>`;
  document.body.append(host);
  t.cleanup(() => host.remove());
  const c = /** @type {HTMLCanvasElement} */ (host.querySelector('canvas'));
  const ctx = /** @type {any} */ (c.getContext('2d'));
  const form = /** @type {HTMLFormElement} */ (host.querySelector('#f'));
  let paints = 0;
  c.onpaint = () => { paints++; ctx.reset(); ctx.drawElementImage(form, 0, 0); };
  c.requestPaint();
  await i.whenPainted(c);
  /** settled: no paint for 250 ms (bounded: 3 s) */
  const settle = async () => {
    for (let k = 0; k < 30; k++) { const n = paints; await sleep(250); if (n === paints) return; }
  };
  await settle();
  const pixels = () => ctx.getImageData(0, 0, c.width, c.height).data;
  // a tile that cuts a control renders its antialiased edges up to 17 levels off a whole tile (measured: the radio rings beside the checkbox's tile); a stale
  // control differs by far more (a thumb, a check mark, a glyph: over 100 levels), so a pixel counts above 32 levels in a channel
  /** @param {Uint8ClampedArray} a @param {Uint8ClampedArray} b @returns {number} */
  const differing = (a, b) => { let n = 0; for (let k = 0; k < a.length; k += 4) if (Math.abs(a[k] - b[k]) > 32 || Math.abs(a[k + 1] - b[k + 1]) > 32 || Math.abs(a[k + 2] - b[k + 2]) > 32) n++; return n; };
  let serial = 0;
  /** a whole rebuild of the drawable: what the canvas must show */
  const truth = async () => { form.setAttribute('data-truth', String(++serial)); await settle(); return pixels(); };
  await truth();
  const $ = (/** @type {string} */ id) => /** @type {any} */ (form.querySelector(`#${id}`));
  return { $, form, pixels, differing, settle, truth, paints: () => paints };
}

/** @type {Array<[string, (q: (id: string) => any, form: HTMLFormElement) => void]>} */
const WRITES = [
  ['range.value', ($) => { $('range').value = '20'; }],
  ['range.valueAsNumber', ($) => { $('range').valueAsNumber = 95; }],
  ['input.value (text)', ($) => { $('text').value = 'second value'; }],
  ['checkbox.checked', ($) => { $('check').checked = false; }],
  ['checkbox.indeterminate', ($) => { $('check').indeterminate = true; }],
  ['radio.checked (the other radio of the group unchecks)', ($) => { $('r2').checked = true; }],
  ['select.selectedIndex', ($) => { $('sel').selectedIndex = 1; }],
  ['select.value', ($) => { $('sel').value = 'Arcade'; }],
  ['option.selected', ($) => { $('sel').options[1].selected = true; }],
  ['textarea.value', ($) => { $('ta').value = 'two\nlines'; }],
  ['input.stepUp()', ($) => { $('num').stepUp(40); }],
  ['input.setRangeText()', ($) => { $('text').setRangeText('WIDE TEXT', 0, 6); }],
  ['form.reset()', (_, form) => { form.reset(); }],
];

test('a script write to a control\'s state repaints it: the canvas equals a full rebuild after each write', async (t) => {
  const r = await rig(t);
  /** @type {string[]} */
  const stale = [];
  /** @type {string[]} */
  const invisible = [];
  for (const [name, write] of WRITES) {
    const before = r.pixels();
    write(r.$, r.form);
    await r.settle();
    const after = r.pixels();
    const want = await r.truth();
    if (r.differing(before, want) < 20) invisible.push(name);
    const off = r.differing(after, want);
    if (off > 0) stale.push(`${name}: ${off} px`);
  }
  assert.ok(invisible.length === 0, `positive control: every write changes the picture (else the comparison proves nothing); unchanged: ${invisible.join('; ')}`);
  assert.ok(stale.length === 0, `the canvas shows each write without any other damage; stale: ${stale.join('; ')}`);
}, { timeout: 60000 });

test('a write that leaves the state as it was repaints nothing (no paint event)', async (t) => {
  const r = await rig(t);
  const n = r.paints();
  r.$('range').value = '70';
  r.$('check').checked = true;
  r.$('sel').selectedIndex = 0;
  r.$('text').value = 'first';
  await sleep(400);
  assert.equal(r.paints(), n, 'no paint after writes of the current state');
  r.$('range').value = '10';
  await r.settle();
  assert.ok(r.paints() > n, 'positive control: a write that changes the state paints');
}, { timeout: 20000 });
