import { test, assert } from '/test/unit/lib/t.js';
import { installWith } from '/src/api/install.js';
import '/src/native-bridge.js'; // registers the optional native bridge with the core
import { defineFakeNative, diffDescriptors, fakeServices, makeFrame, settle, snapshotDescriptors } from './_page-env.mjs';

/** a frame with the Chrome 154 legacy shape, bridged */
function legacyFrame(/** @type {any} */ t, html = '', omit = /** @type {string[]} */ ([])) {
  const w = makeFrame(t, html);
  const calls = defineFakeNative(w, { legacy: true, omit });
  const installed = installWith({ window: w }, fakeServices());
  t.cleanup(() => installed.uninstall());
  return { w, calls, installed };
}
/** the transform the polyfill's rule gives an element, 'none' when it has none (canvas children have no computed style until the browser lays them out) */
function matrixOf(/** @type {any} */ w, /** @type {Element} */ el) {
  const key = el.getAttribute('data-hic-hit');
  for (const sheet of w.document.adoptedStyleSheets) {
    for (const rule of sheet.cssRules) if (rule.selectorText === `[data-hic-hit="${key}"]`) return rule.style.getPropertyValue('transform');
  }
  return 'none';
}

test('legacy shape: mode native-bridged, native renderer untouched, only additions plus the wrapped methods', t => {
  const w = makeFrame(t);
  defineFakeNative(w, { legacy: true });
  const before = snapshotDescriptors(w);
  const installed = installWith({ window: w }, fakeServices());
  assert.equal(installed.mode, 'native-bridged');
  assert.equal(installed.native.kind, 'legacy');
  const changed = diffDescriptors(before, snapshotDescriptors(w));
  assert.ok(changed.includes('added HTMLCanvasElement.prototype.content'));
  assert.ok(changed.includes('added window.ElementGeometryUpdateEvent'));
  assert.ok(changed.includes('added HTMLCanvasElement.prototype.onelementgeometryupdate'));
  assert.equal(w.HTMLCanvasElement.prototype.requestPaint, before.get('HTMLCanvasElement.prototype.requestPaint')?.value, 'requestPaint is the native one');
  installed.uninstall();
  assert.deepEqual(diffDescriptors(before, snapshotDescriptors(w)), []);
});

test('getElementImageDefaultSize is built over the earlier ElementImage.width/height (a capture for an Element), and removed on uninstall', t => {
  const w = makeFrame(t, '<canvas id="c" content="drawable" width="300" height="100"><div id="d"></div></canvas>');
  const calls = defineFakeNative(w, { legacy: true });
  assert.equal('getElementImageDefaultSize' in w.HTMLCanvasElement.prototype, false, 'control: the legacy shape has no size getter');
  const installed = installWith({ window: w }, fakeServices());
  assert.deepEqual(installed.native.gaps.includes('getElementImageDefaultSize'), true);
  const c = w.document.getElementById('c');
  const d = w.document.getElementById('d');
  assert.deepEqual({ ...c.getElementImageDefaultSize(d) }, { width: 10, height: 10 });
  assert.equal(calls.filter((x) => x[0] === 'captureElementImage').length, 1, 'an Element is captured once');
  assert.deepEqual({ ...c.getElementImageDefaultSize(new w.ElementImage()) }, { width: 10, height: 10 }, 'an ElementImage is read directly');
  assert.equal(calls.filter((x) => x[0] === 'captureElementImage').length, 1);
  assert.throws(() => c.getElementImageDefaultSize(), TypeError);
  installed.uninstall();
  assert.equal('getElementImageDefaultSize' in w.HTMLCanvasElement.prototype, false);
});

test('content IDL + attribute mirroring: setter, setAttribute, removeAttribute, toggleAttribute keep layoutsubtree in step synchronously', t => {
  const { w } = legacyFrame(t);
  const c = w.document.createElement('canvas');
  w.document.body.append(c);
  assert.equal(c.content, 'fallback');
  c.content = 'drawable';
  assert.equal(c.getAttribute('content'), 'drawable');
  assert.equal(c.hasAttribute('layoutsubtree'), true, 'mirrored at once, no microtask needed');
  assert.equal(c.layoutSubtree, true);
  c.content = 'bogus';
  assert.equal(c.content, 'fallback');
  assert.equal(c.hasAttribute('layoutsubtree'), false);
  c.setAttribute('content', 'Drawable');
  assert.equal(c.content, 'drawable', 'enumerated attribute values are case-insensitive');
  assert.equal(c.hasAttribute('layoutsubtree'), true);
  c.removeAttribute('content');
  assert.equal(c.hasAttribute('layoutsubtree'), false);
  c.toggleAttribute('content');
  assert.equal(c.hasAttribute('layoutsubtree'), false, 'an empty content attribute is not drawable');
  c.setAttribute('content', 'drawable');
  c.toggleAttribute('content', false);
  assert.equal(c.hasAttribute('layoutsubtree'), false);
});

