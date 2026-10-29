import { test, assert, fixture, frames, microtasks } from '/test/unit/lib/t.js';
import { createRig } from './_dom.js';
import { observeMutations } from '/src/schedule/observers/mutation-observer.js';
import { BUS } from '/src/contracts/events.js';
import { paintInkOf } from '/src/live/measure.js';

const PAGE = '<div drawable id="d1" style="width:200px"><p id="p1">hello</p><div id="box" style="width:50px;height:20px;background:#eee"></div></div><div drawable id="d2"><span id="s">x</span></div>';

test('childList change is structural: whole drawable, cause mutation', async t => {
  const rig = createRig({ html: PAGE });
  t.cleanup(observeMutations(rig.env, rig.record));
  rig.layerEl.querySelector('#d1').append(document.createElement('i'));
  await microtasks();
  assert.equal(rig.sink.damage.length, 1);
  assert.equal(rig.sink.damage[0].cause, 'mutation');
  assert.equal(rig.sink.damage[0].drawable.id, 'd1');
  assert.equal(rig.sink.damage[0].rect, null);
});

test('attribute change: first sight is whole-drawable, then a same-size element gets a local rect', async t => {
  const rig = createRig({ html: PAGE });
  t.cleanup(observeMutations(rig.env, rig.record));
  const box = rig.layerEl.querySelector('#box');
  box.setAttribute('data-x', '1');
  await microtasks();
  assert.equal(rig.sink.damage[0].rect, null, 'first sighting cannot know what moved');
  rig.sink.clear();
  box.style.background = '#f00';
  await microtasks();
  assert.equal(rig.sink.damage.length, 1);
  const r = rig.sink.damage[0].rect;
  assert.ok(r && r.width >= 50 && r.width <= 50 + 48 && r.height >= 20, `local rect ${JSON.stringify(r)}`);
  assert.equal(rig.sink.damage[0].drawable.id, 'd1');
});

test('a box that changes size is whole-drawable again (siblings may have moved)', async t => {
  const rig = createRig({ html: PAGE });
  t.cleanup(observeMutations(rig.env, rig.record));
  const box = rig.layerEl.querySelector('#box');
  box.style.color = 'red';
  await microtasks();
  rig.sink.clear();
  box.style.height = '60px';
  await microtasks();
  assert.equal(rig.sink.damage[0].rect, null);
});

test('text change maps to the parent element and its drawable', async t => {
  const rig = createRig({ html: PAGE });
  t.cleanup(observeMutations(rig.env, rig.record));
  rig.layerEl.querySelector('#s').firstChild.data = 'changed';
  await microtasks();
  assert.equal(rig.sink.damage.length, 1);
  assert.equal(rig.sink.damage[0].drawable.id, 'd2');
});

test('polyfill writes are ignored: data-hic-*, aria-owns, generated owns ids, managed nodes; real changes in the same batch still count', async t => {
  const rig = createRig({ html: PAGE });
  t.cleanup(observeMutations(rig.env, rig.record));
  const d1 = rig.layerEl.querySelector('#d1');
  d1.setAttribute('data-hic-hit', 'k1');
  d1.setAttribute('aria-owns', 'x');
  rig.layerEl.setAttribute('style', 'position:relative;width:200px;opacity:0');
  const node = document.createElement('div');
  node.setAttribute('data-hic-node', '');
  d1.append(node);
  d1.querySelector('#p1').id = 'hic-o-1';
  await microtasks();
  assert.equal(rig.sink.damage.length, 0, 'nothing from the polyfill');
  d1.querySelector('#hic-o-1').setAttribute('title', 'real');
  await microtasks();
  assert.equal(rig.sink.damage.length, 1, 'positive control: a real attribute change is seen');
});

test('adding and removing drawables emits DRAWABLES_CHANGED with the diff; the nested parent is damaged', async t => {
  const rig = createRig({ html: PAGE });
  const events = [];
  rig.bus.on(BUS.DRAWABLES_CHANGED, e => events.push(e));
  t.cleanup(observeMutations(rig.env, rig.record));
  const added = document.createElement('div');
  added.setAttribute('drawable', '');
  rig.layerEl.append(added);
  await microtasks();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].added, [added]);
  assert.deepEqual(events[0].removed, []);
  const nested = document.createElement('div');
  nested.setAttribute('drawable', '');
  rig.layerEl.querySelector('#d1').append(nested);
  await microtasks();
  rig.sink.clear();
  nested.remove();
  await microtasks();
  assert.deepEqual(events.at(-1).removed, [nested]);
  assert.equal(rig.sink.damage.some(d => d.drawable.id === 'd1' && d.rect === null), true, 'the ancestor drawable is damaged so changedElements can list it');
});

