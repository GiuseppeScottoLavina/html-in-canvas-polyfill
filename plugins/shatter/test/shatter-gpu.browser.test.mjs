// Shatter through the REAL effects host on a real WebGPU canvas: the assembled frame against the host's own passthrough (bit for bit), the
// mapper of the cracked pane against the GPU pixels, a click through the cracked glass, the cracks running from the impact, the fall,
// input blocking through the interposer, frame-cap independence, reduced motion, device loss and the submit wiring.
// Run: node test/unit/run.mjs plugins/shatter/test/shatter-gpu.browser.test.mjs
import { assert, sleep } from '/test/unit/lib/t.js';
import { checkMapperAgainstGpu, gpuAvailable, gpuTest } from '/plugins/_shared/gpu-check.mjs';
import { nonDominantShare } from '/test/unit/gpu-effects/lib/rig.mjs';
import { CONTROLS, DURATION, H, W, diff, diffNear, transitionRig } from '/plugins/_shared/transition-gpu-rig.mjs';
import { plugin, trigger } from '/plugins/shatter/index.js';
import { isNoTarget } from '/src/effects/no-target.js';

console.error(`shatter-gpu tests: WebGPU ${(await gpuAvailable()) ? 'available' : 'NOT available'}`);

const { reference, start } = transitionRig(plugin, { duration: DURATION });

gpuTest('idle: the presented frame equals the host passthrough bit for bit, and the mapper is the identity', async (t) => {
  const ref = await reference(t);
  const { rig, mappers } = await start(t, { intro: false });
  rig.tick(performance.now());
  const d = diff(rig.snap(), ref);
  assert.equal(d.max, 0, `idle frame differs from the passthrough by up to ${d.max} levels`);
  const m = /** @type {any} */ (mappers.at(-1));
  assert.deepEqual(m({ x: 120, y: 60, width: W, height: H }), { x: 120, y: 60 });
});

gpuTest('cracked pane: the mapper agrees with the GPU pixels (the inverse of the offsets and of the bending), the identity does not', async (t) => {
  const verdict = await checkMapperAgainstGpu(t, plugin, { intro: false, state: 'cracked', impact: { x: 200, y: 150 }, edgeAmount: 0, glint: 0 });
  console.error(`shatter cracked mapper: ${verdict.real.wrong} wrong px of ${verdict.real.decided} (identity ${verdict.identity.wrong}), ${verdict.real.bright} bright`);
  assert.ok(verdict.ok, verdict.why);
});

gpuTest('a click through the cracked glass reaches the control drawn there; while the cracks run it is swallowed', async (t) => {
  const { rig, mappers } = await start(t, { intro: false }, { interposer: true, html: CONTROLS });
  const btn = /** @type {HTMLButtonElement} */ (rig.layerEl.querySelector('#btn'));
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
  trigger(rig.canvas, 'crack', { x: 120, y: 90 });
  rig.tick(t0 + 10);
  rig.tick(t0 + 100);
  press();
  assert.equal(clicks, 0, 'the cracks are running: the press is swallowed');
  rig.tick(t0 + 600);
  const m = /** @type {any} */ (mappers.at(-1));
  const p = m({ x: 100, y: 60, width: W, height: H });
  assert.ok(!isNoTarget(p) && (p.x !== 100 || p.y !== 60), `cracked: the mapper moves the point (${p.x.toFixed(2)}, ${p.y.toFixed(2)})`);
  press();
  assert.equal(clicks, 1, 'cracked and still: the click reaches the button drawn under the pointer');
});

