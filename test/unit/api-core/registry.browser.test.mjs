import { test, assert, fixture } from '/test/unit/lib/t.js';
import { createCanvasRegistry, SUSPEND_GRACE_MS } from '/src/api/canvas-registry.js';
import { BUS } from '/src/contracts/events.js';
import { fakeLayerFactory, makeEnv, settle } from './_page-env.mjs';

/** registry on a fresh env, with an event log of the bus topics the rest of the system listens to */
function setup(t, options = {}, extra = {}, layerOpts = {}) {
  const ctx = makeEnv(options, extra);
  const layerLog = /** @type {string[]} */ ([]);
  const registry = createCanvasRegistry(ctx.env, fakeLayerFactory(layerLog, layerOpts));
  registry.observe(document); // what install() does through scan(document); the tests then scan only their own fixture
  t.cleanup(() => registry.dispose());
  const events = /** @type {string[]} */ ([]);
  for (const [name, topic] of [['mounted', BUS.CANVAS_MOUNTED], ['unmounting', BUS.CANVAS_UNMOUNTING]]) {
    ctx.bus.on(topic, (/** @type {any} */ p) => events.push(`${name}:${p.record.id}`));
  }
  ctx.bus.on(BUS.CANVAS_STATE, (/** @type {any} */ p) => events.push(`state:${p.record.id}:${p.previous}>${p.state}`));
  return { ...ctx, registry, events, layerLog };
}

/** @param {HTMLElement} host @param {string} html */
function canvasIn(host, html = '') {
  host.insertAdjacentHTML('beforeend', `<canvas content="drawable" width="50" height="20">${html}</canvas>`);
  return /** @type {HTMLCanvasElement} */ (host.lastElementChild);
}

test('initial scan mounts content=drawable canvases and legacy layoutsubtree canvases; others stay alone', t => {
  const host = fixture('<canvas id="a" content="drawable"><div id="ka"></div></canvas><canvas id="b" layoutsubtree><div></div></canvas><canvas id="c"><div></div></canvas><canvas id="d" content="fallback"></canvas>');
  const { registry } = setup(t);
  registry.scan(host);
  const q = (/** @type {string} */ id) => /** @type {HTMLCanvasElement} */ (host.querySelector(id));
  assert.equal(registry.get(q('#a'))?.state, 'active');
  assert.equal(registry.get(q('#b'))?.state, 'active');
  assert.equal(registry.get(q('#b'))?.legacy, true);
  assert.equal(registry.get(q('#a'))?.legacy, false);
  assert.equal(registry.get(q('#c')), undefined);
  assert.equal(registry.get(q('#d')), undefined);
  const layer = q('#a').nextElementSibling;
  assert.equal(layer?.localName, 'hic-layer');
  assert.equal(layer?.querySelector('#ka') !== null, true, 'children were relocated');
  assert.equal(q('#a').children.length, 0);
});

test('legacyNames:false ignores the layoutsubtree attribute', t => {
  const host = fixture('<canvas id="b" layoutsubtree><div></div></canvas>');
  const { registry } = setup(t, { legacyNames: false });
  registry.scan(host);
  assert.equal(registry.all().length, 0);
});

test('a freshly created record has the documented initial shape', t => {
  const host = fixture('');
  const c = canvasIn(host);
  const { registry, env } = setup(t, { defaultFrameCap: 30 });
  registry.scan(host);
  const r = /** @type {any} */ (registry.get(c));
  assert.equal(r.canvas, c);
  assert.equal(r.root, document);
  assert.equal(r.frameCap, 30);
  assert.equal(r.paint.serial, 0);
  assert.equal(r.paint.everFired, false);
  assert.deepEqual(r.geometry.order, []);
  assert.equal(r.store, null);
  assert.equal(r.dpr, env.window.devicePixelRatio);
  assert.ok(r.offscreen instanceof Set);
  assert.ok(Number.isInteger(r.id) && r.id > 0);
});

