// Fixer B request: a class / data-theme / custom-property change on an ANCESTOR of the canvas must repaint the tile (the clone carries shells of those ancestors).
import { test, assert } from '/test/unit/lib/t.js';
import { inst, sleep } from '../api-core/_real.mjs';

const CASES = /** @type {Array<[string, string, (w: HTMLElement) => void, (w: HTMLElement) => void]>} */ ([
  ['class on the wrapper', '.wrap.on #d{background:rgb(0,0,255)}', (w) => w.classList.add('on'), (w) => w.classList.remove('on')],
  ['class on body', 'body.on #d{background:rgb(0,0,255)}', () => document.body.classList.add('on'), () => document.body.classList.remove('on')],
  ['class on html', 'html.on #d{background:rgb(0,0,255)}', () => document.documentElement.classList.add('on'), () => document.documentElement.classList.remove('on')],
  ['data-theme on html', 'html[data-theme="dark"] #d{background:rgb(0,0,255)}', () => document.documentElement.setAttribute('data-theme', 'dark'), () => document.documentElement.removeAttribute('data-theme')],
  ['inline custom property on the wrapper', '#d{background:var(--c, rgb(255,0,0))}', (w) => w.style.setProperty('--c', 'rgb(0,0,255)'), (w) => w.style.removeProperty('--c')],
  ['inline custom property on body', '#d{background:var(--c, rgb(255,0,0))}', () => document.body.style.setProperty('--c', 'rgb(0,0,255)'), () => document.body.style.removeProperty('--c')],
  ['lang attribute on the wrapper', '.wrap[lang="xx"] #d{background:rgb(0,0,255)}', (w) => w.setAttribute('lang', 'xx'), (w) => w.removeAttribute('lang')],
]);

for (const [name, css, on, off] of CASES) {
  test(`ancestor attributes: ${name} repaints the tile`, async t => {
    const i = inst(t);
    const style = document.createElement('style');
    style.textContent = `#d{background:rgb(255,0,0)}${css}`;
    document.head.append(style);
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.innerHTML = '<div><canvas content="drawable" width="200" height="100" style="display:block;width:200px;height:100px"><div id="d" drawable style="width:200px;height:100px"></div></canvas></div>';
    document.body.append(wrap);
    t.cleanup(() => { off(wrap); style.remove(); wrap.remove(); });
    const c = /** @type {HTMLCanvasElement} */ (wrap.querySelector('canvas'));
    const d = wrap.querySelector('#d');
    c.onpaint = () => /** @type {any} */ (c.getContext('2d')).drawElementImage(d, 0, 0);
    c.requestPaint();
    await i.whenPainted(c);
    await sleep(500);
    const px = () => Array.from(/** @type {CanvasRenderingContext2D} */ (c.getContext('2d')).getImageData(100, 50, 1, 1).data.slice(0, 3));
    assert.deepEqual(px(), [255, 0, 0], 'precondition: red tile');
    on(wrap);
    await sleep(800);
    assert.deepEqual(px(), [0, 0, 255], 'the tile follows the ancestor change');
    off(wrap);
    await sleep(800);
    assert.deepEqual(px(), [255, 0, 0], 'and follows it back');
  });
}

// WPT onpaint 'canvas ancestor changes': a change that restyles only the ancestor paints nothing in the canvas, and natively fires no paint event. The control (same
// page, a rule that reaches the drawable through inheritance) must fire one.
for (const [name, css, reaches] of /** @type {Array<[string, string, boolean]>} */ ([
  ['a class that restyles only the wrapper (its own background)', '.wrap.on{background:rgb(0,128,0)}', false],
  ['an attribute nothing tests', '', false],
  ['control: a class whose rule sets an inherited property of the wrapper (color)', '.wrap.on{color:rgb(0,0,255)}', true],
  ['control: a class tested above the drawable', '.wrap.on #d{outline:1px solid red}', true],
])) {
  test(`ancestor attributes: ${name} ${reaches ? 'fires a paint' : 'fires no paint'}`, async (t) => {
    const i = inst(t);
    const style = document.createElement('style');
    style.textContent = `#d{background:rgb(255,0,0)}${css}`;
    document.head.append(style);
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.innerHTML = '<canvas content="drawable" width="200" height="100" style="display:block;width:200px;height:100px"><div id="d" drawable style="width:200px;height:100px">text</div></canvas>';
    document.body.append(wrap);
    t.cleanup(() => { style.remove(); wrap.remove(); });
    const c = /** @type {HTMLCanvasElement} */ (wrap.querySelector('canvas'));
    let paints = 0;
    c.onpaint = () => { paints++; /** @type {any} */ (c.getContext('2d')).drawElementImage(wrap.querySelector('#d'), 0, 0); };
    c.requestPaint();
    await i.whenPainted(c);
    await sleep(400);
    paints = 0;
    if (css) wrap.classList.add('on'); else wrap.setAttribute('data-unused', '1');
    await sleep(400);
    assert.equal(paints, reaches ? 1 : 0);
  });
}
