import { test, assert, fixture } from '/test/unit/lib/t.js';
import { setup, rect, closeRect } from '/test/unit/live/lib.mjs';
import { installLayerStyle, anchorRule, LAYER_CSS } from '/src/live/layer-style.js';
import { createGeometryRules, isOwnedSheet } from '/src/live/geometry-sheet.js';

function shadowHost(mode = 'open') {
  const host = fixture('').appendChild(document.createElement('div'));
  const root = host.attachShadow({ mode });
  root.innerHTML = '<canvas id="c" width="200" height="100" style="display:block;width:200px;height:100px;margin:15px"><div drawable id="d">x</div></canvas>';
  return { host, root, canvas: root.querySelector('#c') };
}

test('a canvas in an open and in a closed shadow root: layer positioned by the root-local sheet', async (t) => {
  const { managed, env } = setup({ t });
  for (const mode of ['open', 'closed']) {
    const { root, canvas } = shadowHost(mode);
    assert.equal(env.roots.rootOf(canvas), root);
    const r = managed(canvas);
    assert.equal(r.root, root);
    assert.equal(getComputedStyle(r.layer.element).position, 'absolute');
    assert.ok(closeRect(rect(r.layer.element), rect(canvas), 0.01), `${mode}`);
    assert.ok(root.adoptedStyleSheets.length >= 2, 'layer and geometry sheet live in the root');
    assert.equal(document.adoptedStyleSheets.length, 0, 'the document got nothing');
    // positive control: without the root sheet the layer is an unstyled in-flow box
    const sheets = root.adoptedStyleSheets;
    root.adoptedStyleSheets = [];
    r.layer.element.removeAttribute('style');
    assert.equal(getComputedStyle(r.layer.element).position === 'absolute', false, 'control: no root sheet, no positioning');
    root.adoptedStyleSheets = sheets;
  }
});

test('RootScope: roots, onRoot, ROOT_ADDED for roots created after and before the install', async (t) => {
  const early = fixture('').appendChild(document.createElement('div'));
  const earlyRoot = early.attachShadow({ mode: 'open' });
  const { env, bus } = setup({ t });
  const added = [];
  bus.on('root:added', (e) => added.push(e.root));
  const seen = [];
  env.roots.onRoot((r) => seen.push(r));
  assert.ok(env.roots.roots().includes(earlyRoot), 'initial walk found the existing open root');
  assert.equal(env.roots.roots()[0], document);
  const lateHost = fixture('').appendChild(document.createElement('div'));
  const lateRoot = lateHost.attachShadow({ mode: 'closed' });
  assert.deepEqual(added, [lateRoot]);
  assert.deepEqual(seen, [lateRoot]);
  assert.ok(env.roots.roots().includes(lateRoot), 'a closed root created after install is known');
  env.roots.adopt(lateRoot);
  assert.equal(added.length, 1, 'adopt is idempotent');
  const detached = document.createElement('div');
  detached.attachShadow({ mode: 'open' });
  assert.equal(env.roots.rootOf(detached.shadowRoot.host), document, 'a detached tree resolves to the document');
  const free = document.createElement('p');
  assert.equal(env.roots.rootOf(free), document);
  assert.equal(env.roots.roots().includes(detached.shadowRoot), false, 'disconnected roots are not listed');
});

test('attachShadow patch is restored with the ledger', async (t) => {
  const original = Element.prototype.attachShadow;
  const { ledger } = setup({ t });
  assert.notEqual(Element.prototype.attachShadow, original);
  assert.equal(ledger.restoreAll().length, 0);
  assert.equal(Element.prototype.attachShadow, original);
});

test('layer style is reference counted per root and removes only its own sheets', async (t) => {
  const author = new CSSStyleSheet();
  document.adoptedStyleSheets = [author];
  t.cleanup(() => { document.adoptedStyleSheets = []; });
  const a = installLayerStyle(document);
  const b = installLayerStyle(document);
  assert.equal(document.adoptedStyleSheets.length, 3);
  a.add(7);
  assert.ok([...document.adoptedStyleSheets[1].cssRules].some((r) => r.cssText.includes('anchor-name: --hic-7')));
  assert.equal(anchorRule(7), 'canvas[data-hic-canvas="7"]{anchor-name:--hic-7 !important}');
  a.dispose();
  assert.equal(document.adoptedStyleSheets.length, 3, 'still referenced');
  assert.equal([...document.adoptedStyleSheets[1].cssRules].some((r) => r.cssText.includes('--hic-7')), false, 'rules of the disposed handle are gone');
  b.dispose();
  b.dispose();
  assert.deepEqual(document.adoptedStyleSheets, [author]);
  assert.ok(LAYER_CSS.includes('@media print'));
});

test('geometry rules: one rule per key, in-place updates, removal, ownership', async (t) => {
  const sheet = new CSSStyleSheet();
  const rules = createGeometryRules(sheet);
  rules.set('k1', { transform: 'translate(1px, 2px)', 'z-index': '3' });
  assert.equal(sheet.cssRules.length, 1);
  const rule = sheet.cssRules[0];
  assert.equal(rule.selectorText, '[data-hic-hit="k1"]');
  assert.equal(rule.style.getPropertyPriority('transform'), 'important');
  rules.set('k1', { transform: 'translate(5px, 2px)' });
  assert.equal(sheet.cssRules.length, 1);
  assert.equal(sheet.cssRules[0], rule, 'the same rule object is updated, not re-created');
  assert.equal(rule.style.getPropertyValue('transform'), 'translate(5px, 2px)');
  assert.equal(rule.style.getPropertyValue('z-index'), '', 'a declaration that disappeared is removed');
  assert.throws(() => rules.set('bad key', {}), /invalid geometry key/);
  rules.remove('k1');
  rules.remove('k1');
  assert.equal(sheet.cssRules.length, 0);
  assert.equal(rules.owns(sheet), true);
  assert.equal(rules.owns(new CSSStyleSheet()), false);
  assert.equal(isOwnedSheet(sheet), true);
});
