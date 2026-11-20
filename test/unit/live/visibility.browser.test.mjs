import { test, assert } from '/test/unit/lib/t.js';
import { setup, page } from '/test/unit/live/lib.mjs';
import { installVisibilityBridge } from '/src/live/visibility-bridge.js';
import { inst, mk } from '/test/unit/api-core/_real.mjs';

// #a (drawable) holds #inner, #faded (opacity 0), #hid (visibility hidden) and a shadow host whose root holds #sh and #shfaded (opacity 0); #plain is a
// non-drawable child of the canvas; #outside is a sibling of the canvas.
const KIDS = '<div id="a" drawable style="width:50px;height:20px"><span id="inner">text</span><span id="faded" style="opacity:0">x</span>'
  + '<span id="hid" style="visibility:hidden">y</span><span id="host"></span></div><div id="plain" style="width:50px;height:20px">not drawable</div>';
const IDS = ['a', 'inner', 'faded', 'hid', 'plain', 'outside', 'sh', 'shfaded'];
const OPTIONS = {
  opacity: { opacityProperty: true },
  visibility: { visibilityProperty: true },
  both: { opacityProperty: true, visibilityProperty: true },
  legacy: { checkOpacity: true, checkVisibilityCSS: true },
};
// What Chrome 157 answers with its native HTML-in-Canvas (CanvasDrawElement on) for the same tree, one digit per id of IDS (1 = visible).
const NATIVE = {
  '': { opacity: '11011110', visibility: '11101111', both: '11001110', legacy: '11001110' },
  'canvas opacity 0': { opacity: '00000100', visibility: '11101111', both: '00000100', legacy: '00000100' },
  'wrapper opacity 0': { opacity: '00000100', visibility: '11101111', both: '00000100', legacy: '00000100' },
};

/** @param {string} variant @returns {{canvas: HTMLCanvasElement, root: HTMLElement, get: (id: string) => Element}} */
function tree(variant) {
  const { root, canvas } = page(KIDS, variant === 'canvas opacity 0' ? 'opacity:0' : '', '', '<div id="outside" style="width:10px;height:10px">outside</div>');
  if (variant === 'wrapper opacity 0') {
    // a wrapper of the canvas only (#outside stays outside it)
    const wrap = document.createElement('div');
    wrap.style.opacity = '0';
    canvas.before(wrap);
    wrap.append(canvas);
  }
  const sr = /** @type {Element} */ (canvas.querySelector('#host')).attachShadow({ mode: 'open' });
  sr.innerHTML = '<b id="sh">s</b><i id="shfaded" style="opacity:0">f</i>';
  const get = (/** @type {string} */ id) => /** @type {Element} */ (root.querySelector(`#${id}`) ?? sr.getElementById(id));
  return { canvas, root, get };
}

/** @param {(id: string) => Element} get @returns {Record<string, string>} */
function answers(get) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, o] of Object.entries(OPTIONS)) out[k] = IDS.map((id) => (get(id).checkVisibility(o) ? '1' : '0')).join('');
  return out;
}

for (const variant of Object.keys(NATIVE)) {
  test(`checkVisibility of drawn children answers as natively (${variant || 'plain tree'})`, (t) => {
    const { env, ledger, managed } = setup({ t });
    const { canvas, get } = tree(variant);
    const r = managed(canvas);
    assert.equal(getComputedStyle(r.layer.element).opacity, '0', 'precondition: the layer is transparent on this engine');
    const stop = installVisibilityBridge(env, ledger);
    t.cleanup(stop);
    assert.deepEqual(answers(get), NATIVE[variant]);
    assert.equal(get('a').checkVisibility(), true, 'without options');
  });
}

test('after stop, and for elements outside a layer, the platform answer is returned', (t) => {
  const { env, ledger, managed } = setup({ t });
  const { canvas, get } = tree('');
  managed(canvas);
  const stop = installVisibilityBridge(env, ledger);
  assert.equal(get('outside').checkVisibility({ opacityProperty: true }), true);
  assert.equal(get('a').checkVisibility({ opacityProperty: true }), true);
  stop();
  assert.equal(get('a').checkVisibility({ opacityProperty: true }), false, 'the platform: the transparent layer hides the child');
});

test('the real install wires the bridge, and uninstall restores the platform method', async (t) => {
  const platform = Element.prototype.checkVisibility;
  const i = inst(t);
  const c = await mk(t, i);
  const a = /** @type {Element} */ (c.querySelector('#a'));
  assert.equal(a.checkVisibility({ opacityProperty: true }), true);
  assert.equal(/** @type {Element} */ (c.querySelector('#g')).checkVisibility({ checkOpacity: true }), true);
  i.uninstall();
  assert.equal(Element.prototype.checkVisibility, platform);
});
