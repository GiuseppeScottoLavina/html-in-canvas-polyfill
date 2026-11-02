// options.maxTotalSurfaceBytes with the REAL install: a drawable whose build the budget refused is built again once memory is freed (an ElementImage closed, another
// drawable removed), keeps its last picture until then, and does not keep the scheduler ticking while nothing can progress.
import { test, assert } from '/test/unit/lib/t.js';
import { inst, sleep } from './_real.mjs';

const RED = [255, 0, 0, 255], LIME = [0, 255, 0, 255], BLUE = [0, 0, 255, 255];
/** a 100x100 drawable at scale 1 without ink margin: 40,000 bytes */
const OPTIONS = { inkMargin: 0, maxDpr: 1, maxSnapshotFps: 0 };

/** @param {any} t @param {any} i @param {string[]} ids @returns {{c: HTMLCanvasElement, els: HTMLElement[], at: (y?: number) => number[]}} */
function mount(t, i, ids) {
  const host = document.createElement('div');
  host.innerHTML = `<canvas content="drawable" width="100" height="${100 * ids.length}" style="width:100px;height:${100 * ids.length}px;display:block">${ids.map((id) => `<div id="${id}" drawable style="width:100px;height:100px;background:rgb(255,0,0)"></div>`).join('')}</canvas>`;
  document.body.append(host);
  t.cleanup(() => host.remove());
  const c = /** @type {HTMLCanvasElement} */ (host.firstElementChild);
  const els = /** @type {HTMLElement[]} */ ([...c.children]);
  const ctx = /** @type {any} */ (c.getContext('2d'));
  c.addEventListener('paint', () => {
    ctx.reset();
    els.forEach((el, n) => { try { if (el.isConnected) ctx.drawElementImage(el, 0, 100 * n); } catch { /* no snapshot (refused) */ } });
  });
  return { c, els, at: (y = 50) => [...ctx.getImageData(50, y, 1, 1).data] };
}

/** @param {() => boolean} fn @param {number} ms @returns {Promise<boolean>} */
async function within(fn, ms) {
  const t0 = performance.now();
  while (!fn()) { if (performance.now() - t0 > ms) return false; await sleep(16); }
  return true;
}

const stats = (/** @type {any} */ i) => i.report().canvases[0].stats;

/** @param {any} t @param {number} [budget] */
async function pinnedChange(t, budget) {
  const i = inst(t, { ...OPTIONS, ...(budget ? { maxTotalSurfaceBytes: budget } : {}) });
  const { c, els: [d], at } = mount(t, i, ['d']);
  c.requestPaint();
  await i.whenPainted(c);
  assert.ok(await within(() => at()[0] === 255, 2000), 'first paint');
  const image = c.captureElementImage(d);
  d.style.backgroundColor = 'rgb(0,255,0)';
  await sleep(300);
  return { i, c, d, at, image };
}

/** scheduler frames over `ms` @param {any} i @param {number} ms */
async function framesOver(i, ms) {
  const f0 = stats(i).scheduler.frames;
  await sleep(ms);
  return stats(i).scheduler.frames - f0;
}

test('a build refused beside an ElementImage is built when the image is closed; the scheduler stops while it is refused; later changes are built; the limit holds', async (t) => {
  const { i, d, at, image } = await pinnedChange(t, 40000);
  assert.deepEqual(at(), RED, 'refused: the drawable keeps its last picture');
  const idle = await framesOver(i, 300);
  image.close();
  assert.ok(await within(() => at()[1] === 255, 2000), `the change made while refused is shown once the image is closed (shows ${at()})`);
  d.style.backgroundColor = 'rgb(0,0,255)';
  assert.ok(await within(() => at()[2] === 255, 2000), 'a later change is built');
  assert.deepEqual(at(), BLUE);
  assert.ok(stats(i).snapshot.surfaceBytes <= 40000, `surfaceBytes ${stats(i).snapshot.surfaceBytes}`);
  assert.ok(idle <= 2, `no frames while the refusal blocked every build (${idle} in 300 ms)`);
});

test('control: with an ample budget the change is shown at once, and the scheduler stops once it is settled', async (t) => {
  const { i, at, image } = await pinnedChange(t, 0);
  assert.deepEqual(at(), LIME);
  const idle = await framesOver(i, 300);
  assert.ok(idle <= 2, `an idle canvas does not tick (${idle} frames in 300 ms)`);
  image.close();
});

test('removing the drawable that holds the budget lets the refused one be built', async (t) => {
  const i = inst(t, { ...OPTIONS, maxTotalSurfaceBytes: 40000 });
  const { c, els, at } = mount(t, i, ['a', 'b']);
  c.requestPaint();
  await sleep(300);
  assert.equal(stats(i).snapshot.surfaces, 1, 'only one of the two drawables fits');
  const shown = at(50)[0] === 255 ? 0 : 1;
  assert.deepEqual(at(50 + 100 * shown), RED, 'one drawable is shown');
  assert.equal(at(150 - 100 * shown)[3], 0, 'the other was refused (nothing drawn)');
  const idle = await framesOver(i, 300);
  els[1 - shown].style.backgroundColor = 'rgb(0,0,255)';
  els[shown].remove();
  const y = 150 - 100 * shown;
  assert.ok(await within(() => at(y)[2] === 255, 2000), `the refused drawable is built once the other one is removed (shows ${at(y)})`);
  assert.ok(stats(i).snapshot.surfaceBytes <= 40000);
  assert.ok(idle <= 2, `no frames while the refusal blocked every build (${idle} in 300 ms)`);
});