test('the drawable attribute toggled on an element recomputes the set', async t => {
  const rig = createRig({ html: '<div id="a"><b id="b">x</b></div>' });
  const events = [];
  rig.bus.on(BUS.DRAWABLES_CHANGED, e => events.push(e));
  t.cleanup(observeMutations(rig.env, rig.record));
  rig.layerEl.querySelector('#a').setAttribute('drawable', '');
  await microtasks();
  assert.equal(events.length, 1);
  assert.equal(events[0].added[0].id, 'a');
});

test('disposer disconnects', async t => {
  const rig = createRig({ html: PAGE });
  const stop = observeMutations(rig.env, rig.record);
  stop();
  rig.layerEl.querySelector('#d1').append(document.createElement('i'));
  await frames(1);
  assert.equal(rig.sink.damage.length, 0);
});

test('a mutation outside every drawable can move a drawable: the geometry offsets are re-measured once per batch; changes inside a drawable do not touch layout', async t => {
  const rig = createRig({ html: '<div id="gap" style="height:0"></div><div drawable id="only"><p id="p1">hello</p><div id="box" style="width:50px;height:20px"></div></div>' });
  t.cleanup(observeMutations(rig.env, rig.record));
  rig.layerEl.querySelector('#p1').textContent = 'typing';
  rig.layerEl.querySelector('#p1').firstChild.data = 'typing more';
  rig.layerEl.querySelector('#box').style.background = '#f00';
  await microtasks();
  assert.equal(rig.layer.revalidations, 0, 'text and style inside the only drawable: no re-measure (typing must stay cheap)');
  const gap = rig.layerEl.querySelector('#gap');
  gap.style.height = '40px';
  gap.setAttribute('data-x', '1');
  await microtasks();
  assert.equal(rig.layer.revalidations, 1, 'a sibling of the drawables changed size: one re-measure for the whole batch');
  rig.layerEl.insertBefore(document.createElement('div'), rig.layerEl.firstChild);
  await microtasks();
  assert.equal(rig.layer.revalidations, 2, 'content inserted before the drawables');
});

test('a drawable that restyles ITSELF (margin, position) can move: re-measured', async t => {
  const rig = createRig({ html: PAGE });
  t.cleanup(observeMutations(rig.env, rig.record));
  rig.layerEl.querySelector('#d1').style.marginLeft = '30px';
  await microtasks();
  assert.equal(rig.layer.revalidations, 1);
});

test('a structural change inside one of SEVERAL drawables can move the next one: re-measured; a text edit is not structural', async t => {
  const rig = createRig({ html: PAGE });
  t.cleanup(observeMutations(rig.env, rig.record));
  rig.layerEl.querySelector('#p1').firstChild.data = 'edited';
  await microtasks();
  assert.equal(rig.layer.revalidations, 0);
  rig.layerEl.querySelector('#d1').append(document.createElement('i'));
  await microtasks();
  assert.equal(rig.layer.revalidations, 1);
});

test('mutations inside an open shadow root of a drawable (also one attached later) damage the whole drawable (X-13)', async t => {
  const rig = createRig({ html: PAGE });
  const sr = rig.layerEl.querySelector('#box').attachShadow({ mode: 'open' });
  sr.innerHTML = '<b id="in">a</b>';
  t.cleanup(observeMutations(rig.env, rig.record));
  sr.querySelector('#in').textContent = 'b';
  await microtasks();
  assert.equal(rig.sink.damage.length, 1, 'a MutationObserver does not cross the shadow boundary by itself');
  assert.equal(rig.sink.damage[0].drawable.id, 'd1');
  assert.equal(rig.sink.damage[0].rect, null);
  rig.sink.clear();
  const host2 = document.createElement('span');
  rig.layerEl.querySelector('#s').append(host2);
  const sr2 = host2.attachShadow({ mode: 'open' });
  await microtasks();
  rig.sink.clear();
  sr2.append(document.createElement('i'));
  await microtasks();
  assert.equal(rig.sink.damage.length, 1);
  assert.equal(rig.sink.damage[0].drawable.id, 'd2');
});

