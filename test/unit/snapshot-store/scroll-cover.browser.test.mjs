// Scroll compositor, real install: a composed scroll step shows what the settled tile then shows, also where something the hit-test grid cannot see paints over the
// port, and where a pinned header changes after the plan was made. A list (overlay scrollbars hidden, 120 rows of 30 px, green and blue) in a 400 x 260 drawable;
// three scroll steps from 1 to 40, 80 and 120 css px, each read in the paint that follows it and compared with the settled canvas half a second later.
//   - Something outside the list paints over its port (a box with pointer-events: none, one between the grid's points, the shadow or outline of a box below the
//     port, a generated box of the drawable, what shows through a list without a background): every page carried it along with the list (24,000 pixels wrong
//     before the fix). The plan is refused (refusedBy.cover); controls: no box, a hidden one, a transparent one.
//   - Such a box starts to paint after the plan (a background, a shadow): the damage is checked against the elements outside the list, and the step falls back.
//     Control: a row of the list changes, and the step is still composed.
//   - The sticky header turns translucent after the plan (12,000 pixels wrong before the fix, at most 128 levels): the plan is stale; controls: a header that stays
//     opaque (its text changes) is composed, one translucent from the start is refused.
import { test, assert } from '/test/unit/lib/t.js';
import { inst, sleep } from '../api-core/_real.mjs';

const CSS = '.cv-d{position:relative;width:400px;height:260px;background:white;font:14px Arial}.cv-l{height:240px;overflow:auto;position:relative;scrollbar-width:none;background:white}'
  + '.cv-r{height:30px;box-sizing:border-box}.cv-r:nth-child(2n){background:rgb(0,255,0)}.cv-r:nth-child(2n+1){background:rgb(0,0,255)}'
  + '.cv-o{position:absolute;left:0;top:60px;width:400px;height:30px;background:rgb(255,0,255);z-index:5}'
  + '.cv-h{position:sticky;top:0;z-index:2;height:30px;background:rgb(255,0,255);color:black;box-sizing:border-box}'
  + '.cv-after .cv-d::after{content:"";position:absolute;left:0;top:60px;width:400px;height:30px;background:rgb(255,0,255);pointer-events:none;z-index:5}'
  + '.cv-grad .cv-d{background:linear-gradient(rgb(255,0,0),rgb(0,0,255))}.cv-grad .cv-l{background:transparent}.cv-grad .cv-r{background:transparent!important;border-bottom:1px solid black}';

/**
 * @param {any} t @param {{extra?: string, head?: boolean, cls?: string, before?: (h: HTMLElement) => void, after?: (h: HTMLElement) => void}} o
 * `before` runs before the install, `after` once the list is planned (its pages built)
 */
