// Shared by the ancestor-move-*.browser.test.mjs files: a canvas whose ancestors change (the canvas moved to another parent, an ancestor of it moved, its shadow host
// moved) must follow the attributes of its NEW ancestors as natively: a class, an inherited custom property or the language on the new parent or higher repaints the
// tile; the same change on an element that is no longer above it repaints nothing and fires no paint. Every way of moving: inside one task (the canvas never leaves the
// document at a checkpoint, it stays active), or across a suspension (removed until the registry takes its layer out, then inserted again), there and back.
import { test, assert } from '/test/unit/lib/t.js';
import { inst, sleep } from '../api-core/_real.mjs';

const BLUE = 'rgb(0, 0, 255)';
const RED = 'rgb(255, 0, 0)';
/** A class `on` on any container turns the drawable blue while it is below it; so do an inherited --c and the language xx. */
const RULES = '#d{background:var(--c, rgb(255,0,0))}#d:lang(xx){background:rgb(0,0,255)}.a.on #d,.b.on #d,.ga.on #d,.gb.on #d{background:rgb(0,0,255)}';
const TREE = '<div class="ga"><div class="a"><canvas content="drawable" width="200" height="100" style="display:block;width:200px;height:100px">'
  + '<div id="d" drawable style="width:200px;height:100px"></div></canvas></div></div><div class="gb"><div class="b"></div></div>';

/**
 * Light: ga > a > canvas, gb > b in the document. Shadow: the same tree (and the rules) in the open shadow root of a host, the host in `ha`, an empty `hb` beside it.
 * @param {any} t @param {boolean} shadow
 */
function fixture(t, shadow) {
  const root = document.createElement('div');
  document.body.append(root);
  t.cleanup(() => root.remove());
  /** @type {ParentNode} */
  let scope = root;
  if (shadow) {
    root.innerHTML = '<div class="ha"><div class="host"></div></div><div class="hb"></div>';
    const sr = /** @type {HTMLElement} */ (root.querySelector('.host')).attachShadow({ mode: 'open' });
    sr.innerHTML = `<style>${RULES}</style>${TREE}`;
    scope = sr;
  } else {
    root.innerHTML = TREE;
  }
  const $ = (/** @type {ParentNode} */ s, /** @type {string} */ q) => /** @type {HTMLElement} */ (s.querySelector(q));
  return {
    scope, ga: $(scope, '.ga'), a: $(scope, '.a'), gb: $(scope, '.gb'), b: $(scope, '.b'),
    ha: shadow ? $(root, '.ha') : null, hb: shadow ? $(root, '.hb') : null, host: shadow ? $(root, '.host') : null,
    canvas: /** @type {HTMLCanvasElement} */ ($(scope, 'canvas')), d: $(scope, '#d'),
  };
}
/** @typedef {ReturnType<typeof fixture>} F */

/** @param {F} f @returns {HTMLElement} the canvas's layer (the tree facade hides it from children and closest(); a query of its scope finds it) */
const layerOf = (f) => /** @type {HTMLElement} */ (f.scope.querySelector(`[data-hic-layer="${f.canvas.getAttribute('data-hic-canvas')}"]`));

/** @param {F} f @param {() => void} remove @param {() => void} insert */
async function acrossSuspension(f, remove, insert) {
  const layer = layerOf(f);
  assert.ok(layer, 'precondition: the canvas has a layer');
  remove();
  for (let i = 0; i < 50 && layer.parentNode; i++) await sleep(10);
  assert.equal(layer.parentNode, null, 'precondition: the canvas was suspended (its layer was taken out)');
  insert();
}

/**
 * A move: [name, do it, the change kinds that apply]. It returns the elements the changes act on afterwards: the new parent, the new grandparent, the former
 * ancestor (no longer above the canvas). Kinds: class / var / lang on the new parent, class on the new grandparent, class / var on the former ancestor.
 * @typedef {[string, (f: F) => Promise<{parent: HTMLElement, grand: HTMLElement|null, former: HTMLElement|null}>, string[]]} Move
 */
