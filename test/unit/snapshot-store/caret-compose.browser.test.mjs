// The caret of a focused field inside a composed scroller (real install): a composed scroll step moves the field without a tile, so the caret patch must follow the live
// field and stay inside the scrollport; it is never painted where the field is not (store.js scrollStep / followCaret). A field scrolled out of the port has no patch at all.
import { test, assert } from '/test/unit/lib/t.js';
import { inst, sleep } from '../api-core/_real.mjs';

const MAGENTA = (d, i) => d[i] > 245 && d[i + 1] < 10 && d[i + 2] > 245 && d[i + 3] > 245;

async function page(t, caret = 'rgb(255, 0, 255)') {
  const i = inst(t);
  const host = document.createElement('div');
  host.innerHTML = '<canvas content="drawable" width="300" height="200" style="display:block;width:300px;height:200px"><div id="cd" drawable style="width:300px;height:200px;background:white;padding:20px 0 0 0;box-sizing:border-box">'
    + '<div id="cl" style="height:150px;overflow:auto;scrollbar-width:none;background:white">'
    + `<div style="height:34px;padding:5px;box-sizing:border-box"><input id="cf" value="" style="width:180px;height:24px;font:14px sans-serif;caret-color:${caret};color:rgb(23,38,56);background:white;border:1px solid rgb(120,120,120)"></div>`
    + Array.from({ length: 60 }, (_, n) => `<div style="height:34px;padding:5px;box-sizing:border-box;color:hsl(${n * 7} 60% 30%)">row ${n}</div>`).join('')
    + '</div></div></canvas>';
  document.body.append(host);
  t.cleanup(() => host.remove());
  const canvas = /** @type {HTMLCanvasElement} */ (host.querySelector('canvas'));
  const ctx = /** @type {any} */ (canvas.getContext('2d'));
  canvas.onpaint = () => { ctx.reset(); ctx.drawElementImage(host.querySelector('#cd'), 0, 0); };
  canvas.requestPaint();
  await i.whenPainted(canvas);
  const list = /** @type {HTMLElement} */ (host.querySelector('#cl'));
  const field = /** @type {HTMLInputElement} */ (host.querySelector('#cf'));
  // warm the compositor (a first scroll plans the scroller and builds its pages)
  list.scrollTop = 1;
  await sleep(800);
  field.focus({ preventScroll: true });
  await sleep(400);
  const composed = () => i.report().canvases[0].stats.snapshot.scroll.composed;
  /** magenta pixels: total and outside `inside` (canvas px) */
  const magenta = (inside) => {
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let n = 0, out = 0;
    for (let p = 0; p < d.length; p += 4) {
      if (!MAGENTA(d, p)) continue;
      n++;
      const x = (p / 4) % canvas.width, y = Math.floor(p / 4 / canvas.width);
      if (!inside || x < inside.x || y < inside.y || x >= inside.x + inside.width || y >= inside.y + inside.height) out++;
    }
    return { n, out };
  };
  /** the field's visible rect (field ∩ scrollport), canvas px; null when none of it shows */
  const visible = () => {
    const c = canvas.getBoundingClientRect(), f = field.getBoundingClientRect(), l = list.getBoundingClientRect();
    const x = Math.max(f.left, l.left), y = Math.max(f.top, l.top + list.clientTop), r = Math.min(f.right, l.left + list.clientLeft + list.clientWidth), b = Math.min(f.bottom, l.top + list.clientTop + list.clientHeight);
    return r > x && b > y ? { x: Math.floor(x - c.left), y: Math.floor(y - c.top), width: Math.ceil(r - x), height: Math.ceil(b - y) } : null;
  };
  /** one scroll step, read at the paint that follows it */
  const step = (top) => new Promise((resolve, reject) => {
    const c0 = composed();
    const timer = setTimeout(() => reject(new Error(`no paint after scrollTop=${top}`)), 3000);
    canvas.addEventListener('paint', () => { clearTimeout(timer); setTimeout(() => resolve({ composed: composed() - c0, px: magenta(visible()), visible: visible() }), 0); }, { once: true });
    list.scrollTop = top;
  });
  /** wait for a blink-on phase (the caret is on the canvas) */
  const caretOn = async () => { for (let k = 0; k < 60; k++) { if (magenta(null).n) return true; await sleep(25); } return false; };
  return { i, canvas, list, field, step, caretOn, magenta, visible };
}

