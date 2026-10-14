import { test, assert, frames, sleep, microtasks } from '/test/unit/lib/t.js';
import { createRig } from './_dom.js';
import { createFakeStore } from './_fakes.mjs';
import { createScheduler } from '/src/schedule/scheduler.js';
import { createFramePhase } from '/src/schedule/frame-phase.js';
import { startObservers } from '/src/schedule/observers/index.js';
import { createInteractionTracker } from '/src/schedule/observers/interaction-tracker.js';
import { createPatchLedger } from '/src/api/patch.js';
import { BUS } from '/src/contracts/events.js';

/** rig + the real scheduler over a fake store; firePaint dispatches a `paint` event on the canvas like api/ does */
function setup(t, rigOptions) {
  const rig = createRig({ html: '<div drawable id="d">x</div>', ...rigOptions });
  const store = createFakeStore(rig.bus);
  const hooks = { firePaint: (record, changed) => record.canvas.dispatchEvent(Object.assign(new Event('paint'), { changedElements: changed })) };
  const scheduler = createScheduler(rig.env, store, hooks);
  rig.env.scheduler = scheduler;
  rig.env.store = store;
  t.cleanup(() => scheduler.dispose());
  return { ...rig, store, scheduler, hooks };
}

/** Reads the canvas in a task that runs after the current rendering update (the O-order oracle of the test plan). */
const afterFrame = (canvas) => new Promise(ok => { const ch = new MessageChannel(); ch.port1.onmessage = () => ok(pixel(canvas)); ch.port2.postMessage(0); });
const pixel = (canvas) => Array.from(canvas.getContext('2d').getImageData(10, 10, 1, 1).data);
const isGreen = ([r, g, b, a]) => a === 255 && g > 200 && r < 50 && b < 50;
const isRed = ([r, g, b, a]) => a === 255 && r > 200 && g < 50 && b < 50;

test('G-raf-order: the polyfill tick runs at the frame end - app rAF red, then paint green ends green every frame; no phase fallbacks', async t => {
  const s = setup(t);
  const ctx = s.canvas.getContext('2d');
  s.canvas.addEventListener('paint', () => { ctx.fillStyle = '#0f0'; ctx.fillRect(0, 0, 200, 100); s.scheduler.requestPaint(s.record); });
  s.scheduler.register(s.record);
  const ends = [];
  await new Promise(done => {
    let n = 0;
    const app = () => {
      ctx.fillStyle = '#f00';
      ctx.fillRect(0, 0, 200, 100);
      afterFrame(s.canvas).then(p => ends.push(p));
      if (++n < 40) requestAnimationFrame(app); else done();
    };
    requestAnimationFrame(app);
  });
  await frames(3);
  const checked = ends.slice(4);
  assert.ok(checked.length >= 30 && checked.every(isGreen), `every frame ends green: ${JSON.stringify(checked.filter(p => !isGreen(p)).slice(0, 3))}`);
  const stats = s.scheduler.stats();
  assert.ok(stats.phaseFallbacks <= Math.max(1, Math.floor(stats.frames * 0.01)), JSON.stringify(stats));
});

test('G-raf-order positive control: a "paint" that runs in the rAF phase before the app loop is overpainted - the same oracle reads red', async t => {
  const rig = createRig({ html: '<div drawable id="d">x</div>' });
  const ctx = rig.canvas.getContext('2d');
  const ends = [];
  await new Promise(done => {
    let n = 0;
    const early = () => { ctx.fillStyle = '#0f0'; ctx.fillRect(0, 0, 200, 100); };
    const app = () => {
      ctx.fillStyle = '#f00';
      ctx.fillRect(0, 0, 200, 100);
      afterFrame(rig.canvas).then(p => ends.push(p));
      if (++n < 10) { requestAnimationFrame(early); requestAnimationFrame(app); } else done();
    };
    requestAnimationFrame(early);
    requestAnimationFrame(app);
  });
  await frames(2);
  assert.ok(ends.slice(2).every(isRed));
});