const ALL = ['class-parent', 'class-grand', 'var-parent', 'class-former'];
/** @type {Record<string, Move[]>} */
export const MOVES = {
  canvas: [
    ['not moved', async (f) => ({ parent: f.a, grand: f.ga, former: null }), ['class-parent', 'class-grand', 'var-parent', 'lang-parent', 'lang-html']],
    ['moved to another parent in one task', async (f) => { f.b.append(f.canvas); return { parent: f.b, grand: f.gb, former: f.a }; }, ALL],
    ['removed (suspended), then inserted under another parent', async (f) => { await acrossSuspension(f, () => f.canvas.remove(), () => f.b.append(f.canvas)); return { parent: f.b, grand: f.gb, former: f.a }; }, ALL],
    ['removed (suspended), then inserted under the same parent', async (f) => { await acrossSuspension(f, () => f.canvas.remove(), () => f.a.append(f.canvas)); return { parent: f.a, grand: f.ga, former: null }; }, ['class-parent', 'class-grand', 'var-parent']],
  ],
  ancestor: [
    ['its parent moved to another grandparent in one task', async (f) => { f.gb.append(f.a); return { parent: f.a, grand: f.gb, former: f.ga }; }, ALL],
    ['its parent removed (suspended), then inserted under another grandparent', async (f) => { await acrossSuspension(f, () => f.a.remove(), () => f.gb.append(f.a)); return { parent: f.a, grand: f.gb, former: f.ga }; }, ALL],
    ['moved to another parent and back, one paint apart', async (f) => { f.b.append(f.canvas); await sleep(300); f.a.append(f.canvas); return { parent: f.a, grand: f.ga, former: f.b }; }, ALL],
  ],
  // in a shadow tree: the moves above, inside the shadow root; and the shadow HOST moved in the document (the canvas's chain goes through it), where only what
  // inherits into the shadow tree reaches the drawable: a custom property, and the language as far as the browser carries it into a shadow tree (they differ:
  // Chrome carries the host's and above, Safari only that of <html>, Firefox none), so a language change is judged against what the drawable computes
  host: [
    ['its shadow host not moved', async (f) => ({ parent: /** @type {HTMLElement} */ (f.ha), grand: null, former: null }), ['var-parent', 'lang-parent', 'lang-html']],
    ['its shadow host moved to another container in one task', async (f) => { f.hb?.append(/** @type {HTMLElement} */ (f.host)); return { parent: /** @type {HTMLElement} */ (f.hb), grand: null, former: f.ha }; }, ['var-parent', 'lang-parent', 'var-former']],
    ['its shadow host removed (suspended), then inserted in another container', async (f) => { await acrossSuspension(f, () => f.host?.remove(), () => f.hb?.append(/** @type {HTMLElement} */ (f.host))); return { parent: /** @type {HTMLElement} */ (f.hb), grand: null, former: f.ha }; }, ['var-parent', 'lang-parent', 'var-former']],
  ],
};

/** kind -> [label, on, off, colour once on: BLUE, RED, or NATIVE (whatever the drawable computes in this browser)] */
const NATIVE = 'native';
const CHANGES = /** @type {Record<string, [string, (e: {parent: HTMLElement, grand: HTMLElement|null, former: HTMLElement|null, was?: string|null}) => void, (e: any) => void, string]>} */ ({
  'class-parent': ['a class on the new parent', (e) => e.parent.classList.add('on'), (e) => e.parent.classList.remove('on'), BLUE],
  'class-grand': ['a class on the new grandparent', (e) => e.grand?.classList.add('on'), (e) => e.grand?.classList.remove('on'), BLUE],
  'var-parent': ['an inherited custom property on the new parent', (e) => e.parent.style.setProperty('--c', 'rgb(0,0,255)'), (e) => e.parent.style.removeProperty('--c'), BLUE],
  'lang-parent': ['the language of the new parent', (e) => e.parent.setAttribute('lang', 'xx'), (e) => e.parent.removeAttribute('lang'), NATIVE],
  'lang-html': ['the language of the document (<html lang>)', (e) => { e.was = document.documentElement.getAttribute('lang'); document.documentElement.setAttribute('lang', 'xx'); },
    (e) => { if (e.was == null) document.documentElement.removeAttribute('lang'); else document.documentElement.setAttribute('lang', e.was); }, NATIVE],
  'class-former': ['a class on the former ancestor (no longer above the canvas)', (e) => e.former?.classList.add('on'), (e) => e.former?.classList.remove('on'), RED],
  'var-former': ['a custom property on the former ancestor (no longer above the canvas)', (e) => e.former?.style.setProperty('--c', 'rgb(0,0,255)'), (e) => e.former?.style.removeProperty('--c'), RED],
});