test('only an attribute the bridge added is removed: an author layoutsubtree survives content going away', t => {
  const { w } = legacyFrame(t);
  const c = w.document.createElement('canvas');
  c.setAttribute('layoutsubtree', '');
  c.setAttribute('content', 'drawable');
  c.setAttribute('content', 'fallback');
  assert.equal(c.hasAttribute('layoutsubtree'), true);
});

test('setAttribute on other elements and other attributes is untouched', t => {
  const { w } = legacyFrame(t);
  const d = w.document.createElement('div');
  d.setAttribute('content', 'drawable');
  assert.equal(d.hasAttribute('layoutsubtree'), false);
  const c = w.document.createElement('canvas');
  c.setAttribute('width', '5');
  assert.equal(c.hasAttribute('layoutsubtree'), false);
  assert.equal(d.setAttribute.length, 2, 'wrapper keeps the length of the native method');
  assert.equal(d.setAttribute.name, 'setAttribute');
});

test('parser-created, cloned and innerHTML canvases are mirrored by the observer; existing ones at install', async t => {
  const w = makeFrame(t, '<canvas id="pre" content="drawable"></canvas>');
  defineFakeNative(w, { legacy: true });
  const installed = installWith({ window: w }, fakeServices());
  t.cleanup(() => installed.uninstall());
  assert.equal(w.document.getElementById('pre').hasAttribute('layoutsubtree'), true, 'present at install');
  w.document.body.insertAdjacentHTML('beforeend', '<section><canvas id="late" content="drawable"></canvas></section>');
  const clone = w.document.getElementById('pre').cloneNode();
  clone.removeAttribute('layoutsubtree');
  clone.id = 'clone';
  w.document.body.append(clone);
  await settle();
  assert.equal(w.document.getElementById('late').hasAttribute('layoutsubtree'), true);
  assert.equal(w.document.getElementById('clone').hasAttribute('layoutsubtree'), true);
});

test('adoptRoot makes the bridge watch a shadow root', async t => {
  const { w, installed } = legacyFrame(t, '<div id="h"></div>');
  const root = w.document.getElementById('h').attachShadow({ mode: 'open' });
  root.innerHTML = '<canvas id="in" content="drawable"></canvas>';
  assert.equal(root.getElementById('in').hasAttribute('layoutsubtree'), false);
  installed.adoptRoot(root);
  assert.equal(root.getElementById('in').hasAttribute('layoutsubtree'), true);
  root.innerHTML += '<canvas id="in2" content="drawable"></canvas>';
  await settle();
  assert.equal(root.getElementById('in2').hasAttribute('layoutsubtree'), true);
});

test('drawElementImage, standard caller (content=drawable): the matrix becomes a polyfill-owned CSS rule, the call returns undefined', t => {
  const { w, calls } = legacyFrame(t, '<canvas id="c" content="drawable" width="300" height="100" style="position:absolute;left:0;top:0"><div id="d" style="width:50px;height:20px"></div></canvas>');
  const c = w.document.getElementById('c');
  const d = w.document.getElementById('d');
  const ctx = c.getContext('2d');
  assert.equal(ctx.drawElementImage(d, 100, 50), undefined);
  assert.equal(calls.filter((x) => x[0] === 'drawElementImage').length, 1, 'the native draw ran');
  const update = calls.find((x) => x[0] === 'updateElementGeometry');
  assert.ok(update && update[1] === d, 'and the native updateElementGeometry was called for the drawn element (Chrome 154 needs it for hit testing)');
  assert.equal(String(update?.[2].canvasTransform), 'matrix(1, 0, 0, 1, 100, 50)');
  assert.ok(d.hasAttribute('data-hic-hit'));
  assert.equal(d.getAttribute('style'), 'width:50px;height:20px', 'the author style attribute is never written');
  assert.equal(matrixOf(w, d), 'matrix(1, 0, 0, 1, 100, 50)');
  ctx.drawElementImage(d, 120, 60);
  assert.equal(matrixOf(w, d), 'matrix(1, 0, 0, 1, 120, 60)', 'the rule is updated, not duplicated');
  assert.equal(w.document.adoptedStyleSheets.length, 1);
  assert.equal(w.document.adoptedStyleSheets[0].cssRules.length, 1);
});

