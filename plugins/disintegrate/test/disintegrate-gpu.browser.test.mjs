// Disintegrate through the REAL effects host on a real WebGPU canvas: the assembled frame against the host's own passthrough (bit for bit),
// mid-transition frames, input blocking through the interposer, frame-cap independence, the reduced-motion crossfade, device loss and the
// submit wiring. Run: node test/unit/run.mjs plugins/disintegrate/test/disintegrate-gpu.browser.test.mjs
import { assert, sleep } from '/test/unit/lib/t.js';
import { gpuAvailable, gpuTest } from '/plugins/_shared/gpu-check.mjs';
import { makeRig, nonDominantShare } from '/test/unit/gpu-effects/lib/rig.mjs';
import { createEffectHost } from '/src/effects/effect-host.js';
import { definePlugin } from '/src/effects/plugin-abi.js';
import { plugin, trigger } from '/plugins/disintegrate/index.js';
import { isNoTarget } from '/src/effects/no-target.js';

console.error(`disintegrate-gpu tests: WebGPU ${(await gpuAvailable()) ? 'available' : 'NOT available'}`);

const W = 480, H = 320, DURATION = 1000;
const CONTROLS = `<form id="f" novalidate style="position:absolute;inset:0;margin:0">
  <button id="btn" type="button" style="position:absolute;left:40px;top:40px;width:120px;height:40px;margin:0">Go</button>
  <input id="txt" type="text" value="hello" style="position:absolute;left:40px;top:120px;width:200px;height:28px;margin:0;box-sizing:border-box">
  <input id="mail" type="email" value="ada@example.com" style="position:absolute;left:40px;top:180px;width:200px;height:28px;margin:0;box-sizing:border-box">
  <button id="send" type="submit" style="position:absolute;left:280px;top:180px;width:90px;height:28px;margin:0">Send</button></form>`;

/** A form-like picture: gradient, panels, text, so moved particles always change pixels. @param {CanvasRenderingContext2D} ctx */
function paint(ctx) {
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#16324f'); grad.addColorStop(1, '#3b1d5a');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#e8f6ff'; ctx.fillRect(40, 40, 120, 40); ctx.fillRect(40, 120, 200, 28); ctx.fillRect(40, 180, 200, 28);
  ctx.fillStyle = '#ffb06b'; ctx.fillRect(280, 180, 90, 28);
  ctx.fillStyle = '#0b1622'; ctx.font = '16px sans-serif'; ctx.fillText('Go', 85, 66); ctx.fillText('hello', 48, 140);
  ctx.fillStyle = '#ffffff'; ctx.font = 'bold 30px sans-serif'; ctx.fillText('Touch the interface.', 40, 290);
}

/** The definition, wrapped so the test sees every mapper and device, with the getters of the instance (continuous) kept live. */
function wrap() {
  /** @type {Function[]} */ const mappers = [];
  /** @type {any[]} */ const devices = [];
  const def = definePlugin({
    ...plugin,
    async create(/** @type {any} */ ctx, /** @type {any} */ options) {
      devices.push(ctx.device);
      const inst = await plugin.create(ctx, options);
      return new Proxy(inst, {
        get(target, key) {
          if (key !== 'captureInputMapper') return Reflect.get(target, key);
          return (/** @type {any} */ frame) => { const m = /** @type {any} */ (target).captureInputMapper(frame); mappers.push(m); return m; };
        },
      });
    },
  });
  return { def, mappers, devices };
}

/** @param {any} t @param {{interposer?: boolean, html?: string}} [o] */
async function rigHost(t, { interposer = false, html = '' } = {}) {
  const rig = makeRig({ w: W, h: H, paint, html });
  rig.commit();
  const host = await createEffectHost(rig.env, rig.deps, rig.canvas, rig.source, { interposer });
  t.cleanup(() => host.destroy());
  return { rig, host };
}

/** What the host presents for this source with no plugin at all. @param {any} t */
async function reference(t) {
  const { rig, host } = await rigHost(t);
  rig.tick(performance.now());
  const img = rig.snap();
  host.destroy();
  rig.root.remove();
  return img;
}