test('dynamic canvases: appended, innerHTML-inserted and attribute-activated canvases are found by the observer', async t => {
  const host = fixture('');
  const { registry } = setup(t);
  registry.scan(host); // observes the document
  const a = document.createElement('canvas');
  a.setAttribute('content', 'drawable');
  a.innerHTML = '<p>a</p>';
  host.append(a);
  host.insertAdjacentHTML('beforeend', '<section><canvas content="drawable" id="deep"><i></i></canvas></section>');
  const late = document.createElement('canvas');
  host.append(late);
  late.setAttribute('content', 'drawable');
  late.setAttribute('layoutsubtree', '');
  const legacy = document.createElement('canvas');
  host.append(legacy);
  legacy.setAttribute('layoutsubtree', '');
  await settle();
  assert.equal(registry.get(a)?.state, 'active');
  assert.equal(registry.get(/** @type {any} */ (host.querySelector('#deep')))?.state, 'active');
  assert.equal(registry.get(late)?.state, 'active');
  assert.equal(registry.get(late)?.legacy, false, 'content=drawable wins over layoutsubtree');
  assert.equal(registry.get(legacy)?.legacy, true);
  assert.deepEqual(registry.all().map((r) => r.canvas), [a, host.querySelector('#deep'), late, legacy], 'all() is in tree order');
});

test('ensure() mounts synchronously: a layout read right after the attribute write sees the relocated children', t => {
  const host = fixture('');
  const { registry } = setup(t);
  const c = document.createElement('canvas');
  c.innerHTML = '<div id="k" style="width:30px;height:10px"></div>';
  host.append(c);
  c.setAttribute('content', 'drawable');
  assert.equal(registry.get(c), undefined, 'not seen yet (the observer microtask has not run, and the registry is not even observing)');
  const record = registry.ensure(c);
  assert.equal(record?.state, 'active');
  assert.equal(c.nextElementSibling?.querySelector('#k')?.getBoundingClientRect().width, 30);
  assert.equal(registry.ensure(c), record, 'ensure is cheap and idempotent for an active canvas');
});

test('state events: detached > mounting > active, and CANVAS_MOUNTED after the layer is in place', t => {
  const host = fixture('');
  const c = canvasIn(host);
  const { registry, events } = setup(t);
  registry.scan(host);
  const id = registry.get(c)?.id;
  assert.deepEqual(events, [`state:${id}:detached>mounting`, `state:${id}:mounting>active`, `mounted:${id}`]);
});

test('content toggled drawable -> fallback -> drawable: children restored in order, UNMOUNTING first, same record, remounted', async t => {
  const host = fixture('');
  const c = canvasIn(host, '<b id="one"></b><i id="two"></i>text<u id="three"></u>');
  const { registry, events } = setup(t);
  registry.scan(host);
  const record = registry.get(c);
  const layer = c.nextElementSibling;
  assert.equal(c.childNodes.length, 0);
  events.length = 0;
  c.setAttribute('content', 'fallback');
  await settle();
  assert.equal(record?.state, 'detached');
  assert.deepEqual([...c.childNodes].map((n) => n.nodeName), ['B', 'I', '#text', 'U'], 'original order');
  assert.equal(layer?.isConnected, false);
  assert.equal(events[0], `unmounting:${record?.id}`, 'UNMOUNTING is emitted before the children move back');
  c.setAttribute('content', 'drawable');
  await settle();
  assert.equal(registry.get(c), record);
  assert.equal(record?.state, 'active');
  assert.equal(c.childNodes.length, 0);
});

test('content removed: unmounted; layoutsubtree removed while content=drawable: stays mounted', async t => {
  const host = fixture('');
  const c = canvasIn(host, '<b></b>');
  c.setAttribute('layoutsubtree', '');
  const { registry } = setup(t);
  registry.scan(host);
  c.removeAttribute('layoutsubtree');
  await settle();
  assert.equal(registry.get(c)?.state, 'active');
  c.removeAttribute('content');
  await settle();
  assert.equal(registry.get(c)?.state, 'detached');
  assert.equal(c.children.length, 1);
});

test('a canvas moved to another parent in one task keeps its record and its layer follows; no unmount happens', async t => {
  const host = fixture('<div id="p1"></div><div id="p2"></div>');
  const c = canvasIn(host.querySelector('#p1'), '<em></em>');
  const { registry, events, layerLog } = setup(t);
  registry.scan(host);
  const record = registry.get(c);
  const layer = /** @type {Element} */ (c.nextElementSibling);
  events.length = 0;
  host.querySelector('#p2')?.append(c);
  await settle();
  assert.equal(registry.get(c), record);
  assert.equal(record?.state, 'active');
  assert.equal(layer.parentNode, host.querySelector('#p2'), 'the layer moved with the canvas');
  assert.equal(c.nextElementSibling, layer);
  assert.deepEqual(events, [], 'observers of other modules see nothing');
  assert.equal(layerLog.filter((l) => l.startsWith('unmount')).length, 0);
});

