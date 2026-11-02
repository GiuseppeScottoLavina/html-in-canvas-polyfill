// Quiet wait on the REAL install (scheduler.js afterPump, PumpResult.quietUntil): a change that the pump defers to a known time (here the node-budget interval,
// one build per 250 ms) does not keep the frame loop running until it is due; it is still painted when due. Positive control: changes that are due at once run the loop.
import { test, assert } from '/test/unit/lib/t.js';
import { inst, mk, sleep, frames } from '../api-core/_real.mjs';

/** counts the page's requestAnimationFrame calls between start() and stop() */
function rafCounter(t) {
  const original = window.requestAnimationFrame;
  let n = 0, on = false;
  window.requestAnimationFrame = function (cb) { if (on) n++; return original.call(this, cb); };
  t.cleanup(() => { window.requestAnimationFrame = original; });
  return { start() { n = 0; on = true; }, stop() { on = false; return n; } };
}

const CELLS = '<span>x</span>'.repeat(30);

test('quiet wait: a change held by the node budget for ~250 ms does not poll the frame loop meanwhile, and is painted when due', async t => {
  const raf = rafCounter(t);
  const i = inst(t, { nodeBudget: { soft: 2, hard: 5, absolute: 1000 } });
  const c = await mk(t, i, { inner: `<div id="a" drawable style="width:100px;height:50px;background:rgb(255,0,0)">${CELLS}</div>` });
  const a = /** @type {HTMLElement} */ (c.querySelector('#a'));
  let paints = 0;
  c.addEventListener('paint', () => { paints++; });
  // a first change is built (the drawable is over the hard node budget: the next build may start 250 ms after this one)
  a.firstElementChild.textContent = 'y';
  const t0 = performance.now();
  while (!paints && performance.now() - t0 < 2000) await frames(1);
  assert.ok(paints >= 1, 'the first change painted');
  await frames(2);
  // the second change waits for the interval
  const p0 = paints;
  raf.start();
  a.firstElementChild.textContent = 'z';
  await sleep(150);
  const during = raf.stop();
  assert.equal(paints, p0, 'still held by the node budget');
  assert.ok(during <= 6, `rAF requests while the change waited 150 ms: ${during} (the loop polled every frame before: about two per frame)`);
  await sleep(400);
  assert.ok(paints > p0, 'painted once due');
});

test('quiet wait (control): changes within the node budget are built at once and run the frame loop; the counter sees it', async t => {
  const raf = rafCounter(t);
  const i = inst(t);
  const c = await mk(t, i, { inner: `<div id="a" drawable style="width:100px;height:50px;background:rgb(255,0,0)">${CELLS}</div>` });
  const a = /** @type {HTMLElement} */ (c.querySelector('#a'));
  let paints = 0;
  c.addEventListener('paint', () => { paints++; });
  raf.start();
  // a change every 16 ms from timers (not rAF: the counter counts the page's calls)
  let n = 0;
  const id = setInterval(() => { a.firstElementChild.textContent = String(++n); }, 16);
  await sleep(150);
  clearInterval(id);
  const during = raf.stop();
  assert.ok(paints >= 3, `painted at once: ${paints} paints`);
  assert.ok(during >= 5, `the frame loop ran: ${during} rAF requests`);
});
