import { test, assert, microtasks } from '/test/unit/lib/t.js';
import { setup, page } from '/test/unit/live/lib.mjs';

const KIDS = '<div id="a" class="k">A</div><span id="b">B</span>tail';

/** Same tree without the polyfill: the canvas keeps its children. */
function twin() {
  const { canvas, root } = page(KIDS, '', '<p id="before"></p>', '<p id="after"></p>');
  return { canvas, root };
}

test('child list queries equal a plain-DOM twin', async (t) => {
  const { managed } = setup({ t });
  const plain = twin();
  const { canvas, root } = page(KIDS, '', '<p id="before"></p>', '<p id="after"></p>');
  managed(canvas);
  const same = (key, map = (x) => x) => assert.deepEqual(map(canvas[key]), map(plain.canvas[key]), key);
  same('childElementCount');
  same('children', (c) => [...c].map((e) => e.id));
  same('childNodes', (c) => [...c].map((n) => n.nodeName));
  same('firstChild', (n) => n.nodeName);
  same('lastChild', (n) => n.nodeValue);
  same('firstElementChild', (e) => e.id);
  same('lastElementChild', (e) => e.id);
  same('textContent');
  same('innerHTML');
  assert.equal(canvas.hasChildNodes(), true);
  assert.equal(canvas.querySelector('#b').id, 'b');
  assert.equal(canvas.querySelectorAll('div, span').length, 2);
  assert.equal(canvas.getElementsByClassName('k').length, 1);
  assert.equal(canvas.getElementsByTagName('span')[0].id, 'b');
  assert.equal(canvas.contains(canvas.querySelector('#a')), true);
  assert.equal(canvas.contains(canvas), true);
  assert.equal(canvas.contains(root.querySelector('#before')), false);
  assert.equal(canvas.nextElementSibling.id, 'after', 'the layer is skipped');
  assert.equal(canvas.nextSibling.id, 'after');
  assert.equal(canvas.previousElementSibling.id, 'before');
  const a = canvas.querySelector('#a');
  assert.equal(a.parentNode, canvas);
  assert.equal(a.parentElement, canvas);
  assert.equal(a.nextSibling.id, 'b');
});

test('writes through the canvas land in the layer and are visible at once', async (t) => {
  const { managed } = setup({ t });
  const { canvas } = page(KIDS);
  const r = managed(canvas);
  const seen = [];
  r.layer.onChildrenChanged((c) => seen.push(c));
  const x = document.createElement('i');
  x.id = 'x';
  canvas.appendChild(x);
  assert.equal(canvas.lastElementChild, x);
  assert.equal(x.parentNode, canvas);
  assert.equal(r.layer.element.lastElementChild, x);
  const y = document.createElement('u');
  canvas.insertBefore(y, canvas.querySelector('#b'));
  assert.equal(canvas.children[1], y);
  canvas.prepend('lead');
  assert.equal(canvas.firstChild.nodeValue, 'lead');
  canvas.removeChild(y);
  assert.equal(y.parentNode, null, 'a removed child reports no parent');
  canvas.replaceChild(document.createElement('s'), x);
  assert.equal(canvas.querySelector('#x'), null);
  assert.ok(seen.length >= 4, `onChildrenChanged fired synchronously per write (${seen.length})`);
  canvas.innerHTML = '<em id="e">E</em>';
  assert.equal(canvas.children.length, 1);
  canvas.append('z');
  canvas.insertAdjacentHTML('beforeend', '<b id="bb"></b>');
  assert.equal(canvas.lastElementChild.id, 'bb');
  canvas.insertAdjacentHTML('afterend', '<hr id="out">');
  assert.equal(canvas.nextElementSibling.id, 'out');
  canvas.replaceChildren();
  assert.equal(canvas.childNodes.length, 0);
  canvas.textContent = 'plain';
  assert.equal(canvas.textContent, 'plain');
  assert.equal(Object.getOwnPropertyDescriptor(Node.prototype, 'childNodes').get.call(canvas).length, 0, 'the canvas itself never holds children');
});