/** @param {any} t @param {Record<string, unknown>} options @param {{interposer?: boolean, html?: string}} [o] */
async function start(t, options, o) {
  const { rig, host } = await rigHost(t, o);
  const spy = wrap();
  const handle = await host.addPlugin(spy.def, { duration: DURATION, ...options });
  return { rig, host, handle, ...spy };
}

/** @param {ImageData} a @param {ImageData} b */
function diff(a, b) {
  let over = 0, max = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
    if (d > 16) over += 1;
    if (d > max) max = d;
  }
  return { over, max };
}

gpuTest('idle: the presented frame equals the host passthrough bit for bit, and the mapper is the identity', async (t) => {
  const ref = await reference(t);
  const { rig, mappers } = await start(t, { intro: false });
  rig.tick(performance.now());
  const d = diff(rig.snap(), ref);
  assert.equal(d.max, 0, `idle frame differs from the passthrough by up to ${d.max} levels`);
  const m = /** @type {any} */ (mappers.at(-1));
  assert.deepEqual(m({ x: 120, y: 60, width: W, height: H }), { x: 120, y: 60 });
});

gpuTest('play: mid-transition frames are non-blank, differ from each other and from the source; the end frame has no residual offset', async (t) => {
  const ref = await reference(t);
  const { rig, mappers } = await start(t, { intro: false });
  const t0 = performance.now();
  rig.tick(t0);
  const done = trigger(rig.canvas, 'play');
  rig.tick(t0 + 10);                                  // the clock of the transition starts here
  const shots = [];
  // the front crosses the canvas in the first half (FRONT_END); by 0.7 only embers are left
  for (const at of [0.15, 0.3, 0.45]) { rig.tick(t0 + 10 + DURATION * at); shots.push(rig.snap()); }
  const midMapper = /** @type {any} */ (mappers.at(-1));
  for (const img of shots) assert.ok(nonDominantShare(img) > 0.05, `mid frame non-blank (${nonDominantShare(img).toFixed(3)})`);
  const d01 = diff(shots[0], shots[1]), d0r = diff(shots[0], ref), d12 = diff(shots[1], shots[2]);
  console.error(`disintegrate mid frames: 15%->30% ${d01.over} px, 15% vs source ${d0r.over} px, 30%->45% ${d12.over} px`);
  assert.ok(d01.over > 2000 && d12.over > 2000 && d0r.over > 2000, 'frames move');
  assert.ok(isNoTarget(midMapper({ x: 120, y: 60, width: W, height: H })), 'input blocked mid-transition (NO_TARGET)');
  // out (1000 ms) + hold (250 ms) + in (1000 ms); step at 120 Hz to the end
  for (let now = t0 + 10 + 700; now <= t0 + 10 + 2400; now += 8.33) rig.tick(now);
  rig.tick(t0 + 2500);
  assert.equal(await done, true, 'the play promise resolves true');
  const end = diff(rig.snap(), ref);
  assert.equal(end.max, 0, `reassembled frame differs from the source by up to ${end.max} levels`);
  assert.deepEqual(/** @type {any} */ (mappers.at(-1))({ x: 120, y: 60, width: W, height: H }), { x: 120, y: 60 }, 'identity again');
});

gpuTest('frame-cap independence: the frame at 400 ms is the same at 120 Hz and at a 15 fps cap', async (t) => {
  const run = async (/** @type {number} */ every) => {
    const { rig, host } = await start(t, { intro: false });
    const t0 = performance.now();
    rig.tick(t0);
    trigger(rig.canvas, 'out');
    for (let k = 0; k <= 48; k += 1) rig.tick(t0 + 10 + k * 8.33, k % every === 0 || k === 48);
    const img = rig.snap();
    host.destroy();
    rig.root.remove();
    return img;
  };
  const fast = await run(1), capped = await run(8);
  const d = diff(fast, capped);
  assert.ok(d.max <= 1, `the same instant differs by ${d.max} levels between 120 Hz and 15 fps`);
});