test('the tick runs after app rAF, an app ResizeObserver and the microtask it queued; handler is dispatched in the SAME frame as the armed rAF', async t => {
  const s = setup(t);
  const order = [];
  s.canvas.addEventListener('paint', () => order.push('paint'));
  s.scheduler.register(s.record);
  await frames(3);
  order.length = 0;
  const target = document.createElement('div');
  target.style.cssText = 'width:10px;height:10px';
  s.root.append(target);
  const ro = new ResizeObserver(() => { order.push('app-ro'); queueMicrotask(() => order.push('app-ro-microtask')); });
  t.cleanup(() => ro.disconnect());
  requestAnimationFrame(() => {
    order.push('app-raf');
    ro.observe(target);
    s.scheduler.requestPaint(s.record);
  });
  await frames(4);
  assert.deepEqual(order.slice(0, 4), ['app-raf', 'app-ro', 'app-ro-microtask', 'paint']);
});

test('G-resize-ro: the README ResizeObserver example paints in the same frame as the callback - 0 blank frames; control without paintNow blanks', async t => {
  /** @param {boolean} usePaintNow */
  const run = async (usePaintNow) => {
    const s = setup(t);
    const ctx = s.canvas.getContext('2d');
    s.canvas.addEventListener('paint', () => { ctx.fillStyle = '#0f0'; ctx.fillRect(0, 0, s.canvas.width, s.canvas.height); });
    s.scheduler.register(s.record);
    await frames(8);
    assert.ok(isGreen(pixel(s.canvas)), 'first paint done');
    const ro = new ResizeObserver(() => {
      s.canvas.width = Math.round(s.canvas.getBoundingClientRect().width);   // the write clears the bitmap natively
      if (usePaintNow) queueMicrotask(() => s.scheduler.paintNow(s.record)); else s.scheduler.requestPaint(s.record);
    });
    ro.observe(s.canvas);
    await frames(2);
    let blank = 0;
    for (let i = 0; i < 12; i++) {
      s.canvas.style.width = `${210 + i * 7}px`;
      await new Promise(ok => requestAnimationFrame(ok));
      // the next frame's first rAF callback sees what the frame with the resize presented
      if (!isGreen(pixel(s.canvas))) blank++;
    }
    ro.disconnect();
    return blank;
  };
  assert.equal(await run(true), 0, 'paintNow redraws inside the same frame');
  assert.ok(await run(false) >= 6, 'positive control: requestPaint alone presents a cleared bitmap');
});

test('G-idle: zero polyfill rAF and zero ResizeObserver creations while idle; the sentinel is out of the DOM', async t => {
  const rafOriginal = window.requestAnimationFrame;
  const RO = window.ResizeObserver;
  const counts = { raf: 0, ro: 0 };
  window.requestAnimationFrame = function (...a) { counts.raf++; return rafOriginal.apply(this, a); };
  window.ResizeObserver = class extends RO { constructor(cb) { counts.ro++; super(cb); } };
  t.cleanup(() => { window.requestAnimationFrame = rafOriginal; window.ResizeObserver = RO; });
  const s = setup(t);
  s.scheduler.register(s.record);
  await sleep(300);
  assert.ok(s.scheduler.stats().paintsFired >= 1);
  const before = { ...counts };
  await sleep(600);
  assert.deepEqual(counts, before);
  assert.equal(document.querySelectorAll('[data-hic-node]').length, 0, 'sentinel removed');
  s.scheduler.requestPaint(s.record);
  await sleep(200);
  assert.ok(counts.raf > before.raf, 'positive control: work does use rAF');
  const settled = { ...counts };
  await sleep(300);
  assert.deepEqual(counts, settled);
});

test('G-fps-cap on the real display: N in 10, 15, 30 within 0.9N..1.1N, runtime change effective, uncapped control exceeds 1.3 x 30', async t => {
  for (const n of [10, 15, 30]) {
    const s = setup(t);
    let paints = 0;
    s.canvas.addEventListener('paint', () => { paints++; s.scheduler.requestPaint(s.record); });
    s.scheduler.register(s.record);
    s.scheduler.setFrameCap(s.record, n);
    await sleep(200);
    paints = 0;
    await sleep(2000);
    assert.ok(paints / 2 >= 0.9 * n && paints / 2 <= 1.1 * n, `cap ${n}: ${paints / 2}/s`);
    s.scheduler.dispose();
  }
  const s = setup(t);
  let paints = 0;
  s.canvas.addEventListener('paint', () => { paints++; s.scheduler.requestPaint(s.record); });
  s.scheduler.register(s.record);
  await sleep(200);
  paints = 0;
  await sleep(1000);
  assert.ok(paints > 1.3 * 30, `uncapped: ${paints}/s`);
  s.scheduler.setFrameCap(s.record, 10);
  await frames(3);
  paints = 0;
  await sleep(1000);
  assert.ok(paints >= 9 && paints <= 11, `runtime change to 10: ${paints}`);
}, { timeout: 15000 });

