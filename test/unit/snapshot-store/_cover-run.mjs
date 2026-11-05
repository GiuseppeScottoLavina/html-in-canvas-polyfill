// The run of scroll-cover.browser.test.mjs and scroll-sticky.browser.test.mjs: a list (overlay scrollbars hidden, 120 rows of 30 px, green and blue) in a 400 x 260
// drawable, planned, then three scroll steps from 1 to 40, 80 and 120 css px, each read in the paint that follows it and compared with the settled canvas half a
// second later.
import { inst, sleep } from '../api-core/_real.mjs';

const CSS = '.cv-d{position:relative;width:400px;height:260px;background:white;font:14px Arial}.cv-l{height:240px;overflow:auto;position:relative;scrollbar-width:none;background:white}'
  + '.cv-r{height:30px;box-sizing:border-box}.cv-r:nth-child(2n){background:rgb(0,255,0)}.cv-r:nth-child(2n+1){background:rgb(0,0,255)}'
  + '.cv-o{position:absolute;left:0;top:60px;width:400px;height:30px;background:rgb(255,0,255);z-index:5}'
  + '.cv-h{position:sticky;top:0;z-index:2;height:30px;background:rgb(255,0,255);color:black;box-sizing:border-box}'
  + '.cv-after .cv-d::after{content:"";position:absolute;left:0;top:60px;width:400px;height:30px;background:rgb(255,0,255);pointer-events:none;z-index:5}'
  + '.cv-grad .cv-d{background:linear-gradient(rgb(255,0,0),rgb(0,0,255))}.cv-grad .cv-l{background:transparent}.cv-grad .cv-r{background:transparent!important;border-bottom:1px solid black}';

/**
 * @param {any} t @param {{extra?: string, head?: boolean, cls?: string, seen?: string, before?: (h: HTMLElement) => void, after?: (h: HTMLElement) => void}} o
 * `before` runs before the install, `after` once the list is planned (its pages built)
 */
export async function run(t, o) {
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
  for (const el of host.querySelectorAll(o.seen ?? '.cv-h, .cv-o, .cv-r:nth-child(4)')) /** @type {HTMLElement} */ (el).dataset.seen = '1';
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

