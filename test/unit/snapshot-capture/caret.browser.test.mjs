// Caret and selection: measured, not drawn into the tile.
import { test, assert } from '/test/unit/lib/t.js';
import { mount, rasterize, diffFraction } from './_support.mjs';
import { measureCaret } from '/src/snapshot/capture/caret-overlay.js';

const css = '.d{width:260px;height:120px;font:16px sans-serif;background:#fff}.i{display:block;box-sizing:border-box;width:200px;height:30px;padding:2px 6px;border:2px solid #888;font:16px sans-serif;margin:4px}textarea.i{height:60px;resize:none}';

/** width of `text` in the font of `el`, measured by the browser with a real span */
function spanWidth(el, text) {
  const s = document.createElement('span');
  s.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${getComputedStyle(el).font}`;
  s.textContent = text;
  document.body.append(s);
  const w = s.getBoundingClientRect().width;
  s.remove();
  return w;
}

const interaction = (focus) => ({ hover: new Set(), active: new Set(), focus, focusVisible: true, caretVisible: true });

test('input caret: x follows the text before it, 1 css px wide, in the caret-color; the tile has no caret', async () => {
  const m = mount('<div class="d" drawable><input class="i" value="hello world" style="caret-color:#f0f"></div>', { css });
  const input = m.layerEl.querySelector('input');
  input.focus();
  input.setSelectionRange(5, 5);
  const el = m.layerEl.firstElementChild;
  const r = m.capture(m.request(el, { interaction: interaction(input) }));
  assert.ok(r.caret, 'caret measured');
  const box = m.layer.frameRect(input);
  const expected = box.x + 2 + 6 + spanWidth(input, 'hello');
  assert.ok(Math.abs(r.caret.rect.x - expected) < 0.75, `x ${r.caret.rect.x} vs ${expected}`);
  assert.equal(r.caret.rect.width, 1);
  assert.ok(r.caret.rect.height > 12 && r.caret.rect.height < 24);
  assert.ok(r.caret.rect.y >= box.y && r.caret.rect.y + r.caret.rect.height <= box.y + box.height);
  assert.equal(r.caret.color, 'rgb(255, 0, 255)');
  // the tile is the same with the caret at another position: the caret is not drawn into it
  input.setSelectionRange(2, 2);
  const r2 = m.capture(m.request(el, { interaction: interaction(input) }));
  assert.ok(Math.abs(r2.caret.rect.x - (box.x + 8 + spanWidth(input, 'he'))) < 0.75);
  assert.ok(diffFraction(await rasterize(r), await rasterize(r2)) < 0.001, 'tiles do not depend on the caret position');
  // no caret without focus in this drawable, none for a selection range
  assert.equal(m.capture(m.request(el)).caret, null);
  input.setSelectionRange(1, 4);
  assert.equal(m.capture(m.request(el, { interaction: interaction(input) })).caret, null);
});

test('text selection of an input is drawn into the tile and stays inside the control', async () => {
  const m = mount('<div class="d" drawable><input class="i" value="hello world"></div>', { css });
  const input = m.layerEl.querySelector('input');
  input.focus();
  const el = m.layerEl.firstElementChild;
  input.setSelectionRange(3, 3);
  const plain = await rasterize(m.capture(m.request(el, { interaction: interaction(input) })));
  input.setSelectionRange(0, 5);
  const sel = await rasterize(m.capture(m.request(el, { interaction: interaction(input) })));
  const d = diffFraction(plain, sel);
  assert.ok(d > 0.004 && d < 0.1, `selection changes ${(d * 100).toFixed(2)} %`);
  const probe = sel.getImageData(12 + Math.round(spanWidth(input, 'he')), 12, 1, 1).data;
  const base = plain.getImageData(12 + Math.round(spanWidth(input, 'he')), 12, 1, 1).data;
  assert.notEqual(probe.join(), base.join());
});

test('centered and right aligned text moves the caret', () => {
  const m = mount('<div class="d" drawable><input class="i" value="abc" style="text-align:right"></div>', { css });
  const input = m.layerEl.querySelector('input');
  input.focus();
  input.setSelectionRange(3, 3);
  const box = m.layer.frameRect(input);
  const c = measureCaret(document, input, box);
  const rightEdge = box.x + 2 + input.clientWidth - 6;
  assert.ok(Math.abs(c.rect.x - rightEdge) < 1.5, `${c.rect.x} vs ${rightEdge}`);
});

test('textarea caret moves down a line after a newline and wraps long lines', () => {
  const m = mount('<div class="d" drawable><textarea class="i">first\nsecond line is quite long so that it wraps around the box</textarea></div>', { css });
  const ta = m.layerEl.querySelector('textarea');
  ta.focus();
  const box = m.layer.frameRect(ta);
  ta.setSelectionRange(0, 0);
  const a = measureCaret(document, ta, box);
  ta.setSelectionRange(8, 8);
  const b = measureCaret(document, ta, box);
  ta.setSelectionRange(ta.value.length, ta.value.length);
  const c = measureCaret(document, ta, box);
  assert.ok(b.rect.y > a.rect.y + 10, 'second paragraph is lower');
  assert.ok(c.rect.y > b.rect.y + 10, 'wrapping adds a line');
  assert.ok(b.rect.x > a.rect.x);
});

test('contenteditable caret comes from the selection range', () => {
  const m = mount('<div class="d" drawable><div class="i" contenteditable style="height:auto">editable text</div></div>', { css });
  const ed = m.layerEl.querySelector('[contenteditable]');
  ed.focus();
  const range = document.createRange();
  range.setStart(ed.firstChild, 4);
  range.collapse(true);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const box = m.layer.frameRect(ed);
  const c = measureCaret(document, ed, box);
  assert.ok(c, 'caret');
  assert.ok(Math.abs(c.rect.x - (box.x + 2 + 6 + spanWidth(ed, 'edit'))) < 1.5);
});

test('m7: an author ::selection background colours the drawn input selection (and the system highlight is used without one)', async () => {
  const m = mount('<div class="d" drawable><input class="i" value="hello world"></div>', { css: `${css}::selection{background:rgb(255,0,255)}` });
  const input = m.layerEl.querySelector('input');
  input.focus();
  input.setSelectionRange(0, 5);
  const sel = await rasterize(m.capture(m.request(m.layerEl.firstElementChild, { interaction: interaction(input) })));
  // the most common colour of the selected text row is the author background; the glyphs are drawn over it (not hidden by it)
  const d = sel.getImageData(12, 12, Math.round(spanWidth(input, 'hello')) - 2, 12).data;
  const n = new Map();
  let dark = 0;
  for (let i = 0; i < d.length; i += 4) { const k = `${d[i]},${d[i + 1]},${d[i + 2]}`; n.set(k, (n.get(k) ?? 0) + 1); if (d[i] < 100 && d[i + 2] < 100) dark++; }
  const [r, g, b] = [...n.entries()].sort((x, y) => y[1] - x[1])[0][0].split(',').map(Number);
  assert.ok(r > 200 && g < 60 && b > 200, `author selection colour expected, got ${[r, g, b]}`);
  assert.ok(dark > 10, `the selected glyphs are visible over the author background (${dark} glyph pixels)`);
});

test('m7 control: without an author ::selection rule the input selection is the system highlight, not magenta', async () => {
  const m2 = mount('<div class="d" drawable><input class="i" value="hello world"></div>', { css });
  const input2 = m2.layerEl.querySelector('input');
  input2.focus();
  input2.setSelectionRange(0, 5);
  const sys = await rasterize(m2.capture(m2.request(m2.layerEl.firstElementChild, { interaction: interaction(input2) })));
  const x = 12 + Math.round(spanWidth(input2, 'he'));
  const [r2, g2, b2] = sys.getImageData(x, 12, 1, 1).data;
  assert.ok(!(r2 > 200 && g2 < 60 && b2 > 200), 'the system highlight, not the author colour');
});

// The selection colours on dark and light controls, per platform model: selection.browser.test.mjs.

test('email and number inputs (selectionStart null): the caret is still measured, at the end after focus, at a press, after an edit', async () => {
  const { noteCaretEvent, noteCaretPoint } = await import('/src/util/caret-index.js');
  const m = mount('<div class="d" drawable><input class="i" type="email" value="ada@example.com"><input class="i" type="number" value="1234"></div>', { css });
  const el = m.layerEl.firstElementChild;
  const [email, num] = m.layerEl.querySelectorAll('input');
  assert.equal(email.selectionStart, null, 'precondition: the engine hides the selection of type=email');
  const left = (input) => m.layer.frameRect(input).x + 8;
  // the InteractionTracker feeds these events in the runtime (not attached by mount): feed them the same way
  const fire = (input, ev) => { input.dispatchEvent(ev); noteCaretEvent(ev); };
  const caretX = (input) => m.capture(m.request(el, { interaction: interaction(input) })).caret?.rect.x;
  // regression (Chrome): no caret at all in a focused type=email
  email.focus();
  noteCaretEvent(new FocusEvent('focusin', { bubbles: true })); // a synthetic event has no target: ignored, never throws
  fire(email, new FocusEvent('focusin', { bubbles: true }));
  const end = caretX(email);
  assert.ok(end !== undefined, 'caret measured for type=email');
  assert.ok(Math.abs(end - (left(email) + spanWidth(email, 'ada@example.com'))) < 0.75, `end ${end}`);
  // a press between "ada" and "@": the caret snaps to that boundary
  const r = email.getBoundingClientRect();
  noteCaretPoint(email, r.left + 8 + spanWidth(email, 'ada') + 1);
  assert.ok(Math.abs(caretX(email) - (left(email) + spanWidth(email, 'ada'))) < 0.75, 'caret at the pressed boundary');
  // typing "X" there: the caret follows the edit (diff of the values)
  email.value = 'adaX@example.com';
  fire(email, new InputEvent('input', { bubbles: true }));
  assert.ok(Math.abs(caretX(email) - (left(email) + spanWidth(email, 'adaX'))) < 0.75, 'caret after the inserted character');
  fire(email, new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  assert.ok(Math.abs(caretX(email) - left(email)) < 0.75, 'Home moves it to the start');
  num.focus();
  fire(num, new FocusEvent('focusin', { bubbles: true }));
  assert.equal(num.selectionStart, null);
  assert.ok(Math.abs(caretX(num) - (left(num) + spanWidth(num, '1234'))) < 0.75, 'type=number caret at the end');
});