test('a removed canvas takes its layer out of the document and is suspended; re-inserting within the grace period resumes it', async t => {
  const host = fixture('');
  const c = canvasIn(host, '<em id="kid"></em>');
  const { registry, fireTimers, timers } = setup(t, {}, { fakeTimers: true });
  registry.scan(host);
  const record = registry.get(c);
  const layer = /** @type {HTMLElement} */ (c.nextElementSibling);
  c.remove();
  await settle();
  assert.equal(record?.state, 'suspended');
  assert.equal(layer.isConnected, false, 'the layer left the document with the canvas');
  assert.ok(layer.querySelector('#kid'), 'the children stay in the layer, out of the document');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, SUSPEND_GRACE_MS);
  host.append(c);
  await settle();
  assert.equal(record?.state, 'active');
  assert.equal(c.nextElementSibling, layer);
  assert.equal(timers[0].cancelled, true, 'the grace timer was cancelled');
  fireTimers();
  assert.equal(registry.get(c), record, 'the cancelled timer did not dispose it');
});

test('a canvas removed for longer than the grace period is disposed: record gone, children back in the canvas', async t => {
  const host = fixture('');
  const c = canvasIn(host, '<em></em><i></i>');
  const { registry, fireTimers, events } = setup(t, {}, { fakeTimers: true });
  registry.scan(host);
  const record = registry.get(c);
  c.remove();
  await settle();
  events.length = 0;
  fireTimers();
  assert.equal(registry.get(c), undefined);
  assert.equal(record?.state, 'disposed');
  assert.equal(c.children.length, 2, 'children restored');
  assert.ok(events.includes(`unmounting:${record?.id}`));
  assert.deepEqual(registry.all(), []);
});

test('nested canvases are managed independently; ownership resolves through the layers', async t => {
  const host = fixture('');
  const outer = canvasIn(host, '<div id="o"></div><canvas content="drawable" id="inner"><p id="i"></p></canvas>');
  const { registry } = setup(t);
  registry.scan(host);
  const inner = /** @type {HTMLCanvasElement} */ (document.getElementById('inner'));
  const ro = registry.get(outer);
  const ri = registry.get(inner);
  assert.equal(ro?.state, 'active');
  assert.equal(ri?.state, 'active');
  assert.equal(ro?.layer?.element.contains(inner), true, 'the inner canvas lives in the outer layer');
  assert.equal(ro?.layer?.element.contains(ri?.layer?.element ?? null), true, 'and so does its layer');
  assert.deepEqual(registry.all().map((r) => r.canvas), [outer, inner]);
  assert.equal(registry.logicalCanvasAncestor(document.getElementById('o')), outer);
  assert.equal(registry.logicalCanvasAncestor(document.getElementById('i')), inner);
  assert.equal(registry.logicalCanvasAncestor(inner), outer, 'the logical parent of the inner canvas is the outer canvas, not the layer');
  assert.equal(registry.ownerOfDrawable(/** @type {Element} */ (document.getElementById('i'))), ri);
  assert.equal(registry.ownerOfDrawable(/** @type {Element} */ (document.getElementById('o'))), ro);
  assert.equal(registry.ownerOfDrawable(inner), ro);
  assert.equal(registry.ownerOfDrawable(document.body), undefined);
});

test('a canvas with a popover attribute is refused loudly, once, and an hicunsupported event reaches the canvas', async t => {
  const host = fixture('<canvas content="drawable" popover id="pop"><div></div></canvas>');
  const c = /** @type {HTMLCanvasElement} */ (host.firstElementChild);
  const { registry, reporter } = setup(t);
  /** @type {any[]} */ const events = [];
  c.addEventListener('hicunsupported', (e) => events.push(/** @type {CustomEvent} */ (e).detail));
  registry.scan(host);
  registry.ensure(c);
  assert.equal(registry.get(c), undefined);
  assert.equal(c.children.length, 1, 'children untouched');
  assert.equal(reporter.entries().filter((e) => e.feature === 'top-layer-canvas').length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].feature, 'top-layer-canvas');
  c.removeAttribute('popover');
  await settle();
  assert.equal(registry.get(c)?.state, 'active', 'accepted once the popover attribute is gone');
});