test('drawElementImage, legacy caller (layoutsubtree only): native behaviour, the DOMMatrix is returned and nothing is applied', t => {
  const { w } = legacyFrame(t, '<canvas id="c" layoutsubtree width="300" height="100"><div id="d"></div></canvas>');
  const d = w.document.getElementById('d');
  const m = w.document.getElementById('c').getContext('2d').drawElementImage(d, 7, 9);
  assert.equal(String(m), 'matrix(1, 0, 0, 1, 7, 9)');
  assert.equal(d.hasAttribute('data-hic-hit'), false);
  assert.equal(w.document.adoptedStyleSheets.length, 0);
});

test('drawElementImage with preserveElementGeometry applies nothing; draws of an ElementImage-like target are left alone', t => {
  const { w } = legacyFrame(t, '<canvas id="c" content="drawable" width="300" height="100"><div id="d"></div></canvas>');
  const ctx = w.document.getElementById('c').getContext('2d');
  const d = w.document.getElementById('d');
  assert.equal(ctx.drawElementImage(d, 1, 2, { preserveElementGeometry: true }), undefined);
  assert.equal(d.hasAttribute('data-hic-hit'), false);
  assert.equal(ctx.drawElementImage({ width: 1 }, 1, 2), undefined);
});

const DEEP = '<canvas id="c" content="drawable" width="300" height="100"><section><div id="deep"></div></section></canvas>';

test('a NON-DIRECT descendant draw that the native implementation accepts is passed through silently (no false positive)', t => {
  const { w, calls, installed } = legacyFrame(t, DEEP);
  w.document.getElementById('c').getContext('2d').drawElementImage(w.document.getElementById('deep'), 0, 0);
  assert.deepEqual(installed.report().unsupported, []);
  assert.equal(calls.filter((x) => x[0] === 'drawElementImage').length, 1);
});

test('a NON-DIRECT descendant draw that FAILS natively is reported loudly and the native error is rethrown', t => {
  const w = makeFrame(t, DEEP);
  defineFakeNative(w, { legacy: true });
  const proto = w.CanvasRenderingContext2D.prototype;
  proto.drawElementImage = function () { throw new w.DOMException('not a direct child', 'InvalidStateError'); };
  const installed = installWith({ window: w }, fakeServices());
  t.cleanup(() => installed.uninstall());
  assert.throws(() => w.document.getElementById('c').getContext('2d').drawElementImage(w.document.getElementById('deep'), 0, 0), /not a direct child/);
  assert.ok(installed.report().unsupported.some((e) => e.feature === 'legacy-native-bridge'));
});

test('updateElementGeometry / clearElementGeometry / getElementTransform(el): hit-testable through the rule, native called too', t => {
  const { w, calls } = legacyFrame(t, '<canvas id="c" content="drawable" width="300" height="100"><div id="d" style="width:50px;height:20px"></div></canvas>');
  const c = w.document.getElementById('c');
  const d = w.document.getElementById('d');
  c.updateElementGeometry(d, { canvasTransform: new w.DOMMatrix([2, 0, 0, 2, 30, 40]) });
  assert.equal(matrixOf(w, d), 'matrix(2, 0, 0, 2, 30, 40)');
  assert.equal(calls.filter((x) => x[0] === 'updateElementGeometry').length, 1, 'the native method ran as well');
  assert.equal(String(c.getElementTransform(d)), 'matrix(2, 0, 0, 2, 30, 40)', 'the standard one-argument form works on a legacy native');
  const before = calls.length;
  c.getElementTransform(d, new w.DOMMatrix());
  assert.equal(calls.length, before + 1, 'the legacy two-argument form passes through');
  c.updateElementGeometry(d, { clip: { x: 0, y: 0, width: 5, height: 5 } });
  assert.equal(matrixOf(w, d), 'matrix(2, 0, 0, 2, 30, 40)', 'a clip-only update keeps the transform');
  c.clearElementGeometry(d);
  assert.equal(d.hasAttribute('data-hic-hit'), false);
  assert.equal(matrixOf(w, d), 'none');
  assert.equal(String(c.getElementTransform(d)), 'matrix(1, 0, 0, 1, 0, 0)', 'identity when nothing is stored');
  c.updateElementGeometry(d);
  assert.equal(matrixOf(w, d), 'matrix(1, 0, 0, 1, 0, 0)', 'listed with a null transform = hit-tested at the identity');
});

