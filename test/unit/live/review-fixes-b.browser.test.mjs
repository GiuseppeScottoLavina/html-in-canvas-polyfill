// Regression tests of the correctness review (m4): uninstall keeps the focused element of the managed content.
import { test, assert } from '/test/unit/lib/t.js';
import { install } from '/src/index.js';
import { mk, sleep } from '../api-core/_real.mjs';

test('m4: uninstall keeps the focused element', async t => {
  const i = install();
  let live = true;
  t.cleanup(() => { if (live) i.uninstall(); });
  const c = await mk(t, i, { inner: '<div id="d" drawable style="width:120px;height:60px"><input id="in" value="x"></div>' });
  const input = /** @type {HTMLInputElement} */ (document.querySelector('#in'));
  input.focus();
  assert.equal(document.activeElement, input, 'precondition: the input has focus');
  assert.equal(c.isConnected, true);
  i.uninstall();
  live = false;
  assert.equal(document.activeElement, input, 'focus kept');
});

/** a menu (positioned, z-index:auto) BEFORE a non-positioned canvas whose drawable is drawn under it: natively the menu paints above the canvas, the live layer covers it */
async function stackingPage(t, /** @type {string} */ canvasStyle) {
  const i = install();
  t.cleanup(() => i.uninstall());
  const host = document.createElement('div');
  host.style.cssText = 'position:relative;height:220px';
  host.innerHTML = `<div id="menu" style="position:absolute;left:150px;top:30px;width:120px;height:140px;background:#fa0">menu</div>
    <canvas id="cv" content="drawable" width="300" height="160" style="display:block;width:300px;height:160px;${canvasStyle}"><div id="d" drawable style="width:300px;height:160px;background:#cfe">x</div></canvas>`;
  document.body.append(host);
  t.cleanup(() => host.remove());
  const c = /** @type {HTMLCanvasElement} */ (host.querySelector('#cv'));
  c.onpaint = () => /** @type {any} */ (c.getContext('2d')).drawElementImage(host.querySelector('#d'), 0, 0);
  c.requestPaint();
  await i.whenPainted(c);
  await sleep(700);
  return { i, c };
}

test('browser M2: the stacking audit runs after the first draw and reports page content that paints above the canvas but under the live layer', async t => {
  const { i } = await stackingPage(t, '');
  const found = i.report().unsupported.filter((u) => u.feature === 'stacking-overlap');
  assert.ok(found.length >= 1, `report().unsupported: ${JSON.stringify(i.report().unsupported.map((u) => u.feature))}`);
  assert.ok(found[0].path.includes('menu'), found[0].path);
});

test('browser M2 control: a positioned canvas stacks like the layer and reports nothing', async t => {
  const { i } = await stackingPage(t, 'position:relative;z-index:0');
  assert.deepEqual(i.report().unsupported.filter((u) => u.feature === 'stacking-overlap'), []);
});

/** layout of `.p` and what follows it, relative to the container's origin */
function layoutOf(/** @type {Element} */ root) {
  const o = root.getBoundingClientRect();
  return JSON.stringify([...root.querySelectorAll('.p, .after, .cv')].map((e) => {
    const r = e.getBoundingClientRect();
    return [r.left - o.left, r.top - o.top, r.width, r.height].map(Math.round);
  }));
}

const STRUCTURAL_CASES = /** @type {Array<[string, string, string]>} */ ([
  [':last-child margin reset', '.p>:last-child{margin-bottom:0}.p>*{margin-bottom:30px}', '<span>x</span>%CV%'],
  [':only-child', '.p>:only-child{margin:0}.p>*{margin:25px}', '%CV%'],
  [':nth-last-child(1)', '.p>:nth-last-child(1){display:block;margin-top:40px}', '<span>x</span>%CV%'],
  ['flex margin-left:auto on :last-child', '.p{display:flex;width:500px}.p>:last-child{margin-left:auto}', '<span>x</span>%CV%'],
  ['selector list with :last-child', '.p>.nomatch,.p>:last-child{margin-top:33px}', '<span>x</span>%CV%'],
]);

for (const [name, css, inner] of STRUCTURAL_CASES) {
  test(`browser M3: ${name} lays out like a plain element in the canvas's place`, async t => {
    const i = install();
    t.cleanup(() => i.uninstall());
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    t.cleanup(() => style.remove());
    const host = document.createElement('div');
    host.style.cssText = 'padding:8px';
    host.innerHTML = `<div id="poly"><div class="p">${inner.replace('%CV%', '<canvas class="cv" content="drawable" style="display:block;width:100px;height:50px"><span drawable>d</span></canvas>')}</div><div class="after">after</div></div>
      <div id="ref"><div class="p">${inner.replace('%CV%', '<div class="cv" style="width:100px;height:50px"></div>')}</div><div class="after">after</div></div>`;
    document.body.append(host);
    t.cleanup(() => host.remove());
    await sleep(300);
    assert.equal(layoutOf(/** @type {Element} */ (host.querySelector('#poly'))), layoutOf(/** @type {Element} */ (host.querySelector('#ref'))));
  });
}

test('browser m5: the layer carries no inline display, so a sheet rule (the @media print one) can hide it', async t => {
  const i = install();
  t.cleanup(() => i.uninstall());
  const c = await mk(t, i);
  const layer = /** @type {HTMLElement} */ (document.querySelector('hic-layer'));
  assert.equal(layer.style.getPropertyValue('display'), '', 'no inline display');
  assert.equal(getComputedStyle(layer).display, 'grid', 'children sit at the canvas origin, shrink to fit, like the native canvas layout');
  const sheet = new CSSStyleSheet();
  sheet.replaceSync('@media all{hic-layer[data-hic-layer]{display:none !important}}'); // stands in for @media print
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  t.cleanup(() => { document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet); });
  assert.equal(getComputedStyle(layer).display, 'none');
  assert.ok(c.isConnected);
});

test('browser m6: a pointer-events:none ancestor of the canvas disables the live children; a normal canvas keeps them hit-testable', async t => {
  const i = install();
  t.cleanup(() => i.uninstall());
  const build = async (/** @type {string} */ wrapperStyle) => {
    const host = document.createElement('div');
    host.style.cssText = wrapperStyle;
    host.innerHTML = '<canvas content="drawable" width="200" height="100" style="display:block;width:200px;height:100px"><button id="b" drawable style="width:100px;height:40px">b</button></canvas>';
    document.body.append(host);
    t.cleanup(() => host.remove());
    const c = /** @type {HTMLCanvasElement} */ (host.firstElementChild);
    const b = /** @type {HTMLElement} */ (host.querySelector('hic-layer button') ?? c.querySelector('button'));
    c.onpaint = () => /** @type {any} */ (c.getContext('2d')).drawElementImage(b, 0, 0);
    c.requestPaint();
    await i.whenPainted(c);
    await sleep(100);
    const r = c.getBoundingClientRect();
    return document.elementsFromPoint(r.left + 20, r.top + 10).some((e) => e === b);
  };
  assert.equal(await build(''), true, 'control: the drawn button is hit-testable');
  assert.equal(await build('pointer-events:none'), false, 'disabled by the ancestor');
});