gpuTest('the second impact breaks the pane: mid frames non-blank, moving, input blocked; it ends on the source with the identity', async (t) => {
  const ref = await reference(t);
  const { rig, mappers } = await start(t, { intro: false });
  const t0 = performance.now();
  rig.tick(t0);
  await Promise.all([trigger(rig.canvas, 'impact', { x: 300, y: 120 }), (async () => { rig.tick(t0 + 10); rig.tick(t0 + 600); })()]);
  const cracked = rig.snap();
  const dc = diff(cracked, ref);
  console.error(`shatter cracked pane vs source: ${dc.over} px`);
  assert.ok(dc.over > 500 && dc.over < 0.25 * W * H, 'cracked: crack lines and shifted pieces, the form still there');
  const done = trigger(rig.canvas, 'impact');
  rig.tick(t0 + 700);                                  // the clock of the fall starts here
  const shots = [];
  // physics 0.31, 0.48 and 0.65 s (the fall starts at 0.17 s): on this small canvas most shards have fallen out by 0.8 s
  for (const at of [0.18, 0.28, 0.38]) { rig.tick(t0 + 700 + DURATION * at); shots.push(rig.snap()); }
  const midMapper = /** @type {any} */ (mappers.at(-1));
  for (const img of shots) assert.ok(nonDominantShare(img) > 0.05, `mid frame non-blank (${nonDominantShare(img).toFixed(3)})`);
  const d01 = diff(shots[0], shots[1]), d0r = diff(shots[0], ref), d12 = diff(shots[1], shots[2]);
  console.error(`shatter mid frames: 18%->28% ${d01.over} px, 18% vs source ${d0r.over} px, 28%->38% ${d12.over} px`);
  assert.ok(d01.over > 2000 && d12.over > 2000 && d0r.over > 2000, 'frames move');
  assert.ok(isNoTarget(midMapper({ x: 120, y: 60, width: W, height: H })), 'input blocked mid-transition (NO_TARGET)');
  // out (1000 ms) + hold (300 ms) + in (1000 ms); step at 120 Hz to the end
  for (let now = t0 + 700 + 400; now <= t0 + 700 + 2400; now += 8.33) rig.tick(now);
  rig.tick(t0 + 3200);
  assert.equal(await done, true, 'the play promise resolves true');
  const end = diff(rig.snap(), ref);
  assert.equal(end.max, 0, `reassembled frame differs from the source by up to ${end.max} levels (the cracks closed too)`);
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
  assert.equal(await trigger(rig.canvas, 'crack'), false, 'nothing cracks');
  rig.tick(t0 + 5);
  assert.equal(diff(rig.snap(), ref).max, 0, 'the frame is the source');
  trigger(rig.canvas, 'impact');
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

gpuTest('intro and submit wiring: the shards fly together; an invalid submit cracks, a second one breaks it, a valid one heals the cracks', async (t) => {
  const ref = await reference(t);
  const { rig } = await start(t, { intro: true, onSubmit: 'invalid' }, { html: CONTROLS });
  const t0 = performance.now();
  rig.tick(t0);
  assert.ok(nonDominantShare(rig.snap()) < 0.01, 'the intro starts with every shard gone (only the backdrop)');
  rig.tick(t0 + DURATION * 0.5);
  assert.ok(nonDominantShare(rig.snap()) > 0.05, 'halfway the shards are on their way in');
  for (let now = t0 + 550; now <= t0 + DURATION + 100; now += 50) rig.tick(now);
  assert.equal(diff(rig.snap(), ref).max, 0, 'the intro ends on the source');
  const form = /** @type {HTMLFormElement} */ (rig.layerEl.querySelector('#f'));
  const mail = /** @type {HTMLInputElement} */ (rig.layerEl.querySelector('#mail'));
  form.addEventListener('submit', (e) => e.preventDefault());   // the page's own handler (a real submit would navigate the test page)
  let now = t0 + DURATION + 200;
  form.requestSubmit();
  rig.tick(now); rig.tick(now += 300);
  assert.equal(diff(rig.snap(), ref).max, 0, 'valid form: nothing happens');
  mail.value = 'nope';
  form.requestSubmit();
  rig.tick(now += 10); rig.tick(now += 600);
  const cracked = diff(rig.snap(), ref).over;
  assert.ok(cracked > 500 && cracked < 0.25 * W * H, `invalid email: the pane cracks (${cracked} px), the form still there`);
  mail.value = 'ada@example.com';
  form.requestSubmit();
  rig.tick(now += 10); rig.tick(now += 600);
  assert.equal(diff(rig.snap(), ref).max, 0, 'fixed and submitted again: the cracks close');
  mail.value = 'nope';
  form.requestSubmit();
  rig.tick(now += 10); rig.tick(now += 600);
  form.requestSubmit();
  rig.tick(now += 10); rig.tick(now += DURATION * 0.35);
  assert.ok(diff(rig.snap(), ref).over > 0.3 * W * H, 'a second invalid submit breaks the pane');
});


gpuTest('the cracks start at the pointer: first crack lines only near it, then the shards near it move first', async (t) => {
  const ref = await reference(t);
  const { rig } = await start(t, { intro: false, pieces: 40 });
  const t0 = performance.now();
  rig.tick(t0);
  const r = rig.canvas.getBoundingClientRect();
  rig.layerEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + 380, clientY: r.top + 80 }));
  trigger(rig.canvas, 'crack');
  rig.tick(t0 + 10);
  rig.tick(t0 + 10 + 25);                            // 25 ms of the 450 ms the cracks take: they have run about 70 px
  const crack = rig.snap();
  const nearCrack = diffNear(crack, ref, 380, 80, 60), farCrack = diffNear(crack, ref, 80, 260, 60);
  rig.tick(t0 + 600);
  const cracked = rig.snap();
  const farLater = diffNear(cracked, ref, 80, 260, 60);
  trigger(rig.canvas, 'impact');
  rig.tick(t0 + 610);
  rig.tick(t0 + 610 + DURATION * (0.25 / 1.7));     // physics 250 ms: the fall started at 170 ms, near the impact first
  const early = rig.snap();
  const nearMove = diffNear(early, cracked, 380, 80, 60), farMove = diffNear(early, cracked, 80, 260, 60);
  console.error(`shatter impact at (380, 80): crack lines near ${nearCrack} px / far ${farCrack} px (later ${farLater}); fell near ${nearMove} px / far ${farMove} px`);
  assert.ok(nearCrack > 50 && farCrack === 0, 'crack lines appear around the impact first');
  assert.ok(farLater > 0, 'and reach the far corner later');
  assert.ok(nearMove > 3000 && nearMove > 10 * farMove, 'shards near the impact fall first');
});

gpuTest('after a play from an off-centre impact the last frame equals the source at every sampled pixel and the mapper is the identity', async (t) => {
  const ref = await reference(t);
  const { rig, mappers } = await start(t, { intro: false });
  const t0 = performance.now();
  rig.tick(t0);
  trigger(rig.canvas, 'play', { x: 100, y: 100 });
  for (let now = t0 + 10; now <= t0 + 2500; now += 33) rig.tick(now);
  const img = rig.snap();
  const m = /** @type {any} */ (mappers.at(-1));
  let wrong = 0;
  for (let y = 5; y < H; y += 23) for (let x = 5; x < W; x += 29) {
    const p = m({ x: x + 0.5, y: y + 0.5, width: W, height: H });
    const a = ((Math.floor(p.y)) * W + Math.floor(p.x)) * 4, b = (y * W + x) * 4;
    if (a !== b || img.data[b] !== ref.data[a]) wrong += 1;
  }
  assert.equal(wrong, 0);
});