test('cloneNode(true) and outerHTML carry the logical children but no polyfill state', async (t) => {
  const { managed } = setup({ t });
  const { canvas } = page(KIDS);
  canvas.setAttribute('aria-owns', 'mine');
  const r = managed(canvas);
  const clone = canvas.cloneNode(true);
  assert.equal(clone.children.length, 2);
  assert.equal(clone.hasAttribute('data-hic-canvas'), false);
  assert.equal(clone.getAttribute('aria-owns'), 'mine');
  assert.equal(canvas.outerHTML.includes('id="b"'), true);
  assert.equal(canvas.outerHTML.includes('hic-layer'), false);
  assert.equal(r.layer.isMounted(), true);
});

test('parent facade hides the layer from the parent child lists (and can be turned off)', async (t) => {
  const { managed } = setup({ t });
  const { canvas, root } = page(KIDS, '', '<p id="before"></p>', '');
  managed(canvas);
  assert.equal(root.children.length, 2);
  assert.equal(root.childElementCount, 2);
  assert.equal(root.lastElementChild, canvas);
  assert.equal(root.lastChild, canvas);
  assert.deepEqual([...root.childNodes].map((n) => n.nodeName), ['P', 'CANVAS']);
  assert.equal(root.children.item(1), canvas);
  assert.equal(Object.getOwnPropertyDescriptor(Element.prototype, 'childElementCount').get.call(root), 3, 'native collections still see the layer (documented limit)');
  assert.equal(root.querySelector(':scope > :last-child').localName, 'hic-layer', 'CSS sees it too');
});

test('parentFacade:false leaves the parent alone', async (t) => {
  const { managed } = setup({ t, options: { parentFacade: false } });
  const { canvas, root } = page(KIDS);
  managed(canvas);
  assert.equal(root.childElementCount, 2);
  assert.equal(Object.hasOwn(root, 'children'), false);
});

test('parent facade is reference counted across canvases and removed with the last one', async (t) => {
  const { managed } = setup({ t });
  const { canvas, root } = page(KIDS);
  const second = document.createElement('canvas');
  root.append(second);
  const a = managed(canvas);
  const b = managed(second);
  assert.equal(root.childElementCount, 2);
  a.layer.unmount();
  assert.equal(root.lastElementChild, second);
  assert.ok(Object.hasOwn(root, 'children'));
  b.layer.unmount();
  assert.equal(Object.hasOwn(root, 'children'), false);
});

test('nested managed canvas: the inner layer stays out of the outer logical list', async (t) => {
  const { managed } = setup({ t });
  const { canvas } = page('<div id="a">A</div><canvas id="inner"><b id="deep" drawable></b></canvas>');
  const outer = managed(canvas);
  const inner = managed(canvas.querySelector('#inner'));
  assert.equal(outer.layer.logicalChildNodes().length, 2);
  assert.equal(canvas.children.length, 2);
  assert.equal(canvas.querySelector('#deep').parentNode.id, 'inner');
  assert.equal(outer.layer.drawableElements().length, 0, 'drawables of the inner canvas are not the outer canvas drawables');
  assert.equal(inner.layer.drawableElements().length, 1);
  inner.layer.unmount();
  outer.layer.unmount();
  assert.equal(canvas.querySelector('#deep').parentNode.id, 'inner');
});

test('frameworks style reconcile: node moves, keyed reorder and replaceWith keep the logical list consistent', async (t) => {
  const { managed } = setup({ t });
  const { canvas } = page('<i id="i1"></i><i id="i2"></i><i id="i3"></i>');
  managed(canvas);
  const [a, b, c] = canvas.children;
  canvas.insertBefore(c, a);
  canvas.appendChild(a);
  assert.deepEqual([...canvas.children].map((e) => e.id), ['i3', 'i2', 'i1']);
  b.replaceWith(document.createElement('u'));
  assert.equal(canvas.children[1].localName, 'u');
  b.remove();
  assert.equal(b.parentNode, null);
  await microtasks();
  assert.equal(canvas.childElementCount, 3);
});
