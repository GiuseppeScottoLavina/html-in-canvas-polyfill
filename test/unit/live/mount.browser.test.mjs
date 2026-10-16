import { test, assert, frames, microtasks } from '/test/unit/lib/t.js';
import { setup, page, rect, contentRect, closeRect, scopeOf } from '/test/unit/live/lib.mjs';

const CHILDREN = '<div drawable id="a" tabindex="0">A</div>text<!--note--><p id="b">B <b>bold</b></p>';

test('mount relocates children in order and inserts the layer as next sibling', async (t) => {
  const { env, managed } = setup({ t });
  const { root, canvas } = page(CHILDREN);
  const before = canvas.innerHTML;
  const r = managed(canvas);
  const layer = r.layer.element;
  assert.equal(layer.localName, 'hic-layer');
  assert.equal(Object.getOwnPropertyDescriptor(Node.prototype, 'nextSibling').get.call(canvas), layer);
  assert.equal(layer.getAttribute('data-hic-layer'), String(r.id));
  assert.equal(canvas.getAttribute('data-hic-canvas'), String(r.id));
  assert.equal(layer.getAttribute('role'), 'presentation');
  assert.equal(Object.getOwnPropertyDescriptor(Node.prototype, 'childNodes').get.call(canvas).length, 0, 'canvas has no real children');
  assert.equal(layer.innerHTML, before);
  assert.equal(r.layer.isMounted(), true);
  assert.equal(root.querySelector('#a').offsetWidth > 0, true, 'children are laid out');
  assert.ok(env);
});

test('mount and unmount are idempotent exact inverses', async (t) => {
  const { managed } = setup({ t });
  const { root, canvas } = page(CHILDREN);
  canvas.setAttribute('aria-owns', 'x y');
  const html = root.innerHTML;
  const r = managed(canvas);
  r.layer.mount();
  assert.notEqual(root.innerHTML, html);
  r.layer.unmount();
  r.layer.unmount();
  assert.equal(root.innerHTML, html, 'serialised DOM is identical after unmount');
  assert.equal(canvas.getAttribute('aria-owns'), 'x y');
  assert.equal(r.layer.isMounted(), false);
  r.layer.mount();
  assert.equal(r.layer.element.innerHTML, canvas.innerHTML);
  r.layer.unmount();
  assert.equal(root.innerHTML, html, 'second cycle is exact too');
});

test('unmount removes own properties of the facade', async (t) => {
  const { managed } = setup({ t });
  const { canvas } = page(CHILDREN);
  const r = managed(canvas);
  const child = canvas.firstChild;
  assert.ok(Object.hasOwn(canvas, 'children'));
  assert.ok(Object.hasOwn(child, 'parentNode'));
  r.layer.unmount();
  assert.equal(Object.getOwnPropertyNames(canvas).includes('children'), false);
  assert.equal(Object.hasOwn(child, 'parentNode'), false);
  assert.equal(child.parentNode, canvas);
});

