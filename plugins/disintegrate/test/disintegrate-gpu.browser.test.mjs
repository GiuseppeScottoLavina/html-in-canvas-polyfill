// Disintegrate (dust) through the REAL effects host on a real WebGPU canvas: the assembled frame against the host's own passthrough (bit for
// bit), mid-transition frames (never dark: the page stays), the background untouched while the content turns to dust, the dust in the
// colours of its pixels, input blocking through the interposer, frame-cap independence, the reduced-motion crossfade, device loss, the
// submit wiring, the diagonal sweep, and live content on the dust.
// Run: node test/unit/run.mjs plugins/disintegrate/test/disintegrate-gpu.browser.test.mjs
import { assert, sleep } from '/test/unit/lib/t.js';
import { gpuAvailable, gpuTest } from '/plugins/_shared/gpu-check.mjs';
import { CONTROLS, DURATION, H, W, diff, diffNear, paint, transitionRig } from '/plugins/_shared/transition-gpu-rig.mjs';
import { plugin, trigger } from '/plugins/disintegrate/index.js';
import { isNoTarget } from '/src/effects/no-target.js';

console.error(`disintegrate-gpu tests: WebGPU ${(await gpuAvailable()) ? 'available' : 'NOT available'}`);

const { reference, start } = transitionRig(plugin, { duration: DURATION, durationIn: DURATION });

gpuTest('idle: the presented frame equals the host passthrough bit for bit, and the mapper is the identity', async (t) => {
  const ref = await reference(t);
  const { rig, mappers } = await start(t, { intro: false });
  rig.tick(performance.now());
  const d = diff(rig.snap(), ref);
  assert.equal(d.max, 0, `idle frame differs from the passthrough by up to ${d.max} levels`);
  const m = /** @type {any} */ (mappers.at(-1));
  assert.deepEqual(m({ x: 120, y: 60, width: W, height: H }), { x: 120, y: 60 });
});

/** mean luminance (0..255) @param {ImageData} img */
function meanLuma(img) {
  let sum = 0;
  for (let i = 0; i < img.data.length; i += 4) sum += 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
  return sum / (img.data.length / 4);
}
/** the content of the test picture (paint): the light panels, the orange button, the big text line */
const CONTENT = [[40, 40, 120, 40], [40, 120, 200, 28], [40, 180, 200, 28], [280, 180, 90, 28], [36, 262, 340, 36]];
const inContent = (/** @type {number} */ x, /** @type {number} */ y, m = 0) => CONTENT.some(([cx, cy, cw, ch]) => x >= cx - m && x < cx + cw + m && y >= cy - m && y < cy + ch + m);

gpuTest('play: mid-transition frames are non-blank, never dark (the page stays), differ from each other and from the source; the end frame is the source', async (t) => {
  const ref = await reference(t);
  const { rig, mappers } = await start(t, { intro: false });
  const t0 = performance.now();
  rig.tick(t0);
  const done = trigger(rig.canvas, 'play');
  rig.tick(t0 + 10);                                  // the clock of the transition starts here
  const shots = [];
  for (const at of [0.15, 0.3, 0.45, 0.7, 0.9, 1.2, 1.5, 1.8]) { rig.tick(t0 + 10 + DURATION * at); shots.push(rig.snap()); }
  const midMapper = /** @type {any} */ (mappers.at(-1));
  const lumas = shots.map(meanLuma);
  console.error(`disintegrate mean luminance: source ${meanLuma(ref).toFixed(1)}, frames ${lumas.map((l) => l.toFixed(1)).join(' ')}`);
  // (the light panels of this picture are a large share of its brightness: with all of its content gone the page alone is about 0.6 of it)
  for (const l of lumas) assert.ok(l > 0.55 * meanLuma(ref), `a frame of the transition is dark: ${l.toFixed(1)} against ${meanLuma(ref).toFixed(1)}`);
  const d01 = diff(shots[0], shots[1]), d0r = diff(shots[0], ref), d12 = diff(shots[1], shots[2]);
  console.error(`disintegrate mid frames: 15%->30% ${d01.over} px, 15% vs source ${d0r.over} px, 30%->45% ${d12.over} px`);
  assert.ok(d01.over > 1500 && d12.over > 1500 && d0r.over > 1500, 'frames move');
  assert.ok(isNoTarget(midMapper({ x: 120, y: 60, width: W, height: H })), 'input blocked mid-transition (NO_TARGET)');
  for (let now = t0 + 10 + DURATION * 1.8; now <= t0 + 10 + DURATION * 2.2; now += 8.33) rig.tick(now);
  rig.tick(t0 + 10 + DURATION * 2.3);
  assert.equal(await done, true, 'the play promise resolves true');
  const end = diff(rig.snap(), ref);
  assert.equal(end.max, 0, `reassembled frame differs from the source by up to ${end.max} levels`);
  assert.deepEqual(/** @type {any} */ (mappers.at(-1))({ x: 120, y: 60, width: W, height: H }), { x: 120, y: 60 }, 'identity again');
});