test('hidden-visible: becoming visible repaints (full damage + force) even when the page was idle', async t => {
  const s = setup(t);
  let paints = 0;
  s.canvas.addEventListener('paint', () => paints++);
  s.scheduler.register(s.record);
  await sleep(200);
  const base = paints;
  s.store.calls.length = 0;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  t.cleanup(() => { delete document.hidden; });
  document.dispatchEvent(new Event('visibilitychange'));
  await sleep(200);
  assert.equal(paints, base + 1);
  assert.ok(s.store.calls.some(c => c[0] === 'markDamage' && c[3] === 'forced'));
});

test('startObservers: starts on CANVAS_MOUNTED, stops on CANVAS_UNMOUNTING and on dispose; damage reaches the real scheduler and the store', async t => {
  const s = setup(t, { canvasAttrs: 'framecap="20"' });
  const tracker = createInteractionTracker(s.env);
  const ledger = createPatchLedger(window);
  const stop = startObservers(s.env, tracker, ledger);
  t.cleanup(() => { stop(); ledger.restoreAll(); });
  s.scheduler.register(s.record);
  assert.equal(s.record.frameCap, 20, 'register reads the attribute');
  s.bus.emit(BUS.CANVAS_MOUNTED, { record: s.record });
  await sleep(100);
  s.store.calls.length = 0;
  s.layerEl.querySelector('#d').append(document.createElement('b'));
  await microtasks();
  assert.ok(s.store.calls.some(c => c[0] === 'markDamage' && c[3] === 'mutation'));
  s.canvas.setAttribute('framecap', '45');
  await microtasks();
  assert.equal(s.record.frameCap, 45);
  for (let last = -1; s.scheduler.stats().frames !== last;) { last = s.scheduler.stats().frames; await sleep(50); } // settled: no frame for 50 ms
  s.bus.emit(BUS.CANVAS_UNMOUNTING, { record: s.record });
  s.store.calls.length = 0;
  s.canvas.setAttribute('framecap', '12');
  s.layerEl.querySelector('#d').append(document.createElement('b'));
  await sleep(50);
  assert.equal(s.record.frameCap, 45, 'observers stopped');
  assert.equal(s.store.calls.filter(c => c[0] === 'markDamage').length, 0);
});

test('listener audit: the whole schedule module never registers wheel, mousewheel or touch listeners (CDP audit gate, spied here)', async t => {
  const seen = [];
  const original = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, ...rest) { seen.push(type); return original.call(this, type, ...rest); };
  t.cleanup(() => { EventTarget.prototype.addEventListener = original; });
  const s = setup(t);
  const tracker = createInteractionTracker(s.env);
  const ledger = createPatchLedger(window);
  const stop = startObservers(s.env, tracker, ledger);
  t.cleanup(() => { stop(); ledger.restoreAll(); });
  s.scheduler.register(s.record);
  s.bus.emit(BUS.CANVAS_MOUNTED, { record: s.record });
  await sleep(100);
  for (const type of ['scroll', 'input', 'pointerover', 'focusin', 'animationstart', 'visibilitychange']) assert.ok(seen.includes(type), `positive control: spy saw ${type}`);
  assert.deepEqual(seen.filter(type => /^(wheel|mousewheel|touchstart|touchmove|touchend|touchcancel|pointermove)$/.test(type)), []);
});

test('frame phase in a real page: 60 consecutive frames run in their own frame, no fallback, nothing left behind', async t => {
  const rig = createRig({});
  let ran = 0;
  let phase;
  const frameOf = [];
  phase = createFramePhase(rig.env, () => { ran++; frameOf.push(performance.now()); if (ran < 60) phase.arm(); });
  phase.arm();
  await new Promise(ok => { const poll = () => (ran >= 60 ? ok() : requestAnimationFrame(poll)); poll(); });
  await frames(2);
  assert.deepEqual(phase.stats(), { armed: 60, ran: 60, fallbacks: 0 });
  assert.equal(document.querySelectorAll('[data-hic-node]').length, 0);
});