test('layer content box equals the canvas content box (border, padding, block and inline)', async (t) => {
  const { managed } = setup({ t });
  for (const style of ['display:block;border:3px solid red;padding:7px 5px 2px 9px;width:200px;height:100px', 'border:2px solid;padding:4px', 'display:block;width:33.3%;border-width:1.5px 0 2.5px 0;border-style:solid;padding:0.3px;box-sizing:border-box']) {
    const { canvas } = page('<div>x</div>', style, '', '', { width: '600px' });
    const r = managed(canvas);
    await frames(1);
    const a = contentRect(r.layer.element);
    const b = contentRect(canvas);
    assert.ok(closeRect(a, b), `${style}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    assert.ok(closeRect(rect(r.layer.element), rect(canvas)), `${style}: border boxes`);
  }
});

test('layer follows the canvas under an ancestor scale and its own transform', async (t) => {
  const { managed } = setup({ t });
  const { canvas, root } = page('<div>x</div>', 'display:block;width:200px;height:100px;border:2px solid;padding:3px', '<div style="height:20px"></div>', '', { transform: 'scale(1.5)', transformOrigin: '0 0', width: '400px' });
  const r = managed(canvas);
  await frames(1);
  assert.ok(closeRect(contentRect(r.layer.element), contentRect(canvas)), 'ancestor scale');
  canvas.style.transform = 'rotate(10deg) translate(5px, 6px)';
  r.layer.syncPresentation();
  await frames(1);
  assert.ok(closeRect(rect(r.layer.element), rect(canvas), 0.05), `own transform ${JSON.stringify(rect(r.layer.element))} vs ${JSON.stringify(rect(canvas))}`);
  assert.ok(root);
});

test('layer is not displaced by hostile author CSS and hidden in print', async (t) => {
  const { managed } = setup({ t });
  const { canvas, root } = page('<div>x</div>', 'display:block;width:200px;height:100px', '', '', {});
  root.id = 'stack';
  root.className = 'stack';
  const style = document.createElement('style');
  style.textContent = '#stack > * { margin: 25px !important; position: relative !important; opacity: 1 !important; } .stack > *, .stack * + * { margin-top: 40px !important } .stack :last-child { margin: 9px !important }';
  document.head.append(style);
  t.cleanup(() => style.remove());
  const r = managed(canvas);
  await frames(1);
  assert.ok(closeRect(rect(r.layer.element), rect(canvas), 0.01), 'layer rect equals canvas rect');
  assert.equal(getComputedStyle(r.layer.element).opacity, '0');
  const sheet = [...document.adoptedStyleSheets].find((s) => [...s.cssRules].some((x) => x.cssText.includes('hic-layer')));
  const print = [...sheet.cssRules].find((x) => x.cssText.startsWith('@media print'));
  assert.ok(print && /display: none/.test(print.cssText), 'print rule hides the layer');
});

test('parser-style insertion into the canvas is relocated and reaches onChildrenChanged', async (t) => {
  const { managed } = setup({ t });
  const { canvas } = page();
  const r = managed(canvas);
  const seen = [];
  r.layer.onChildrenChanged((c) => seen.push(c));
  const late = document.createElement('div');
  late.id = 'late';
  Node.prototype.appendChild.call(canvas, late);
  await microtasks();
  assert.equal(Object.getOwnPropertyDescriptor(Node.prototype, 'parentNode').get.call(late), r.layer.element);
  assert.equal(late.parentNode, canvas, 'facade reports the canvas');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].added[0], late);
  assert.equal(r.layer.logicalChildNodes()[0], late);
});

test('presentation: inherited properties, custom properties, z-index and display none', async (t) => {
  const { managed, bus } = setup({ t });
  const { canvas, root } = page('<span id="s">t</span>', 'display:block;width:100px;height:50px;font:italic 700 17px/1.5 monospace;color:rgb(1, 2, 3);--mine:7;letter-spacing:2px;position:relative;z-index:4', '', '', {});
  root.style.fontSize = '30px';
  root.style.setProperty('--shared', 'same');
  const r = managed(canvas);
  const cs = getComputedStyle(r.layer.element);
  assert.equal(cs.fontSize, '17px');
  assert.equal(cs.fontStyle, 'italic');
  assert.equal(cs.fontWeight, '700');
  assert.equal(cs.color, 'rgb(1, 2, 3)');
  assert.equal(cs.letterSpacing, '2px');
  assert.equal(cs.zIndex, '4');
  assert.equal(cs.getPropertyValue('--mine'), '7');
  assert.equal(r.layer.element.style.getPropertyValue('--shared'), '', 'a value the layer inherits anyway is not copied');
  assert.equal(r.layer.element.style.getPropertyValue('--mine'), '7');
  const span = root.querySelector('#s');
  assert.equal(getComputedStyle(span).lineHeight, '25.5px', 'unitless line-height keeps inheriting as a factor');
  span.style.fontSize = '10px';
  assert.equal(getComputedStyle(span).lineHeight, '15px');
  canvas.style.removeProperty('--mine');
  canvas.style.color = 'rgb(9, 9, 9)';
  r.layer.syncPresentation();
  assert.equal(getComputedStyle(r.layer.element).color, 'rgb(9, 9, 9)');
  assert.equal(r.layer.element.style.getPropertyValue('--mine'), '', 'stale custom property removed');
  const events = [];
  bus.on('canvas:resize', (e) => events.push(e));
  canvas.style.width = '120px';
  const box = r.layer.syncPresentation();
  assert.equal(box.width, 120);
  assert.equal(events.length, 1, 'RESIZE emitted for a measured box that changed');
  canvas.style.display = 'none';
  r.layer.syncPresentation();
  assert.equal(getComputedStyle(r.layer.element).display, 'none');
  assert.equal(r.layer.syncPresentation().width, 120, 'a display:none canvas keeps the last box');
});

test('a canvas attribute change resyncs the layer', async (t) => {
  const { managed } = setup({ t });
  const { canvas } = page('<i>x</i>', 'display:block;width:100px;height:50px');
  const r = managed(canvas);
  canvas.style.color = 'rgb(5, 6, 7)';
  await microtasks();
  assert.equal(getComputedStyle(r.layer.element).color, 'rgb(5, 6, 7)');
});

test('inherited anyway: properties the layer inherits are not written inline', async (t) => {
  const { managed } = setup({ t });
  const { canvas, root } = page('<span>t</span>', 'display:block;width:100px;height:50px;letter-spacing:3px');
  root.style.fontFamily = 'serif';
  root.style.color = 'rgb(4, 4, 4)';
  const r = managed(canvas);
  const inline = r.layer.element.style;
  assert.equal(inline.getPropertyValue('letter-spacing'), '3px', 'the canvas own value is copied');
  assert.equal(inline.getPropertyValue('font-family'), '', 'equal to the parent: inherited, not copied');
  assert.equal(inline.getPropertyValue('color'), '');
  assert.equal(getComputedStyle(r.layer.element).color, 'rgb(4, 4, 4)');
});

test('mount() on a mounted layer re-homes it: moved canvas, disconnected canvas, other tree scope', async (t) => {
  const { managed, env } = setup({ t });
  const { canvas, root } = page('<div id="a">a</div>', 'display:block;width:120px;height:60px');
  const other = document.createElement('section');
  root.append(other);
  const r = managed(canvas);
  const layer = r.layer.element;
  const nextOf = (n) => Object.getOwnPropertyDescriptor(Node.prototype, 'nextSibling').get.call(n);
  other.append(canvas);
  r.layer.mount();
  assert.equal(nextOf(canvas), layer, 'layer follows the canvas to its new parent');
  assert.equal(other.childElementCount, 1, 'parent facade moved too');
  assert.equal(root.childElementCount, 1);
  canvas.remove();
  r.layer.mount();
  assert.equal(layer.isConnected, false, 'a disconnected canvas takes its layer out of the document');
  assert.equal(canvas.querySelector('#a').parentNode, canvas, 'children stay logically in the canvas');
  const host = document.createElement('div');
  root.append(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.append(canvas);
  r.root = scopeOf(canvas);
  r.layer.mount();
  assert.equal(layer.getRootNode(), shadow);
  assert.equal(getComputedStyle(layer).position, 'absolute');
  const a = canvas.querySelector('#a');
  const box = canvas.getBoundingClientRect();
  assert.ok(Math.abs(layer.getBoundingClientRect().x - box.x) < 0.01 && Math.abs(layer.getBoundingClientRect().width - box.width) < 0.01);
  assert.ok(a.getBoundingClientRect().width > 0);
  r.layer.unmount();
  assert.equal(shadow.adoptedStyleSheets.length, 0, 'style handle of the new scope released');
});

test('direct children of a managed canvas are position:static against the author inline style and `* { position: ... !important }` (WPT containment), descendants keep theirs', async (t) => {
  const { managed } = setup({ t });
  const { root, canvas } = page('<div drawable id="a" style="position:absolute;left:30px;top:40px"><i id="g" style="position:absolute">g</i></div><div id="b">b</div>');
  const sheet = document.createElement('style');
  sheet.textContent = '* { position: fixed !important }';
  root.append(sheet);
  const r = managed(canvas);
  const a = root.querySelector('#a');
  assert.equal(getComputedStyle(a).position, 'static', 'inline style and !important author rules lose against the canvas children rule');
  assert.equal(getComputedStyle(root.querySelector('#b')).position, 'static');
  assert.equal(getComputedStyle(root.querySelector('#g')).position, 'fixed', 'only the direct children are forced');
  assert.equal(r.layer.element.localName, 'hic-layer');
});

test('children-layout: direct children are blockified and shrink-to-fit like native (auto width, block and inline, horizontal and vertical writing mode); percentages resolve against the canvas', async (t) => {
  const { managed } = setup({ t });
  const { root, canvas } = page('<div drawable id="a" style="margin:5px">wide?</div><span id="b">inline</span><div id="d" style="display:flex">f</div><div id="e" style="width:50%">p</div><div id="h" style="justify-self:stretch;align-self:stretch">s</div>', 'width:300px;height:150px');
  managed(canvas);
  await frames(1);
  const w = (/** @type {string} */ id) => root.querySelector('#' + id).getBoundingClientRect();
  for (const id of ['a', 'b', 'd', 'h']) assert.ok(w(id).width < 100, `#${id} shrinks to fit (got ${w(id).width}px; filling would be 300px)`);
  assert.equal(getComputedStyle(root.querySelector('#b')).display, 'block', 'inline child is blockified');
  assert.equal(w('e').width, 150);
  assert.ok(w('h').height < 50, 'height is the content height, not stretched');
  const { root: vroot, canvas: vcanvas } = page('<div id="v">vertical</div>', 'width:300px;height:150px;writing-mode:vertical-rl');
  managed(vcanvas);
  await frames(1);
  assert.ok(vroot.querySelector('#v').getBoundingClientRect().height < 120, 'vertical: the inline size (height) shrinks to fit too');
});

test('a listbox select moved from the canvas (fallback, no box while parsing) shows its selected option, as the engine does at load; one already in view stays at 0', async (t) => {
  const { managed } = setup({ t });
  const opts = (sel) => [1, 2, 3, 4, 5, 6].map((i) => `<option${i === sel ? ' selected' : ''}>Option ${i}</option>`).join('');
  const { root, canvas } = page(`<div drawable><select size="3" id="far">${opts(5)}</select><select size="3" id="near">${opts(1)}</select><select multiple size="2" id="multi">${opts(4)}</select></div>`);
  const far = root.querySelector('#far');
  assert.equal(far.scrollTop, 0, 'precondition: fallback content has no box');
  managed(canvas);
  const box = far.getBoundingClientRect(), opt = far.options[4].getBoundingClientRect();
  assert.ok(far.scrollTop > 0, `scrolled: ${far.scrollTop}`);
  assert.ok(Math.abs(opt.bottom - (box.top + far.clientTop + far.clientHeight)) < 1, 'the selected option ends at the scrollport bottom (nearest)');
  assert.equal(root.querySelector('#near').scrollTop, 0);
  assert.ok(root.querySelector('#multi').scrollTop > 0, 'multiple: the first selected option');
});