test('a composed scroll step never leaves the caret where the field was: the patch follows the live field inside the port', async (t) => {
  const p = await page(t);
  assert.ok(await p.caretOn(), 'the focused field shows its caret');
  const before = p.magenta(p.visible());
  assert.equal(before.out, 0, 'at rest the caret lies inside the field');
  // a small step: the field is still in the port, 12 css px higher
  const a = await p.step(13);
  assert.ok(a.composed > 0, `the step was composed (${JSON.stringify(a)})`);
  assert.equal(a.px.out, 0, `no caret pixel outside the field's current rect after a composed step (${JSON.stringify(a)})`);
  // the caret moved with the field: it is drawn, at the new place (the blink phase may have turned in between; re-sample on the next on phase)
  if (!a.px.n) assert.ok(await p.caretOn(), 'the caret shows again at the moved field');
  assert.equal(p.magenta(p.visible()).out, 0, 'and only inside the field');
});

test('a composed step that moves the field out of the port paints no caret (and none comes back on later blinks of the gesture)', async (t) => {
  const p = await p0(t);
  assert.ok(await p.caretOn(), 'the focused field shows its caret');
  const a = await p.step(100);
  assert.ok(a.composed > 0, `the step was composed (${JSON.stringify(a)})`);
  assert.equal(a.visible, null, 'the field is out of the port');
  assert.equal(a.px.n, 0, `no caret pixel anywhere (${JSON.stringify(a)})`);
  for (let top = 107; top <= 170; top += 7) {
    const s = await p.step(top);
    assert.equal(s.px.n, 0, `composed step at ${top}: no caret pixel (${JSON.stringify(s)})`);
  }
  await sleep(700);
  assert.equal(p.magenta(null).n, 0, 'none after the gesture either');
  // back into view: the caret is shown again inside the field
  await p.step(0);
  await sleep(600);
  assert.ok(await p.caretOn(), 'the caret is back once the field is in view');
  assert.equal(p.magenta(p.visible()).out, 0);
});

/** @param {any} t */
const p0 = (t) => page(t);

test('caret-color: transparent paints no patch', async (t) => {
  const p = await page(t, 'transparent');
  const draws = { n: 0 };
  for (const proto of [CanvasRenderingContext2D.prototype, globalThis.OffscreenCanvasRenderingContext2D?.prototype].filter(Boolean)) {
    const fill = proto.fillRect;
    proto.fillRect = function (x, y, w, h) { if (w * h <= 400) draws.n++; return fill.call(this, x, y, w, h); };
    t.cleanup(() => { proto.fillRect = fill; });
  }
  await sleep(1200);
  assert.equal(draws.n, 0, `no caret-sized fillRect over more than one blink period (${draws.n})`);
  // positive control: the same field with a visible caret colour paints the patch
  p.field.style.caretColor = 'rgb(255, 0, 255)';
  p.field.blur();
  await sleep(200);
  p.field.focus({ preventScroll: true });
  await sleep(1200);
  assert.ok(draws.n > 0, 'a visible caret colour does paint it (control)');
});