test('a mounted canvas that gains a popover attribute is unmounted and refused', async t => {
  const host = fixture('');
  const c = canvasIn(host, '<b></b>');
  const { registry, reporter } = setup(t);
  registry.scan(host);
  c.setAttribute('popover', '');
  await settle();
  assert.equal(registry.get(c)?.state, 'detached');
  assert.equal(c.children.length, 1);
  assert.ok(reporter.entries().some((e) => e.feature === 'top-layer-canvas'));
});

test('shadow roots: an announced open root is scanned and observed; a canvas moved between scopes is rebuilt in the new one', async t => {
  const host = fixture('<div id="h"></div>');
  const shadow = /** @type {HTMLElement} */ (host.querySelector('#h')).attachShadow({ mode: 'open' });
  const box = document.createElement('div');
  shadow.append(box);
  const inRoot = canvasIn(box, '<b></b>');
  const { registry, announceRoot, events } = setup(t);
  registry.scan(host);
  assert.equal(registry.get(inRoot), undefined, 'a root nobody announced is not observed or scanned');
  announceRoot(shadow);
  assert.equal(registry.get(inRoot)?.state, 'active');
  assert.equal(registry.get(inRoot)?.root, shadow);
  const dyn = document.createElement('canvas');
  dyn.setAttribute('content', 'drawable');
  shadow.append(dyn);
  await settle();
  assert.equal(registry.get(dyn)?.state, 'active', 'canvases added to an observed root later are found');
  // scope move
  const moving = canvasIn(host, '<i></i>');
  registry.ensure(moving);
  const rec = registry.get(moving);
  assert.equal(rec?.root, document);
  events.length = 0;
  shadow.append(moving);
  await settle();
  assert.equal(registry.get(moving), rec);
  assert.equal(rec?.root, shadow);
  assert.equal(rec?.state, 'active');
  assert.deepEqual(events.filter((e) => e.startsWith('unmounting') || e.startsWith('mounted')), [`unmounting:${rec?.id}`, `mounted:${rec?.id}`]);
  assert.equal(rec?.layer?.element.getRootNode(), shadow, 'the layer was rebuilt inside the new scope');
});

test('a canvas in a shadow root nobody announced (closed root created before install) is refused with the adoptRoot hint', async t => {
  const host = fixture('<div id="h"></div>');
  const closed = /** @type {HTMLElement} */ (host.querySelector('#h')).attachShadow({ mode: 'closed' });
  const box = document.createElement('div');
  closed.append(box);
  const c = canvasIn(box, '<b></b>');
  const { registry, reporter, announceRoot } = setup(t);
  assert.equal(registry.ensure(c), undefined);
  const entry = reporter.entries().find((e) => e.feature === 'shadow-canvas');
  assert.ok(entry, 'reported');
  assert.ok(/adoptRoot/.test(entry?.hint ?? ''), 'hint names adoptRoot');
  assert.equal(c.children.length, 1, 'untouched');
  host.append(document.createElement('span'));
  await settle();
  assert.equal(reporter.entries().find((e) => e.feature === 'shadow-canvas')?.count, 1, 'unrelated mutations do not report again');
  announceRoot(closed); // what installed.adoptRoot(root) does
  assert.equal(registry.get(c)?.state, 'active');
});

test('autoDiscover:false: nothing is observed or scanned; ensure() still adopts explicitly', async t => {
  const host = fixture('');
  const early = canvasIn(host);
  const { registry } = setup(t, { autoDiscover: false });
  registry.scan(document);
  const later = document.createElement('canvas');
  later.setAttribute('content', 'drawable');
  host.append(later);
  await settle();
  assert.equal(registry.get(later), undefined);
  assert.equal(registry.ensure(early)?.state, 'active', 'explicit adoption (installed.adopt / API entry points) works');
});

test('a layer factory that throws leaves the canvas alone, is reported once, other canvases still mount, and unrelated mutations do not retry', async t => {
  const host = fixture('');
  const bad = canvasIn(host, '<b></b>');
  const good = canvasIn(host, '<i></i>');
  const { registry, layerLog } = setup(t, {}, {}, { failFor: (r) => r.canvas === bad });
  registry.scan(document);
  assert.equal(registry.get(bad)?.state, 'detached');
  assert.equal(bad.children.length, 1);
  assert.equal(registry.get(good)?.state, 'active');
  host.append(document.createElement('span'));
  host.append(document.createElement('span'));
  await settle();
  assert.equal(layerLog.filter((l) => l === `mount:${registry.get(good)?.id}`).length, 1, 'the good canvas was mounted exactly once');
  bad.setAttribute('content', 'fallback');
  bad.setAttribute('content', 'drawable');
  await settle();
  assert.equal(registry.get(bad)?.state, 'detached', 'touching the canvas retries, and it fails again without breaking anything');
});