async function run(t, o) {
  const host = document.createElement('div');
  host.className = o.cls ?? '';
  const rows = Array.from({ length: 120 }, (_, n) => `<div class="cv-r">row ${n}</div>`).join('');
  host.innerHTML = `<style>${CSS}</style><canvas content="drawable" width="400" height="260" style="display:block;width:400px;height:260px"><div class="cv-d" drawable>`
    + `<div class="cv-l">${o.head ? '<div class="cv-h">HEADER</div>' : ''}${rows}</div>${o.extra ?? ''}</div></canvas>`;
  document.body.append(host);
  t.cleanup(() => host.remove());
  o.before?.(host);
  const i = inst(t, { maxDpr: 1 });
  const canvas = /** @type {HTMLCanvasElement} */ (host.querySelector('canvas'));
  const ctx = /** @type {any} */ (canvas.getContext('2d'));
  const list = /** @type {HTMLElement} */ (host.querySelector('.cv-l'));
  canvas.onpaint = () => { ctx.reset(); ctx.drawElementImage(host.querySelector('.cv-d'), 0, 0); };
  canvas.requestPaint();
  await i.whenPainted(canvas);
  const scroll = () => i.report().canvases[0].stats.snapshot.scroll;
  // what the test changes is seen changed once first (the first change of an element damages the whole drawable, which plans the list again)
  for (const el of host.querySelectorAll('.cv-h, .cv-o, .cv-r:nth-child(4)')) /** @type {HTMLElement} */ (el).dataset.seen = '1';
  await sleep(400);
  list.scrollTop = 1;
  for (let k = 0; k < 100; k++) {
    await sleep(30);
    const s = scroll();
    if (s.pages >= 2 || s.refusals > 0) { await sleep(300); break; }
  }
  const planned = scroll();
  if (o.after) { o.after(host); await sleep(500); }
  const pixels = () => ctx.getImageData(0, 0, 400, 260).data;
  // three steps (a step after a change may fall back, and the tile then repairs the pages with what it shows: a box shadow added below the port showed up
  // in the third step's composed frame, 12,000 pixels wrong, before the fix)
  let composed = 0, bad = 0;
  for (const top of [40, 80, 120]) {
    const first = await new Promise((resolve, reject) => {
      const c0 = scroll().composed;
      const timer = setTimeout(() => reject(new Error('no paint after the scroll step')), 4000);
      canvas.addEventListener('paint', () => { clearTimeout(timer); setTimeout(() => resolve({ composed: scroll().composed - c0, px: pixels() }), 0); }, { once: true });
      list.scrollTop = top;
    });
    await sleep(500);
    const settled = pixels();
    for (let p = 0; p < settled.length; p += 4) {
      let d = 0;
      for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(first.px[p + k] - settled[p + k]));
      if (d > 16) bad++;
    }
    composed += first.composed;
  }
  return { composed, bad, planned, after: scroll() };
}

const BOX = '<div class="cv-o" style="pointer-events:none"></div>';

test('control: nothing over the port, the step is composed and equals the settled canvas', async (t) => {
  const r = await run(t, {});
  assert.equal(r.composed, 3, 'composed');
  assert.equal(r.bad, 0, 'no pixel differs from the settled canvas');
});

for (const [what, o] of /** @type {Array<[string, any]>} */ ([
  ['a box with pointer-events: none over the port (a sibling of the list)', { extra: BOX }],
  ['a box whose ancestor has pointer-events: none', { extra: '<div style="pointer-events:none"><div class="cv-o"></div></div>' }],
  ['a 12 px box between the points of the hit-test grid', { extra: '<div class="cv-o" style="left:10px;top:40px;width:12px;height:12px"></div>' }],
  ['the box shadow of a box below the port', { extra: '<div class="cv-o" style="top:250px;height:10px;box-shadow:0 -40px 0 0 rgb(255,0,255)"></div>' }],
  ['the outline of a box below the port', { extra: '<div class="cv-o" style="top:250px;height:10px;background:transparent;outline:30px solid rgb(255,0,255)"></div>' }],
  ['a visible child (pointer-events: none) of a hidden box', { extra: '<div class="cv-o" style="visibility:hidden;background:transparent"><div style="visibility:visible;pointer-events:none;height:30px;background:rgb(255,0,255)"></div></div>' }],
  ['a generated box of the drawable (::after, pointer-events: none)', { cls: 'cv-after' }],
  ['a gradient that shows through a list without a background', { cls: 'cv-grad' }],
])) {
  test(`${what}: the plan is refused (refusedBy.cover), the step is not composed and shows what the settled canvas shows`, async (t) => {
    const r = await run(t, o);
    assert.equal(r.bad, 0, `no pixel differs from the settled canvas (${r.bad})`);
    assert.equal(r.composed, 0, 'not composed');
    assert.ok(r.planned.refusedBy.cover >= 1, `refused for the cover (${JSON.stringify(r.planned.refusedBy)})`);
  });
}

for (const [what, extra] of [['a hidden box', '<div class="cv-o" style="visibility:hidden"></div>'], ['a box of opacity 0 with pointer-events: none', '<div class="cv-o" style="opacity:0;pointer-events:none"></div>'], ['a transparent box with pointer-events: none', '<div class="cv-o" style="background:transparent;pointer-events:none"></div>']]) {
  test(`control: ${what} paints nothing over the port, the step is still composed`, async (t) => {
    const r = await run(t, { extra });
    assert.equal(r.composed, 3, 'composed');
    assert.equal(r.bad, 0, `equals the settled canvas (${r.bad})`);
    assert.ok(!r.planned.refusedBy.cover, 'not refused');
  });
}