// a resize is bounded by the nearest unchanged ancestor, and text replaced through textContent is not structural
const APP = '<div drawable id="app" style="width:400px"><header id="hd" style="display:flex;justify-content:space-between;align-items:center;height:40px"><h1 id="t" style="margin:0;font:20px Arial">Title</h1><nav>menu</nav></header>'
  + '<main id="mn" style="height:600px;background:#eee"></main></div>';

test('a heading that changes width inside a fixed-size header damages the header, not the drawable (after the chain was seen once)', async t => {
  const rig = createRig({ html: APP });
  t.cleanup(observeMutations(rig.env, rig.record));
  const h1 = rig.layerEl.querySelector('#t');
  h1.textContent = 'Title one';
  await microtasks();
  assert.equal(rig.sink.damage[0].rect, null, 'first sighting: nothing recorded yet, whole drawable');
  rig.sink.clear();
  h1.textContent = 'A much longer title now';
  await microtasks();
  assert.equal(rig.sink.damage.length, 1);
  const r = rig.sink.damage[0].rect;
  const hd = rig.layerEl.querySelector('#hd').getBoundingClientRect();
  assert.ok(r, 'bounded by the header');
  assert.ok(r.height <= hd.height + 2 * 24 + 1 && r.width <= hd.width + 2 * 24 + 1, `header-sized rect ${JSON.stringify(r)}`);
  assert.ok(r.y + r.height < 200, 'the main area below is not damaged');
});

// A counter that changes width in a fixed-size row of a large drawable: once the row's children were seen, the damage is the children that moved, not the drawable
const ROW = (extra = '') => '<div drawable id="d" style="width:400px;height:600px;display:flex;flex-wrap:wrap;align-content:flex-start;justify-content:center">'
  + '<span id="label" style="font:20px Arial">score</span><span id="n" style="font:64px Georgia">1</span><span id="pts" style="font:20px Arial">pts</span>'
  + `<div id="filler" style="width:100%;font:9px Arial">${'<span>cell </span>'.repeat(300)}</div>${extra}</div>`;

/** @param {any} rig @param {Element} n @param {string[]} values the last value's damage is returned */
async function damageAfter(rig, n, values) {
  for (const v of values) { rig.sink.clear(); n.firstChild.data = v; await microtasks(); }
  return rig.sink.damage;
}

test('a counter that changes width in a fixed-size drawable row damages the row (the children that moved), not the whole drawable', async t => {
  const rig = createRig({ html: ROW() });
  t.cleanup(observeMutations(rig.env, rig.record));
  const n = rig.layerEl.querySelector('#n');
  const first = await damageAfter(rig, n, ['22']);
  assert.equal(first[0].rect, null, 'first sighting: the children were never measured, whole drawable');
  const [d] = await damageAfter(rig, n, ['333', '4444']);
  assert.ok(d.rect, 'bounded by the children of the unchanged drawable');
  const label = rig.layer.frameRect(rig.layerEl.querySelector('#label'));
  const filler = rig.layer.frameRect(rig.layerEl.querySelector('#filler'));
  assert.ok(d.rect.x <= label.x && d.rect.x + d.rect.width >= label.x + label.width, `covers the label that moved: ${JSON.stringify(d.rect)} vs ${JSON.stringify(label)}`);
  assert.ok(d.rect.y + d.rect.height <= filler.y + 24 + 0.01, `stops at the ink margin above the filler that did not move: ${JSON.stringify(d.rect)} vs ${JSON.stringify(filler)}`);
});