gpuTest('input: a click on a control is swallowed mid-transition and reaches it when idle (positive control)', async (t) => {
  const { rig } = await start(t, { intro: false }, { interposer: true, html: CONTROLS });
  const btn = /** @type {HTMLButtonElement} */ (rig.layerEl.querySelector('#btn'));
  const txt = /** @type {HTMLInputElement} */ (rig.layerEl.querySelector('#txt'));
  let clicks = 0;
  btn.addEventListener('click', () => { clicks += 1; });
  const press = () => {
    const r = rig.canvas.getBoundingClientRect();
    const cx = r.left + 100, cy = r.top + 60;
    const target = /** @type {Element} */ (document.elementFromPoint(cx, cy));
    const init = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, pointerId: 1, isPrimary: true, button: 0 };
    target.dispatchEvent(new PointerEvent('pointerdown', init));
    target.dispatchEvent(new PointerEvent('pointerup', init));
    target.dispatchEvent(new MouseEvent('click', { ...init, detail: 1 }));
  };
  const t0 = performance.now();
  rig.tick(t0);
  press();
  assert.equal(clicks, 1, 'idle: the click reaches the button');
  txt.focus();
  trigger(rig.canvas, 'play');
  rig.tick(t0 + 10);
  rig.tick(t0 + 10 + DURATION * 0.4);
  press();
  assert.equal(clicks, 1, 'mid-transition: no click reached the button');
  assert.equal(document.activeElement, txt, 'NO_TARGET: the host swallowed the press, so the focused field keeps the focus (keyboard input still reaches it)');
});

gpuTest('prefers-reduced-motion: a crossfade, no pixel moves (each pixel is the source mixed with the backdrop)', async (t) => {
  const ref = await reference(t);
  const { rig } = await start(t, { intro: false, reducedMotion: true });
  const t0 = performance.now();
  rig.tick(t0);
  trigger(rig.canvas, 'out');
  rig.tick(t0 + 10);
  rig.tick(t0 + 10 + DURATION * 0.5);
  const img = rig.snap();
  const back = [0.004, 0.018, 0.034].map((v) => v * 255);
  let worst = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    for (let c = 0; c < 3; c += 1) worst = Math.max(worst, Math.abs(img.data[i + c] - (ref.data[i + c] * 0.5 + back[c] * 0.5)));
  }
  assert.ok(worst <= 2, `crossfade at 50%: worst channel error ${worst.toFixed(1)} levels`);
  assert.ok(diff(img, ref).over > 1000, 'and it is not the source (positive control)');
});

gpuTest('device loss mid-transition: the plugin comes back assembled (no intro), with the identity mapper; the pending promise resolves false', async (t) => {
  const ref = await reference(t);
  const { rig, devices, mappers } = await start(t, { intro: true });
  const t0 = performance.now();
  for (let now = t0; now <= t0 + DURATION + 100; now += 50) rig.tick(now);   // the intro, to its end
  const pending = trigger(rig.canvas, 'out');
  rig.tick(t0 + DURATION + 150);
  rig.tick(t0 + DURATION + 450);
  devices[0].destroy();
  for (let i = 0; i < 200 && devices.length < 2; i += 1) await sleep(10);
  assert.equal(devices.length, 2, 'created again on a new device');
  assert.equal(await pending, false);
  rig.tick(performance.now());
  assert.equal(diff(rig.snap(), ref).max, 0, 'assembled frame right after the recovery');
  assert.deepEqual(/** @type {any} */ (mappers.at(-1))({ x: 5, y: 6, width: W, height: H }), { x: 5, y: 6 });
});

gpuTest('intro and submit wiring: the intro reassembles from dust; a valid submit plays, an invalid one does not', async (t) => {
  const ref = await reference(t);
  const { rig, host } = await start(t, { intro: true, onSubmit: 'valid' }, { html: CONTROLS });
  const t0 = performance.now();
  rig.tick(t0);
  assert.ok(nonDominantShare(rig.snap()) < 0.01, 'the intro starts fully dissolved (only the backdrop)');
  for (let now = t0 + 50; now <= t0 + DURATION + 100; now += 50) rig.tick(now);
  assert.equal(diff(rig.snap(), ref).max, 0, 'the intro ends on the source');
  const form = /** @type {HTMLFormElement} */ (rig.layerEl.querySelector('#f'));
  const mail = /** @type {HTMLInputElement} */ (rig.layerEl.querySelector('#mail'));
  form.addEventListener('submit', (e) => e.preventDefault());   // the page's own handler (a real submit would navigate the test page)
  mail.value = 'nope';
  form.requestSubmit();
  rig.tick(t0 + DURATION + 200);
  rig.tick(t0 + DURATION + 500);
  assert.equal(diff(rig.snap(), ref).max, 0, 'invalid email: no transition');
  assert.equal(host.stats().frames > 0, true);
  mail.value = 'ada@example.com';
  form.requestSubmit();
  rig.tick(t0 + DURATION + 600);
  rig.tick(t0 + DURATION + 600 + DURATION * 0.5);
  assert.ok(diff(rig.snap(), ref).over > 2000, 'valid submit: the form dissolves');
});