gpuTest('the background stays: while the content turns to dust, the page around it is untouched (apart from dust passing over it); the content is gone', async (t) => {
  const ref = await reference(t);
  const { rig } = await start(t, { intro: false });
  const t0 = performance.now();
  rig.tick(t0);
  trigger(rig.canvas, 'out');
  rig.tick(t0 + 10);
  rig.tick(t0 + 10 + DURATION * 0.62);               // every pixel of content has eroded by 0.5
  const img = rig.snap();
  let bg = 0, bgSame = 0, content = 0, contentGone = 0;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const k = (y * W + x) * 4;
      const d = Math.max(Math.abs(img.data[k] - ref.data[k]), Math.abs(img.data[k + 1] - ref.data[k + 1]), Math.abs(img.data[k + 2] - ref.data[k + 2]));
      if (!inContent(x, y, 10)) { bg += 1; if (d <= 6) bgSame += 1; }
      else if (inContent(x, y, -3) && Math.max(ref.data[k], ref.data[k + 1]) > 200) { content += 1; if (d > 60) contentGone += 1; }
    }
  }
  console.error(`disintegrate background: ${bgSame} of ${bg} background px unchanged; ${contentGone} of ${content} light content px gone`);
  assert.ok(bgSame > 0.85 * bg, `the background changed: only ${(100 * bgSame / bg).toFixed(1)} % unchanged`);
  assert.ok(contentGone > 0.8 * content, `the content is still there: ${contentGone} of ${content} px gone`);
});

gpuTest('the dust keeps the colour of its pixel: the orange button leaves orange dust where there was none', async (t) => {
  const { rig } = await start(t, { intro: false });
  const t0 = performance.now();
  rig.tick(t0);
  trigger(rig.canvas, 'out');
  rig.tick(t0 + 10);
  let orange = 0;
  for (const at of [0.45, 0.55, 0.65]) {
    rig.tick(t0 + 10 + DURATION * at);
    const img = rig.snap();
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        if (inContent(x, y, 2)) continue;
        const k = (y * W + x) * 4;
        const [r, g, b] = [img.data[k], img.data[k + 1], img.data[k + 2]];
        if (r > 140 && r > g + 30 && g > b + 25) orange += 1;   // #ffb06b-ish, where the picture has no orange
      }
    }
  }
  console.error(`disintegrate: ${orange} orange dust px outside the content`);
  assert.ok(orange > 80, `${orange} orange px of dust`);
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

