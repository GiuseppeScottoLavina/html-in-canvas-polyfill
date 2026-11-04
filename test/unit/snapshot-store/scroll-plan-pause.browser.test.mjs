// A scroll plan made in steps (scroll-pages.js planSteps, real install): a change of the content between two steps that an installed plan would not survive leaves
// no plan built on the rules read before it. A box of the list that becomes position:fixed while the hit-test grid is being made no longer scrolls with the list, so
// a composed step must not carry it along (scroll-compose.js Pending: the plan is made again). The hit tests are slowed so that the grid takes several post-frame
// tasks; the change is made by a timer between two of them and seen by the real MutationObserver.
import { test, assert } from '/test/unit/lib/t.js';
import { inst, sleep } from '../api-core/_real.mjs';

const MAGENTA = (d, i) => d[i] > 245 && d[i + 1] < 10 && d[i + 2] > 245 && d[i + 3] > 245;

/**
 * @param {any} t @param {'none'|'fixed-before'|'fixed-between'|'colour-between'} change @param {boolean} [seen]  the box changed once before (its damage has a rect from then on)
 */
async function run(t, change, seen = false) {
  const i = inst(t);
  const host = document.createElement('div');
  host.innerHTML = '<canvas content="drawable" width="400" height="260" style="display:block;width:400px;height:260px"><div id="pd" drawable style="width:400px;height:260px;background:white;font:14px sans-serif">'
    + '<div id="pl" style="height:240px;overflow:auto;scrollbar-width:none;position:relative;background:white">'
    + '<div id="pb" style="position:absolute;left:20px;top:60px;width:80px;height:20px;background:rgb(255,0,255);z-index:1"></div>'
    + Array.from({ length: 120 }, (_, n) => `<div style="height:34px;border-bottom:1px solid #ccc;box-sizing:border-box">row ${n}</div>`).join('')
    + '</div></div></canvas>';
  document.body.append(host);
  t.cleanup(() => host.remove());
  const canvas = /** @type {HTMLCanvasElement} */ (host.querySelector('canvas'));
  const ctx = /** @type {any} */ (canvas.getContext('2d'));
  const list = /** @type {HTMLElement} */ (host.querySelector('#pl'));
  const box = /** @type {HTMLElement} */ (host.querySelector('#pb'));
  if (change === 'fixed-before') box.style.position = 'fixed';
  canvas.onpaint = () => { ctx.reset(); ctx.drawElementImage(host.querySelector('#pd'), 0, 0); };
  canvas.requestPaint();
  await i.whenPainted(canvas);
  if (seen) { box.dataset.seen = '1'; await sleep(100); }
  await sleep(150);
  const scroll = () => i.report().canvases[0].stats.snapshot.scroll;
  /** magenta bounding box, canvas px */
  const magenta = () => {
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let n = 0, y0 = Infinity, y1 = -Infinity;
    for (let p = 0; p < d.length; p += 4) if (MAGENTA(d, p)) { n++; const y = Math.floor(p / 4 / canvas.width); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return { n, y0, y1 };
  };
  // each hit test of the planner's grid takes 0.4 ms: the grid is made in several post-frame tasks (steps of about 3 ms), with timers between them
  const hit = document.elementFromPoint;
  let hits = 0, changed = false;
  document.elementFromPoint = function (x, y) {
    if (++hits === 3 && (change === 'fixed-between' || change === 'colour-between')) {
      setTimeout(() => { if (change === 'fixed-between') box.style.position = 'fixed'; else box.style.background = 'rgb(255, 0, 254)'; changed = true; }, 0);
    }
    const until = performance.now() + 0.4;
    while (performance.now() < until);
    return hit.call(this, x, y);
  };
  t.cleanup(() => { delete document.elementFromPoint; });
  list.scrollTop = 1;
  for (let k = 0; k < 100; k++) {
    await sleep(30);
    const s = scroll();
    if (s.pages >= 2 || s.refusals > 0) break;
  }
  delete document.elementFromPoint;
  await sleep(300);
  const planned = scroll();
  // one scroll step, read at the paint that follows it, then the settled tile
  const first = await new Promise((resolve, reject) => {
    const c0 = scroll().composed;
    const timer = setTimeout(() => reject(new Error('no paint after the scroll step')), 3000);
    canvas.addEventListener('paint', () => { clearTimeout(timer); setTimeout(() => resolve({ composed: scroll().composed - c0, px: magenta() }), 0); }, { once: true });
    list.scrollTop = 40;
  });
  await sleep(500);
  return { first, settled: magenta(), planned, hits, changed };
}

test('control: nothing changes while the grid is made, the plan composes the step and the box moves with the list', async (t) => {
  const r = await run(t, 'none');
  assert.ok(r.hits > 20, `the grid was made (${r.hits} hit tests)`);
  assert.equal(r.first.composed, 1, 'the step was composed');
  assert.ok(r.first.px.n > 0 && r.first.px.y0 === r.settled.y0, `composed box at the settled place (rows ${r.first.px.y0} / ${r.settled.y0})`);
});

test('control: a box fixed from the start refuses the plan', async (t) => {
  const r = await run(t, 'fixed-before');
  assert.equal(r.first.composed, 0, 'not composed');
  assert.ok(r.planned.refusals > 0, 'refused');
});

for (const seen of [false, true]) test(`a box that becomes position:fixed between two steps of the grid is never composed at its old place: the plan is made again, and refused (${seen ? 'a box changed before: same size, other position' : 'its first change'})`, async (t) => {
  const r = await run(t, 'fixed-between', seen);
  assert.ok(r.changed, 'the change was made while the grid was being made');
  assert.ok(r.settled.n > 0, 'the settled tile shows the box');
  assert.equal(r.first.px.y0, r.settled.y0, `first frame after the step: the box where the settled tile has it (rows ${r.first.px.y0} / ${r.settled.y0}, composed ${r.first.composed})`);
  assert.ok(r.planned.stale > 0, `the stale plan was counted (${r.planned.stale})`);
});

test('a colour change between two steps leaves the plan valid (only an installed plan\'s pages would be repaired): the step is still composed', async (t) => {
  const r = await run(t, 'colour-between', true);
  assert.ok(r.changed, 'the change was made while the grid was being made');
  assert.equal(r.planned.stale, 0, 'not stale');
  assert.ok(r.planned.pages >= 2, 'pages built');
  assert.equal(r.first.composed, 1, 'the step was composed');
  assert.ok(r.first.px.n > 0 && r.first.px.y0 === r.settled.y0, `composed box at the settled place (rows ${r.first.px.y0} / ${r.settled.y0})`);
});