test('row damage falls back to the whole drawable: text or generated content of the unchanged parent, a display:contents child, a child never measured', async t => {
  const cases = {
    'text of the parent': ROW('tail text'),
    'generated content': ROW('<style>#d::after{content:"!"}</style>'),
    'display: contents child': ROW('<div style="display:contents"><b>x</b></div>'),
  };
  for (const [name, html] of Object.entries(cases)) {
    const rig = createRig({ html });
    const off = observeMutations(rig.env, rig.record);
    const n = rig.layerEl.querySelector('#n');
    const [d] = await damageAfter(rig, n, ['22', '333', '4444']);
    off();
    assert.equal(d.rect, null, `${name}: whole drawable`);
  }
  const rig = createRig({ html: ROW() });
  t.cleanup(observeMutations(rig.env, rig.record));
  const n = rig.layerEl.querySelector('#n');
  await damageAfter(rig, n, ['22', '333']);
  const late = document.createElement('span');
  late.textContent = 'late';
  rig.layerEl.querySelector('#d').insertBefore(late, rig.layerEl.querySelector('#filler'));
  await microtasks();
  const [d] = await damageAfter(rig, n, ['4444']);
  assert.equal(d.rect, null, 'a child that appeared since the last measurement: whole drawable');
});

test('when the header itself grows, the damage climbs to the drawable (whole), since everything below may have moved', async t => {
  const rig = createRig({ html: APP.replace('height:40px', 'min-height:40px') });
  t.cleanup(observeMutations(rig.env, rig.record));
  const h1 = rig.layerEl.querySelector('#t');
  h1.textContent = 'Title one';
  await microtasks();
  rig.sink.clear();
  h1.style.fontSize = '60px';
  await microtasks();
  assert.equal(rig.sink.damage[0].rect, null);
});

test('textContent of a text-only element is a local change (no drawable can appear); an element child is still structural', async t => {
  const rig = createRig({ html: APP });
  t.cleanup(observeMutations(rig.env, rig.record));
  const nav = rig.layerEl.querySelector('nav');
  nav.textContent = 'menu!';
  await microtasks();
  rig.sink.clear();
  nav.textContent = 'menu?';
  await microtasks();
  assert.ok(rig.sink.damage[0].rect, `local: ${JSON.stringify(rig.sink.damage[0].rect)}`);
  rig.sink.clear();
  nav.append(document.createElement('b'));
  await microtasks();
  assert.equal(rig.sink.damage[0].rect, null, 'an element was added: structural, whole drawable');
});

// Regression (ghost digits): a counter whose text carries a shadow beyond the ink margin left the old digits' shadow on the surface, because the damage rect was the
// span's box + inkMargin only. The rect must also cover the ink the element paints outside its box (text-shadow, box-shadow, outline: LiveLayer.paintInk).
const SHADOWED = '<div drawable id="d1" style="width:400px;height:160px;font:48px sans-serif;text-shadow:120px 30px 0 red"><span id="n">0</span></div>';

test('paintInkOf measures text-shadow, box-shadow and outline beyond the border box', () => {
  const root = fixture('<div id="a" style="text-shadow:120px -10px 4px red">x</div><div id="b" style="box-shadow:0 0 0 30px red;outline:2px solid;outline-offset:40px">y</div><div id="c">z</div>');
  const a = paintInkOf(root.querySelector('#a'));
  assert.ok(a.right >= 126 && a.left === 0 && a.top >= 16 && a.bottom === 0, JSON.stringify(a));
  const b = paintInkOf(root.querySelector('#b'));
  assert.ok(b.left >= 42 && b.right >= 42 && b.top >= 42 && b.bottom >= 42, JSON.stringify(b));
  assert.deepEqual(paintInkOf(root.querySelector('#c')), { left: 0, top: 0, right: 0, bottom: 0 });
});

test('text change under a text-shadow: the damage rect covers the shadow of the old and new text, not only box + ink margin', async t => {
  const rig = createRig({ html: SHADOWED });
  rig.layer.paintInk = paintInkOf;
  t.cleanup(observeMutations(rig.env, rig.record));
  const n = rig.layerEl.querySelector('#n');
  n.firstChild.data = '1';
  await microtasks();
  rig.sink.clear();
  n.firstChild.data = '2';
  await microtasks();
  const r = rig.sink.damage[0].rect;
  const box = rig.layer.frameRect(n);
  assert.ok(r, 'a same-size text change stays local');
  assert.ok(r.x + r.width >= box.x + box.width + 120 && r.y + r.height >= box.y + box.height + 30, `rect ${JSON.stringify(r)} must reach the shadow of box ${JSON.stringify(box)}`);
  assert.ok(r.x <= box.x - 24 && r.y <= box.y - 24, 'and still keeps the ink margin on the other sides');
});