for (const [what, extra, change] of /** @type {Array<[string, string, (h: HTMLElement) => void]>} */ ([
  ['a transparent box with pointer-events: none gets a background', '<div class="cv-o" style="pointer-events:none;background:transparent"></div>', (h) => { /** @type {HTMLElement} */ (h.querySelector('.cv-o')).style.background = 'rgb(255,0,255)'; }],
  ['a transparent 12 px box between the grid\'s points gets a background', '<div class="cv-o" style="left:10px;top:40px;width:12px;height:12px;background:transparent"></div>', (h) => { /** @type {HTMLElement} */ (h.querySelector('.cv-o')).style.background = 'rgb(255,0,255)'; }],
  ['a box below the port gets a shadow over it', '<div class="cv-o" style="top:250px;height:10px;background:transparent"></div>', (h) => { /** @type {HTMLElement} */ (h.querySelector('.cv-o')).style.boxShadow = '0 -40px 0 0 rgb(255,0,255)'; }],
])) {
  test(`after the plan, ${what}: the step falls back to the plain path and shows what the settled canvas shows`, async (t) => {
    const r = await run(t, { extra, after: change });
    assert.ok(r.planned.pages >= 2 && r.planned.refusals === 0, 'planned, pages built');
    assert.equal(r.bad, 0, `no pixel differs from the settled canvas (${r.bad})`);
    assert.equal(r.composed, 0, 'not composed');
    assert.ok(r.after.obstructed >= 1, 'counted as an obstruction');
  });
}

test('control: after the plan, a row of the list changes (a box outside it with pointer-events: none rests beside the port): the step is still composed', async (t) => {
  const r = await run(t, {
    extra: '<div class="cv-o" style="pointer-events:none;top:242px;height:18px"></div>',
    after: (h) => { /** @type {HTMLElement} */ (h.querySelectorAll('.cv-r')[3]).style.background = 'rgb(255,128,0)'; },
  });
  assert.ok(r.composed >= 1, `composed (${r.composed} of 3 steps)`);
  assert.equal(r.bad, 0, `equals the settled canvas (${r.bad})`);
  assert.equal(r.after.obstructed, 0);
});

test('control: a sticky header that stays opaque is composed, also after its text changed', async (t) => {
  const r = await run(t, { head: true, after: (h) => { /** @type {HTMLElement} */ (h.querySelector('.cv-h')).textContent = 'HEADER 2'; } });
  assert.ok(r.composed >= 1, `composed (${r.composed} of 3 steps)`);
  assert.equal(r.bad, 0, `equals the settled canvas (${r.bad})`);
  assert.equal(r.after.stale, 0);
});

test('control: a sticky header translucent from the start refuses the plan', async (t) => {
  const r = await run(t, { head: true, before: (h) => { /** @type {HTMLElement} */ (h.querySelector('.cv-h')).style.opacity = '0.5'; } });
  assert.equal(r.composed, 0, 'not composed');
  assert.ok(r.planned.refusals >= 1, 'refused');
});

for (const [what, change] of /** @type {Array<[string, (e: HTMLElement) => void]>} */ ([['opacity: 0.5', (e) => { e.style.opacity = '0.5'; }], ['a translucent background', (e) => { e.style.background = 'rgba(255,0,255,0.5)'; }], ['a box shadow', (e) => { e.style.boxShadow = '0 4px 8px black'; }]])) {
  test(`a sticky header that gets ${what} after the plan: the plan is stale, the step shows what the settled canvas shows`, async (t) => {
    const r = await run(t, { head: true, after: (h) => change(/** @type {HTMLElement} */ (h.querySelector('.cv-h'))) });
    assert.ok(r.planned.pages >= 2, 'planned, pages built');
    assert.equal(r.bad, 0, `no pixel differs from the settled canvas (${r.bad})`);
    assert.equal(r.composed, 0, 'not composed');
    assert.ok(r.after.stale >= 1, `counted as stale (${r.after.stale})`);
  });
}
