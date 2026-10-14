import { test, assert, microtasks } from '/test/unit/lib/t.js';
import { createRig } from './_dom.js';
import { observeStylesheets } from '/src/schedule/observers/stylesheet-observer.js';
import { createPatchLedger } from '/src/api/patch.js';

/** rig + stylesheet observer on a real ledger; `owned` is the polyfill's own constructable sheet */
function setup(t) {
  const rig = createRig({ html: '<div drawable id="d">x</div>' });
  const owned = new CSSStyleSheet();
  owned.replaceSync('[data-hic-hit]{pointer-events:auto}');
  document.adoptedStyleSheets = [owned];
  rig.env.roots.style = () => ({ geometry: { owns: (sheet) => sheet === owned }, dispose() {} });
  const ledger = createPatchLedger(window);
  const author = document.createElement('style');
  author.textContent = '.a{color:red}';
  document.head.append(author);
  const stop = observeStylesheets(rig.env, ledger);
  t.cleanup(() => { stop(); ledger.restoreAll(); author.remove(); document.adoptedStyleSheets = []; });
  const count = () => rig.store.invalidated.length;
  return { ...rig, owned, ledger, author, count, sheet: author.sheet };
}

test('insertRule, deleteRule and rule.style.setProperty on an author sheet invalidate the CSS bundle and damage every canvas', async t => {
  const s = setup(t);
  s.sheet.insertRule('.b{color:blue}', 0);
  await microtasks();
  assert.equal(s.count(), 1);
  assert.deepEqual(s.sink.causes(), ['stylesheet']);
  assert.equal(s.sink.damage[0].drawable, null);
  s.sheet.cssRules[0].style.setProperty('color', 'green');
  await microtasks();
  assert.equal(s.count(), 2);
  s.sheet.deleteRule(0);
  await microtasks();
  assert.equal(s.count(), 3);
  s.sheet.cssRules[0].style.cssText = 'color:pink';
  await microtasks();
  assert.equal(s.count(), 4);
  s.sheet.cssRules[0].style.removeProperty('color');
  await microtasks();
  assert.equal(s.count(), 5);
});

test('a burst of 500 insertRule calls invalidates once', async t => {
  const s = setup(t);
  for (let i = 0; i < 500; i++) s.sheet.insertRule(`.r${i}{color:red}`, 0);
  await microtasks();
  assert.equal(s.count(), 1);
});

test('replaceSync / replace on an author constructable sheet and rules in @media groups invalidate', async t => {
  const s = setup(t);
  const mine = new CSSStyleSheet();
  mine.replaceSync('.x{color:red}');
  await microtasks();
  assert.equal(s.count(), 1, 'a sheet that is not the polyfill\'s counts, even before it is adopted');
  await mine.replace('.y{color:red}');
  await microtasks();
  assert.equal(s.count(), 2);
  s.sheet.insertRule('@media (min-width:1px){.m{color:red}}', 0);
  await microtasks();
  const base = s.count();
  s.sheet.cssRules[0].insertRule('.n{color:red}', 0);
  await microtasks();
  assert.equal(s.count(), base + 1);
});

test('polyfill-owned sheets never invalidate (geometry rule updates are the hot path); positive control with an author sheet in the same test', async t => {
  const s = setup(t);
  s.owned.insertRule('[data-hic-hit="k"]{transform:none}', 0);
  s.owned.cssRules[0].style.setProperty('transform', 'translate(3px,4px)');
  s.owned.cssRules[0].style.removeProperty('transform');
  s.owned.deleteRule(0);
  s.owned.replaceSync('[data-hic-hit]{pointer-events:none}');
  await microtasks();
  assert.equal(s.count(), 0, 'owned');
  s.sheet.insertRule('.z{color:red}', 0);
  await microtasks();
  assert.equal(s.count(), 1, 'author');
});

test('element.style writes are not stylesheet changes', async t => {
  const s = setup(t);
  document.body.style.setProperty('--x', '1');
  s.layerEl.style.color = 'red';
  s.layerEl.style.cssText = 'color:blue';
  await microtasks();
  assert.equal(s.count(), 0);
});