test('uninstall removes the stylesheet and the hit attributes and restores every descriptor', t => {
  const w = makeFrame(t, '<canvas id="c" content="drawable" width="300" height="100"><div id="d"></div></canvas>');
  defineFakeNative(w, { legacy: true });
  const before = snapshotDescriptors(w);
  const installed = installWith({ window: w }, fakeServices());
  const d = w.document.getElementById('d');
  w.document.getElementById('c').getContext('2d').drawElementImage(d, 5, 5);
  assert.equal(w.document.adoptedStyleSheets.length, 1);
  installed.uninstall();
  assert.equal(w.document.adoptedStyleSheets.length, 0);
  assert.equal(d.hasAttribute('data-hic-hit'), false);
  assert.equal(w.document.getElementById('c').hasAttribute('layoutsubtree'), false, 'the mirrored attribute is not left behind');
  assert.deepEqual(diffDescriptors(before, snapshotDescriptors(w)), []);
});

test('mutation check: without the bridge a standard caller would see the native DOMMatrix', t => {
  const w = makeFrame(t, '<canvas id="c" content="drawable" width="300" height="100"><div id="d"></div></canvas>');
  defineFakeNative(w, { legacy: true });
  const m = w.document.getElementById('c').getContext('2d').drawElementImage(w.document.getElementById('d'), 1, 1);
  assert.equal(String(m), 'matrix(1, 0, 0, 1, 1, 1)', 'control: the raw fake native returns the matrix');
});

// Safari Technology Preview 254 with its HTML-in-Canvas feature flag (names read from the binary, test/unit/api-core/_page-env.mjs shape 'webkit-stp'):
// a legacy shape WITHOUT updateElementGeometry / clearElementGeometry. The bridge used to throw "cannot wrap updateElementGeometry", so install fell back to
// mode native and content="drawable" canvases were not drawable at all.
for (const drawReturns of /** @type {const} */ (['matrix', 'undefined'])) {
  test(`Safari Technology Preview shape (drawElementImage returns ${drawReturns}): native-bridged, content mirrored, draws pass through, no internal error`, t => {
    const w = makeFrame(t, '<canvas id="c" content="drawable" width="300" height="100"><div id="d" style="width:50px;height:20px"></div></canvas>');
    const calls = defineFakeNative(w, { shape: 'webkit-stp', drawReturns });
    assert.equal('updateElementGeometry' in w.HTMLCanvasElement.prototype, false, 'control: the shape has no geometry methods');
    const before = snapshotDescriptors(w);
    const installed = installWith({ window: w }, fakeServices());
    assert.equal(installed.mode, 'native-bridged');
    assert.equal(installed.native.kind, 'legacy');
    const report = installed.report();
    assert.deepEqual(report.errors, [], 'no internal error');
    assert.equal(report.deviations.some((d) => d.id === 'native-step-aside' && /bridge failed/.test(d.detail)), false, 'the bridge was not removed');
    const c = w.document.getElementById('c');
    const d = w.document.getElementById('d');
    assert.equal(c.content, 'drawable');
    assert.equal(c.hasAttribute('layoutsubtree'), true, 'content="drawable" is mirrored to the native layoutsubtree');
    assert.equal(c.getContext('2d').drawElementImage(d, 100, 50), undefined, 'a standard caller gets undefined');
    assert.equal(calls.filter((x) => x[0] === 'drawElementImage').length, 1, 'the native draw ran');
    assert.deepEqual(installed.report().errors, [], 'no internal error after a draw (there is no updateElementGeometry to call)');
    assert.equal(String(c.getElementTransform(d)), drawReturns === 'matrix' ? 'matrix(1, 0, 0, 1, 100, 50)' : 'matrix(1, 0, 0, 1, 0, 0)', 'the one-argument form answers');
    assert.equal('updateElementGeometry' in w.HTMLCanvasElement.prototype, false, 'nothing is invented that cannot be built from native API');
    const gl = w.document.createElement('canvas').getContext('webgl');
    if (gl) assert.equal(typeof gl.texElementSubImage2D, 'function', 'texElementSubImage2D built over texElementImage2D');
    installed.uninstall();
    assert.deepEqual(diffDescriptors(before, snapshotDescriptors(w)), []);
  });
}