test('dispose: every record unmounted, children restored, observers disconnected', async t => {
  const host = fixture('');
  const a = canvasIn(host, '<b></b>');
  const b = canvasIn(host, '<i></i>');
  const { registry, events } = setup(t);
  registry.scan(document);
  const recA = registry.get(a);
  registry.dispose();
  assert.equal(a.children.length, 1);
  assert.equal(b.children.length, 1);
  assert.equal(recA?.state, 'disposed');
  assert.deepEqual(registry.all(), []);
  assert.equal(events.filter((e) => e.startsWith('unmounting')).length, 2);
  const late = canvasIn(host, '<u></u>');
  await settle();
  assert.equal(registry.get(late), undefined, 'the observers are gone');
  registry.dispose();
});

test('setState is the only writer: it emits CANVAS_STATE and ignores a no-op', t => {
  const host = fixture('');
  const c = canvasIn(host);
  const { registry, events } = setup(t);
  const record = registry.create(c);
  assert.equal(record.state, 'detached');
  assert.equal(registry.create(c), record);
  registry.setState(record, 'suspended');
  registry.setState(record, 'suspended');
  assert.deepEqual(events, [`state:${record.id}:detached>suspended`]);
});

test('all() is in shadow-including tree order: a shadow root comes after its host and before the host\'s light children, nested roots included (WPT onpaint-post-tree-order-shadow-dom); compareDocumentPosition alone cannot order different trees', async t => {
  const host = fixture('<canvas id="before" content="drawable"></canvas><div id="h"><canvas id="light1" content="drawable"></canvas><canvas id="light2" slot="s" content="drawable"></canvas></div><canvas id="after" content="drawable"></canvas>');
  const shadow = /** @type {HTMLElement} */ (host.querySelector('#h')).attachShadow({ mode: 'open' });
  shadow.innerHTML = '<slot name="s"><canvas id="fallback" content="drawable"></canvas></slot><div id="inner"></div><canvas id="shadow2" content="drawable"><slot></slot></canvas>';
  const inner = /** @type {HTMLElement} */ (shadow.querySelector('#inner')).attachShadow({ mode: 'open' });
  inner.innerHTML = '<canvas id="deep" content="drawable"></canvas>';
  const { registry, announceRoot } = setup(t);
  registry.scan(host);
  announceRoot(shadow);
  announceRoot(inner);
  await settle();
  const name = (/** @type {any} */ r) => r.canvas.id;
  assert.deepEqual(registry.all().map(name), ['before', 'fallback', 'deep', 'shadow2', 'light1', 'light2', 'after']);
});

test('a canvas in an OPEN shadow root nobody announced (a declarative root made by the parser) is adopted with its root, which is then observed; a closed one is still refused', async t => {
  const host = fixture('<div id="o"></div><div id="c"></div>');
  const open = /** @type {HTMLElement} */ (host.querySelector('#o')).attachShadow({ mode: 'open' });
  const closed = /** @type {HTMLElement} */ (host.querySelector('#c')).attachShadow({ mode: 'closed' });
  const inOpen = canvasIn(open.appendChild(document.createElement('div')), '<b></b>');
  const inClosed = canvasIn(closed.appendChild(document.createElement('div')), '<b></b>');
  const ctx = setup(t);
  /** @type {ShadowRoot[]} */
  const adopted = [];
  ctx.env.roots.adopt = (/** @type {ShadowRoot} */ root) => { adopted.push(root); ctx.announceRoot(root); };
  assert.equal(ctx.registry.ensure(inOpen)?.state, 'active', 'managed at once');
  assert.deepEqual(adopted, [open], 'its root was adopted');
  assert.equal(ctx.registry.all().filter((r) => r.canvas === inOpen).length, 1, 'one record, not two');
  const later = document.createElement('canvas');
  later.setAttribute('content', 'drawable');
  open.append(later);
  await settle();
  assert.equal(ctx.registry.get(later)?.state, 'active', 'the adopted root is observed');
  assert.equal(ctx.registry.ensure(inClosed), undefined, 'control: a closed root cannot be adopted from its canvas');
  assert.ok(ctx.reporter.entries().some((e) => e.feature === 'shadow-canvas'));
});
