import { test, assert, frames, microtasks } from '/test/unit/lib/t.js';
import { setup, page } from '/test/unit/live/lib.mjs';
import { installSelectorBridge, buildMirroredCss } from '/src/live/selector-bridge.js';

const KIDS = '<p class="x" id="p">hello</p><p class="y" id="q">there</p>';

function scene() {
  return page(KIDS, 'display:block;width:100px;height:50px', '<div class="stack" id="stack">', '</div>');
}

test('before install nothing is found; after install canvas-ancestor selectors reach relocated children', async (t) => {
  const s = setup({ t });
  const { canvas, root } = scene();
  s.managed(canvas);
  assert.equal(document.querySelector('canvas .x'), null, 'baseline: the browser cannot see through the layer');
  const off = installSelectorBridge(s.env, s.ledger);
  t.cleanup(off);
  const p = canvas.querySelector('#p');
  assert.equal(document.querySelector('canvas .x'), p);
  assert.equal(document.querySelector('.stack canvas > .x'), p);
  assert.equal(root.querySelector('canvas.c-none .x'), null);
  assert.equal(document.querySelectorAll('canvas p').length, 2);
  assert.equal(root.querySelectorAll('canvas p').item(1).id, 'q');
  assert.equal(document.querySelectorAll('.x').length, 1, 'selectors without a canvas ancestor are untouched');
  assert.ok(document.querySelectorAll('.x') instanceof NodeList, 'native NodeList when nothing was added');
  assert.equal(document.querySelector('.stack').querySelector('canvas .x'), p, 'element scoped query');
  assert.equal(p.matches('canvas .x'), true);
  assert.equal(p.matches('canvas .y'), false);
  assert.equal(p.matches('.x'), true);
  assert.equal(p.closest('canvas'), canvas);
  assert.equal(p.closest('.stack'), document.getElementById('stack'));
  assert.equal(p.closest('canvas.chart'), null, 'canvas without that class does not match');
  assert.equal(p.closest('.stack canvas'), canvas, 'compound selector whose subject is the canvas');
  assert.equal(document.querySelector('canvas'), canvas, 'queries for the canvas itself never return the layer');
  assert.equal(document.querySelectorAll('canvas').length, 1);
});

test('results are deduplicated and in document order when native and rewritten matches mix', async (t) => {
  const s = setup({ t });
  const { canvas, root } = scene();
  s.managed(canvas);
  root.insertAdjacentHTML('afterbegin', '<section><p class="x" id="first"></p></section>');
  root.insertAdjacentHTML('beforeend', '<section><p class="x" id="last"></p></section>');
  const off = installSelectorBridge(s.env, s.ledger);
  t.cleanup(off);
  const ids = [...document.querySelectorAll('.x, canvas p')].map((e) => e.id);
  assert.deepEqual(ids, ['first', 'p', 'q', 'last']);
  assert.equal(new Set(ids).size, ids.length, 'no duplicates');
  assert.equal(document.querySelector('canvas p, #last')?.id, 'p', 'first in document order wins');
});

test('the css mirror styles relocated children like the canvas ancestors would, with the original specificity', async (t) => {
  const s = setup({ t });
  const { canvas } = scene();
  canvas.className = 'chart';
  const style = document.createElement('style');
  style.textContent = `
    .x { color: rgb(9, 9, 9); }
    canvas.chart .x { color: rgb(1, 2, 3); }
    canvas.chart .y { color: rgb(4, 5, 6); }
    .chart.b .y { color: rgb(7, 7, 7); }
    @media (min-width: 1px) { canvas .y { background-color: rgb(10, 20, 30); } }
    @media print { canvas .y { background-color: rgb(1, 1, 1); } }
    canvas.other .x { color: rgb(200, 0, 0); }`;
  document.head.append(style);
  t.cleanup(() => style.remove());
  const r = s.managed(canvas);
  const off = installSelectorBridge(s.env, s.ledger);
  t.cleanup(off);
  s.bus.emit('canvas:mounted', { record: r });
  await microtasks();
  const p = canvas.querySelector('#p');
  const q = canvas.querySelector('#q');
  assert.equal(getComputedStyle(p).color, 'rgb(1, 2, 3)', 'mirrored rule beats the plain .x rule by specificity');
  assert.equal(getComputedStyle(q).color, 'rgb(4, 5, 6)');
  assert.equal(getComputedStyle(q).backgroundColor, 'rgb(10, 20, 30)', 'media wrapper kept');
  const css = buildMirroredCss([style.sheet], canvas, 'hic-layer[data-hic-layer="9"]');
  assert.ok(/@media print\s*\{hic-layer\[data-hic-layer="9"\] \.y/.test(css), `media rules keep their wrapper: ${css}`);
});

test('mirrored rules follow canvas attribute changes and stylesheet damage', async (t) => {
  const s = setup({ t });
  const { canvas } = scene();
  canvas.className = 'chart';
  const style = document.createElement('style');
  style.textContent = 'canvas.chart .x { color: rgb(1, 2, 3); } canvas.other .x { color: rgb(200, 0, 0); }';
  document.head.append(style);
  t.cleanup(() => style.remove());
  const r = s.managed(canvas);
  const off = installSelectorBridge(s.env, s.ledger);
  t.cleanup(off);
  s.bus.emit('canvas:mounted', { record: r });
  await microtasks();
  const p = canvas.querySelector('#p');
  assert.equal(getComputedStyle(p).color, 'rgb(1, 2, 3)');
  canvas.className = 'other';
  await microtasks();
  await microtasks();
  assert.equal(getComputedStyle(p).color, 'rgb(200, 0, 0)');
  style.textContent += ' canvas.other .x { color: rgb(0, 100, 0); }';
  s.bus.emit('damage', { cause: 'stylesheet' });
  await microtasks();
  assert.equal(getComputedStyle(p).color, 'rgb(0, 100, 0)');
  r.layer.unmount();
  s.bus.emit('canvas:unmounting', { record: r });
  await microtasks();
  await microtasks();
  assert.equal(document.adoptedStyleSheets.length, 0, 'mirror sheet removed with the last canvas');
});

test('remover stops the wrappers; modes queries, css and off', async (t) => {
  for (const mode of ['off', 'queries', 'css']) {
    const s = setup({ t, options: { selectorBridge: mode } });
    const { canvas, root } = scene();
    const style = document.createElement('style');
    style.textContent = 'canvas .x { color: rgb(3, 3, 3); }';
    document.head.append(style);
    const r = s.managed(canvas);
    const off = installSelectorBridge(s.env, s.ledger);
    s.bus.emit('canvas:mounted', { record: r });
    await microtasks();
    const found = document.querySelector('canvas .x') !== null;
    const styled = getComputedStyle(canvas.querySelector('#p')).color === 'rgb(3, 3, 3)';
    assert.equal(found, mode === 'queries', `${mode}: queries`);
    assert.equal(styled, mode === 'css', `${mode}: css`);
    off();
    await microtasks();
    assert.equal(document.querySelector('canvas .x'), null, `${mode}: after the remover`);
    assert.equal(getComputedStyle(canvas.querySelector('#p')).color === 'rgb(3, 3, 3)', false);
    style.remove();
    root.remove();
    r.layer.dispose();
  }
  assert.ok(frames);
});