/** Pixels over 16 levels apart inside a square of half-size r around (x, y). @param {ImageData} a @param {ImageData} b */
function diffNear(a, b, x, y, r) {
  let over = 0;
  for (let j = Math.max(0, y - r); j < Math.min(H, y + r); j += 1) for (let i = Math.max(0, x - r); i < Math.min(W, x + r); i += 1) {
    const k = (j * W + i) * 4;
    if (Math.max(Math.abs(a.data[k] - b.data[k]), Math.abs(a.data[k + 1] - b.data[k + 1]), Math.abs(a.data[k + 2] - b.data[k + 2])) > 16) over += 1;
  }
  return over;
}

gpuTest('the fire starts at the pointer press: early on only the form around it burns, the far corner is untouched', async (t) => {
  const ref = await reference(t);
  const { rig } = await start(t, { intro: false });
  const t0 = performance.now();
  rig.tick(t0);
  const r = rig.canvas.getBoundingClientRect();
  rig.layerEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + 380, clientY: r.top + 80 }));
  trigger(rig.canvas, 'out');
  rig.tick(t0 + 10);
  rig.tick(t0 + 10 + DURATION * 0.12);
  const early = rig.snap();
  const near = diffNear(early, ref, 380, 80, 60), far = diffNear(early, ref, 60, 280, 40);
  console.error(`disintegrate origin at (380, 80), 12%: changed near ${near} px / far ${far} px`);
  assert.ok(near > 2000 && far === 0, 'the form burns around the pointer first');
  rig.tick(t0 + 10 + DURATION * 0.45);
  assert.ok(diffNear(rig.snap(), ref, 60, 280, 40) > 1000, 'and the front reaches the far corner later');
});

gpuTest('live: the flying flakes keep sampling the page, so a change made after they broke off shows up on them, away from where it was drawn', async (t) => {
  // the "Go" button (40..160 x 40..80) changes colour 150 ms into the burn, after its flakes have broken off; the frames at 240 ms of a
  // run with the change and of a run without it differ, and the difference lies (also) outside the button's own rectangle: on the flakes
  // that carry it away. Control: two runs without the change are identical, so every differing pixel is the change.
  const recolour = (/** @type {CanvasRenderingContext2D} */ ctx) => { paint(ctx); ctx.fillStyle = '#ff2a6a'; ctx.fillRect(40, 40, 120, 40); };
  const run = async (/** @type {boolean} */ change) => {
    const { rig, host } = await start(t, { intro: false });
    const t0 = performance.now();
    rig.tick(t0);
    trigger(rig.canvas, 'out', { x: 100, y: 60 });
    rig.tick(t0 + 10);
    for (let now = t0 + 10; now <= t0 + 150; now += 16) rig.tick(now);
    if (change) rig.commit(null, recolour);
    for (let now = t0 + 160; now <= t0 + 240; now += 16) rig.tick(now);
    rig.tick(t0 + 250);
    const img = rig.snap();
    host.destroy();
    rig.root.remove();
    return img;
  };
  const same = await run(false);
  const again = await run(false);
  const changed = await run(true);
  assert.equal(diff(same, again).over, 0, 'without the change two runs are identical');
  let inside = 0, outside = 0;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 4;
      const d = Math.max(Math.abs(same.data[i] - changed.data[i]), Math.abs(same.data[i + 1] - changed.data[i + 1]), Math.abs(same.data[i + 2] - changed.data[i + 2]));
      if (d <= 24) continue;
      if (x >= 36 && x < 164 && y >= 36 && y < 84) inside += 1; else outside += 1;
    }
  }
  console.error(`disintegrate live: the change shows on ${inside} px inside the button's rectangle and ${outside} px outside it (on flakes and embers that carry it)`);
  assert.ok(outside > 150, `the change is visible on the moved flakes: ${outside} px outside the rectangle`);
});