test('own(): a box-shadow that a state change removes is still covered (the previous ink is part of the rect)', async () => {
  const rig = createRig({ html: '<div drawable id="d1" style="width:400px;height:200px"><button id="b" style="margin:60px;box-shadow:0 0 0 50px blue">ok</button></div>' });
  rig.layer.paintInk = paintInkOf;
  const { getRectMemory } = await import('/src/schedule/observers/damage-rect.js');
  const memory = getRectMemory(rig.env);
  const b = rig.layerEl.querySelector('#b');
  memory.own(rig.layer, b);
  b.style.boxShadow = 'none';
  const r = memory.own(rig.layer, b);
  const box = rig.layer.frameRect(b);
  assert.ok(r.x <= box.x - 50 && r.x + r.width >= box.x + box.width + 50, `rect ${JSON.stringify(r)} keeps the removed shadow of ${JSON.stringify(box)}`);
  const again = memory.own(rig.layer, b);
  assert.ok(again.x === box.x - 24 && again.width === box.width + 48, `without ink it is box + ink margin again: ${JSON.stringify(again)}`);
});

test('a same-origin frame inside a drawable: a change in its document and a (re)load damage the drawable that contains it (WPT onpaint-iframe); a cross-origin frame is not observed', async t => {
  const rig = createRig({ html: '<div drawable id="d1"><iframe id="f" srcdoc="<p id=x>a</p>"></iframe></div><div drawable id="d2"><span>x</span></div>' });
  const frame = /** @type {HTMLIFrameElement} */ (rig.layerEl.querySelector('#f'));
  for (let i = 0; i < 100 && frame.contentDocument?.getElementById('x') == null; i++) await frames(1);
  t.cleanup(observeMutations(rig.env, rig.record));
  /** @type {Document} */ (frame.contentDocument).getElementById('x').textContent = 'b';
  await microtasks();
  assert.deepEqual(rig.sink.damage.map((d) => [d.cause, d.drawable.id, d.rect]), [['mutation', 'd1', null]], 'a change inside the frame document');
  rig.sink.clear();
  const loaded = new Promise((ok) => frame.addEventListener('load', ok, { once: true }));
  frame.srcdoc = '<p id=y>c</p>';
  await loaded;
  await microtasks();
  assert.ok(rig.sink.damage.some((d) => d.drawable.id === 'd1'), 'the reload damages it');
  rig.sink.clear();
  /** @type {Document} */ (frame.contentDocument).getElementById('y').textContent = 'd';
  await microtasks();
  assert.deepEqual(rig.sink.damage.map((d) => d.drawable.id), ['d1'], 'the NEW document is observed');
});

test('an <img> that finishes loading damages its drawable (a <picture> source chosen after the snapshot, WPT privacy/picture-images-ignored); control: a load outside every drawable damages nothing', async t => {
  const rig = createRig({ html: '<div drawable id="d1"><picture><source srcset="/test/unit/snapshot-capture/assets/red.svg"><img id="p" width="40" height="20"></picture></div><img id="out" width="4" height="4">' });
  t.cleanup(observeMutations(rig.env, rig.record));
  const loaded = new Promise((ok) => rig.layerEl.querySelector('#p').addEventListener('load', ok, { once: true }));
  await loaded;
  await microtasks();
  assert.deepEqual(rig.sink.damage.map((d) => [d.cause, d.drawable.id]), [['mutation', 'd1']]);
  rig.sink.clear();
  const out = rig.layerEl.querySelector('#out');
  const outLoaded = new Promise((ok) => out.addEventListener('load', ok, { once: true }));
  out.src = '/test/unit/snapshot-capture/assets/red.svg';
  await outLoaded;
  await microtasks();
  assert.equal(rig.sink.damage.length, 0, 'not in a drawable');
});