test('a field beside the composed scroller (above the list, in the same drawable): its caret is neither put back nor read again at each composed step, and stays drawn inside the field', async (t) => {
  const i = inst(t);
  const host = document.createElement('div');
  host.innerHTML = '<canvas content="drawable" width="300" height="220" style="display:block;width:300px;height:220px"><div id="od" drawable style="width:300px;height:220px;background:white">'
    + '<div style="height:34px;padding:5px;box-sizing:border-box"><input id="of" value="" style="width:180px;height:24px;font:14px sans-serif;caret-color:rgb(255,0,255);color:rgb(23,38,56);background:white;border:1px solid rgb(120,120,120)"></div>'
    + '<div id="ol" style="height:170px;overflow:auto;scrollbar-width:none;background:white">'
    + Array.from({ length: 60 }, (_, n) => `<div style="height:34px;padding:5px;box-sizing:border-box;color:hsl(${n * 7} 60% 30%)">row ${n}</div>`).join('')
    + '</div></div></canvas>';
  document.body.append(host);
  t.cleanup(() => host.remove());
  const canvas = /** @type {HTMLCanvasElement} */ (host.querySelector('canvas'));
  const ctx = /** @type {any} */ (canvas.getContext('2d'));
  canvas.onpaint = () => { ctx.reset(); ctx.drawElementImage(host.querySelector('#od'), 0, 0); };
  canvas.requestPaint();
  await i.whenPainted(canvas);
  const list = /** @type {HTMLElement} */ (host.querySelector('#ol'));
  const field = /** @type {HTMLInputElement} */ (host.querySelector('#of'));
  list.scrollTop = 1;
  await sleep(800);
  field.focus({ preventScroll: true });
  await sleep(400);
  const composed = () => i.report().canvases[0].stats.snapshot.scroll.composed;
  const fieldPx = () => { const c = canvas.getBoundingClientRect(), f = field.getBoundingClientRect(); return { x: f.left - c.left, y: f.top - c.top, r: f.right - c.left, b: f.bottom - c.top }; };
  const magenta = () => {
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data, f = fieldPx();
    let n = 0, out = 0;
    for (let p = 0; p < d.length; p += 4) {
      if (!MAGENTA(d, p)) continue;
      n++;
      const x = (p / 4) % canvas.width, y = Math.floor(p / 4 / canvas.width);
      if (x < f.x || y < f.y || x >= f.r || y >= f.b) out++;
    }
    return { n, out };
  };
  for (let k = 0; k < 60 && !magenta().n; k++) await sleep(25);
  assert.ok(magenta().n > 0, 'the focused field shows its caret');
  // reads of a large canvas into a caret-sized one (the patch saving the pixels under the caret) and writes of a caret-sized canvas into a large one (putting them back)
  const io = { read: 0, back: 0 };
  const draw = CanvasRenderingContext2D.prototype.drawImage, odraw = globalThis.OffscreenCanvasRenderingContext2D?.prototype.drawImage;
  const count = function (/** @type {any} */ src) { const big = (/** @type {any} */ c) => c && c.width >= 200; if (big(src) && !big(this.canvas)) io.read++; if (!big(src) && src?.width <= 40 && big(this.canvas)) io.back++; };
  CanvasRenderingContext2D.prototype.drawImage = function (...a) { count.call(this, a[0]); return draw.apply(this, a); };
  if (odraw) globalThis.OffscreenCanvasRenderingContext2D.prototype.drawImage = function (...a) { count.call(this, a[0]); return odraw.apply(this, a); };
  t.cleanup(() => { CanvasRenderingContext2D.prototype.drawImage = draw; if (odraw) globalThis.OffscreenCanvasRenderingContext2D.prototype.drawImage = odraw; });
  const c0 = composed();
  const ghosts = [];
  for (let top = 8; top <= 120; top += 8) {
    await new Promise((resolve) => { canvas.addEventListener('paint', () => setTimeout(resolve, 0), { once: true }); list.scrollTop = top; });
    const m = magenta();
    if (m.out) ghosts.push(`${top}: ${m.out}`);
  }
  const steps = composed() - c0;
  CanvasRenderingContext2D.prototype.drawImage = draw;
  if (odraw) globalThis.OffscreenCanvasRenderingContext2D.prototype.drawImage = odraw;
  assert.ok(steps >= 10, `the steps were composed (${steps})`);
  assert.equal(ghosts.length, 0, `no caret pixel outside the field (${ghosts.join(', ')})`);
  // blinks during the gesture (about 2 a second) save and put back the pixels; the steps themselves do neither
  assert.ok(io.read + io.back <= 4, `patch reads ${io.read} and writes back ${io.back} over ${steps} composed steps`);
});