gpuTest('prefers-reduced-motion: the content fades into the page, nothing moves, the background is untouched', async (t) => {
  const ref = await reference(t);
  const { rig } = await start(t, { intro: false, reducedMotion: true });
  const t0 = performance.now();
  rig.tick(t0);
  trigger(rig.canvas, 'out');
  rig.tick(t0 + 10);
  rig.tick(t0 + 10 + DURATION * 0.5);
  const img = rig.snap();
  let bg = 0, bgSame = 0, light = 0, dimmer = 0;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const k = (y * W + x) * 4;
      const d = Math.max(Math.abs(img.data[k] - ref.data[k]), Math.abs(img.data[k + 1] - ref.data[k + 1]), Math.abs(img.data[k + 2] - ref.data[k + 2]));
      if (!inContent(x, y, 10)) { bg += 1; if (d <= 4) bgSame += 1; }
      else if (inContent(x, y, -3) && ref.data[k + 1] > 200) { light += 1; const was = ref.data[k + 1], now = img.data[k + 1]; if (now < was - 40 && now > 60) dimmer += 1; }
    }
  }
  console.error(`disintegrate reduced motion: ${bgSame}/${bg} background px unchanged, ${dimmer}/${light} light content px half faded`);
  assert.ok(bgSame > 0.97 * bg, 'no dust, nothing moves: the background is the source');
  assert.ok(dimmer > 0.8 * light, 'the content is half way to the background');
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
  const first = rig.snap();
  assert.ok(first.data[(60 * W + 100) * 4 + 1] < 150 && meanLuma(first) > 0.6 * meanLuma(ref), 'the intro starts with the content gone (the light button at 100, 60 shows the page), the page there');
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
  assert.ok(diff(rig.snap(), ref).over > 2000, 'valid submit: the content turns to dust');
});


gpuTest('the diagonal sweep: early on the content at the top left has started to erode, the far corner is untouched', async (t) => {
  const ref = await reference(t);
  const { rig } = await start(t, { intro: false });
  const t0 = performance.now();
  rig.tick(t0);
  trigger(rig.canvas, 'out');
  rig.tick(t0 + 10);
  rig.tick(t0 + 10 + DURATION * 0.12);
  const early = rig.snap();
  const near = diffNear(early, ref, 100, 60, 30), far = diffNear(early, ref, 325, 194, 14);
  console.error(`disintegrate sweep, 12%: changed at the top left ${near} px / at the Send button ${far} px`);
  assert.ok(near > 300 && far === 0, 'the content erodes from the top left first');
  rig.tick(t0 + 10 + DURATION * 0.55);
  assert.ok(diffNear(rig.snap(), ref, 325, 194, 14) > 300, 'and the sweep reaches the far side later');
});

gpuTest('live: the dust keeps sampling the page, so a change made after it blew off shows up on it, away from where it was drawn', async (t) => {
  // the "Go" button (40..160 x 40..80) changes colour 150 ms into the transition, after its content has started to turn to dust; the
  // frames at 450 ms of a run with the change and of a run without it differ, and the difference lies (also) outside the button's own
  // rectangle: on the dust that carries it away. Control: two runs without the change are identical, so every differing pixel is the change.
  const recolour = (/** @type {CanvasRenderingContext2D} */ ctx) => { paint(ctx); ctx.fillStyle = '#ff2a6a'; ctx.fillRect(40, 40, 120, 40); };
  const run = async (/** @type {boolean} */ change) => {
    const { rig, host } = await start(t, { intro: false });
    const t0 = performance.now();
    rig.tick(t0);
    trigger(rig.canvas, 'out');
    rig.tick(t0 + 10);
    for (let now = t0 + 10; now <= t0 + 150; now += 16) rig.tick(now);
    if (change) rig.commit(null, recolour);
    for (let now = t0 + 160; now <= t0 + 440; now += 16) rig.tick(now);
    rig.tick(t0 + 450);
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
  console.error(`disintegrate live: the change shows on ${inside} px inside the button's rectangle and ${outside} px outside it (on the dust that carries it)`);
  assert.ok(outside > 150, `the change is visible on the moving dust: ${outside} px outside the rectangle`);
});