test('a popover shown and hidden (no attribute changes) damages the drawable that contains it on each toggle (WPT privacy/popover-show-hide-background-image-ignored); control: a <details> toggle is announced by its open attribute alone, and a popover outside every drawable damages nothing', async t => {
  const rig = createRig({ html: '<div drawable id="d1" style="width:60px;height:40px"><div id="pop" popover="manual" style="display:block!important;position:static!important">x</div><details id="det"><summary>s</summary>t</details></div><div id="out" popover="manual">o</div>' });
  t.cleanup(observeMutations(rig.env, rig.record));
  const pop = rig.layerEl.querySelector('#pop');
  const toggled = (el) => new Promise((ok) => el.addEventListener('toggle', ok, { once: true }));
  let next = toggled(pop);
  pop.showPopover();
  await next;
  await microtasks();
  assert.deepEqual(rig.sink.damage.map((d) => [d.cause, d.drawable.id, d.rect]), [['mutation', 'd1', null]], 'shown: the whole drawable');
  rig.sink.clear();
  next = toggled(pop);
  pop.hidePopover();
  await next;
  await microtasks();
  assert.deepEqual(rig.sink.damage.map((d) => d.drawable.id), ['d1'], 'hidden: repainted again');
  rig.sink.clear();
  const det = rig.layerEl.querySelector('#det');
  next = toggled(det);
  det.open = true;
  await next;
  await microtasks();
  assert.equal(rig.sink.damage.length, 1, 'details: the attribute mutation only, not a second damage from its toggle event');
  rig.sink.clear();
  const out = rig.layerEl.querySelector('#out');
  next = toggled(out);
  out.showPopover();
  await next;
  await microtasks();
  out.hidePopover();
  assert.equal(rig.sink.damage.length, 0, 'not in a drawable');
});

test('a popover inside an open shadow root of a drawable damages that drawable when toggled, and stops doing so once unobserved (toggle is not composed: it never reaches the light tree); control: a light-tree listener does not see it', async t => {
  const rig = createRig({ html: '<div drawable id="d1" style="width:60px;height:40px"><span id="host"></span></div>' });
  const sr = rig.layerEl.querySelector('#host').attachShadow({ mode: 'open' });
  sr.innerHTML = '<div id="pop" popover="manual">x</div>';
  let lightSaw = 0;
  const light = () => { lightSaw++; };
  rig.layerEl.addEventListener('toggle', light, true);
  t.cleanup(() => rig.layerEl.removeEventListener('toggle', light, true));
  const stop = observeMutations(rig.env, rig.record);
  const pop = sr.querySelector('#pop');
  const toggled = () => new Promise((ok) => pop.addEventListener('toggle', ok, { once: true }));
  let next = toggled();
  pop.showPopover();
  await next;
  await microtasks();
  assert.equal(lightSaw, 0, 'control: the toggle event does not leave the shadow tree');
  assert.deepEqual(rig.sink.damage.map((d) => [d.drawable.id, d.rect]), [['d1', null]], 'shown: the drawable of the shadow host');
  rig.sink.clear();
  stop();
  next = toggled();
  pop.hidePopover();
  await next;
  await microtasks();
  assert.equal(rig.sink.damage.length, 0, 'unobserved: nothing');
});

test('an SVG resource outside every drawable that changes, or a subtree holding one that is added or removed, repaints every drawable of the canvas (a drawable draws the resources of its canvas by reference); control: other changes outside the drawables paint nothing', async t => {
  const defs = '<svg id="defs" width="0" height="0"><linearGradient id="g"><stop id="stop" stop-color="red"/></linearGradient><g id="plain"><rect/></g></svg>';
  const rig = createRig({ html: defs + PAGE });
  t.cleanup(observeMutations(rig.env, rig.record));
  const ids = () => rig.sink.damage.map((d) => d.drawable.id).sort().join();
  rig.layerEl.querySelector('#plain rect').setAttribute('width', '5');
  const extra = document.createElement('div');
  rig.layerEl.append(extra);
  await microtasks();
  assert.equal(ids(), '', 'control: an SVG element that is no resource, and a plain element, outside the drawables');
  rig.layerEl.querySelector('#stop').setAttribute('stop-color', 'green');
  await microtasks();
  assert.equal(ids(), 'd1,d2', 'a gradient stop changed');
  rig.sink.clear();
  rig.layerEl.querySelector('#defs').remove();
  await microtasks();
  assert.equal(ids(), 'd1,d2', 'the subtree holding the gradient left the canvas');
});