const px = (/** @type {HTMLCanvasElement} */ c) => `rgb(${Array.from(/** @type {CanvasRenderingContext2D} */ (c.getContext('2d')).getImageData(100, 50, 1, 1).data.slice(0, 3)).join(', ')})`;

/** @param {string} label @param {Move[]} moves @param {{shadow?: boolean}} [o] */
export function defineMoves(label, moves, { shadow = false } = {}) {
  for (const [move, doMove, kinds] of moves) {
    for (const kind of kinds) {
      const [change, on, off, expected] = CHANGES[kind];
      test(`${label}: ${move}; ${change}`, async (t) => {
        const i = inst(t);
        const f = fixture(t, shadow);
        if (!shadow) {
          const style = document.createElement('style');
          style.textContent = RULES;
          document.head.append(style);
          t.cleanup(() => style.remove());
        }
        let paints = 0;
        f.canvas.onpaint = () => { paints++; /** @type {any} */ (f.canvas.getContext('2d')).drawElementImage(f.d, 0, 0); };
        f.canvas.requestPaint();
        await i.whenPainted(f.canvas);
        await sleep(300);
        const els = await doMove(f);
        await sleep(800);
        const cs = getComputedStyle(f.d).backgroundColor;
        assert.equal(cs, RED, `precondition: the drawable computes red after the move (${cs}; connected ${f.canvas.isConnected}, layer ${!!layerOf(f)?.isConnected})`);
        assert.equal(px(f.canvas), RED, `precondition: red tile after the move (${px(f.canvas)})`);
        paints = 0;
        on(els);
        t.cleanup(() => off(els));
        await sleep(800);
        const now = getComputedStyle(f.d).backgroundColor;
        if (expected !== NATIVE) assert.equal(now, expected, `the change computes as the case says (${now})`);
        assert.equal(px(f.canvas), now, `the tile shows what the drawable computes (${px(f.canvas)} for ${now}, ${paints} paints)`);
        if (expected === NATIVE && now === RED) return; // this browser does not carry the language there: nothing to follow back
        if (expected === RED) { assert.equal(paints, 0, 'a change above no longer reaching the drawable fires no paint, as natively'); return; }
        off(els);
        await sleep(800);
        assert.equal(px(f.canvas), RED, 'and follows it back');
      });
    }
  }
}

/**
 * A move under a parent that ALREADY sets an inherited value (--c blue): nothing changes after the move, so only the move itself can bring the new value to the
 * drawables. The oracle is the canvas: what it computes is what its drawables inherit natively (the drawables live in the layer, whose copied presentation
 * would make a stale drawable compute the stale value too).
 * @param {string} label @param {{shadow?: boolean}} [o]
 */
export function definePresetMoves(label, { shadow = false } = {}) {
  /** @type {Array<[string, (f: F) => Promise<void>]>} */
  const moves = [
    ['moved in one task under a parent that sets the custom property', async (f) => { f.b.append(f.canvas); }],
    ['removed (suspended), then inserted under a parent that sets the custom property', async (f) => { await acrossSuspension(f, () => f.canvas.remove(), () => f.b.append(f.canvas)); }],
  ];
  for (const [move, doMove] of moves) {
    test(`${label}: ${move}`, async (t) => {
      const i = inst(t);
      const f = fixture(t, shadow);
      if (!shadow) {
        const style = document.createElement('style');
        style.textContent = RULES;
        document.head.append(style);
        t.cleanup(() => style.remove());
      }
      f.b.style.setProperty('--c', 'rgb(0,0,255)');
      f.canvas.onpaint = () => /** @type {any} */ (f.canvas.getContext('2d')).drawElementImage(f.d, 0, 0);
      f.canvas.requestPaint();
      await i.whenPainted(f.canvas);
      await sleep(300);
      assert.equal(px(f.canvas), RED, 'precondition: red tile before the move');
      await doMove(f);
      await sleep(800);
      assert.equal(getComputedStyle(f.canvas).getPropertyValue('--c').trim(), 'rgb(0,0,255)', 'the canvas inherits the new value');
      assert.equal(getComputedStyle(f.d).backgroundColor, BLUE, `the drawable inherits it too (${getComputedStyle(f.d).backgroundColor})`);
      assert.equal(px(f.canvas), BLUE, `and the tile shows it (${px(f.canvas)})`);
    });
  }
}