test('<style> and <link rel=stylesheet> added, removed, edited or toggled invalidate; the polyfill\'s own style node does not', async t => {
  const s = setup(t);
  const style = document.createElement('style');
  style.textContent = '.q{color:red}';
  document.head.append(style);
  await microtasks();
  assert.equal(s.count(), 1);
  style.firstChild.data = '.q{color:blue}';
  await microtasks();
  assert.equal(s.count(), 2);
  style.setAttribute('media', 'print');
  await microtasks();
  assert.equal(s.count(), 3);
  style.remove();
  await microtasks();
  assert.equal(s.count(), 4);
  const own = document.createElement('style');
  own.setAttribute('data-hic-node', '');
  own.id = 'hic-style';
  document.head.append(own);
  own.textContent = '.own{}';
  await microtasks();
  assert.equal(s.count(), 4);
  own.remove();
  const wrapper = document.createElement('div');
  wrapper.innerHTML = '<section><style>.w{}</style></section>';
  document.body.append(wrapper);
  await microtasks();
  assert.equal(s.count(), 5, 'a style inside an added subtree');
  wrapper.remove();
});

test('link load events invalidate (the sheet became readable)', async t => {
  const s = setup(t);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'data:text/css,.l{color:red}';
  document.head.append(link);
  await new Promise((ok) => link.addEventListener('load', ok, { once: true }));
  await microtasks();
  assert.ok(s.count() >= 2, `added + loaded: ${s.count()}`);
  link.remove();
});

test('adoptedStyleSheets: assigning an author sheet invalidates; changing only the polyfill sheets does not', async t => {
  const s = setup(t);
  const extra = new CSSStyleSheet();
  document.adoptedStyleSheets = [s.owned, extra];
  await microtasks();
  assert.equal(s.count(), 1);
  const other = new CSSStyleSheet();
  document.adoptedStyleSheets = [other, extra];
  await microtasks();
  assert.equal(s.count(), 2);
  document.adoptedStyleSheets = [extra, other, s.owned];
  await microtasks();
  assert.equal(s.count(), 3, 'reordering author sheets changes the cascade');
  const before = s.count();
  document.adoptedStyleSheets = [extra, s.owned, other];
  document.adoptedStyleSheets = [extra, other];
  await microtasks();
  assert.equal(s.count(), before, 'adding/removing the polyfill sheet leaves the author list untouched');
});

test('the ledger restores the prototypes and a second install patches again (no stale stamp on native functions)', async t => {
  const s = setup(t);
  assert.notEqual(CSSStyleSheet.prototype.insertRule.toString(), 'function insertRule() { [native code] }');
  s.ledger.restoreAll();
  assert.equal(CSSStyleSheet.prototype.insertRule.toString(), 'function insertRule() { [native code] }');
});

test('after the disposer nothing is invalidated any more', async t => {
  const rig = createRig({ html: '<div drawable>x</div>' });
  const ledger = createPatchLedger(window);
  const style = document.createElement('style');
  document.head.append(style);
  const stop = observeStylesheets(rig.env, ledger);
  t.cleanup(() => { ledger.restoreAll(); style.remove(); });
  stop();
  style.sheet.insertRule('.a{color:red}', 0);
  document.head.append(document.createElement('style'));
  await microtasks();
  assert.equal(rig.store.invalidated.length, 0);
});

test('adoptedStyleSheets mutated IN PLACE (push / splice, no setter) invalidates without a poll; identity and the native setter are kept', async t => {
  const s = setup(t);
  const a = new CSSStyleSheet();
  const list = document.adoptedStyleSheets;
  assert.equal(document.adoptedStyleSheets, list, 'the same object on every read');
  const n = s.count();
  document.adoptedStyleSheets.push(a);
  await microtasks();
  assert.equal(s.count(), n + 1, 'push');
  assert.ok(document.adoptedStyleSheets.includes(a));
  document.adoptedStyleSheets.splice(document.adoptedStyleSheets.indexOf(a), 1);
  await microtasks();
  assert.equal(s.count(), n + 2, 'splice');
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, a];
  await microtasks();
  assert.equal(s.count(), n + 3, 'the setter still works with a spread of the proxy');
  assert.ok(Array.isArray(document.adoptedStyleSheets));
});
