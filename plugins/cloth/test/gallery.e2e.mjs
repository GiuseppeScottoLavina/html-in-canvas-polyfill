#!/usr/bin/env node
// The cloth plugin in the plugin gallery (examples/plugins/?effect=cloth) in headless Chrome with trusted input (CDP): at rest the host
// renders nothing; a click on the flat cloth focuses a field and typing reaches it; a moving pointer pushes the cloth and it comes back
// to rest by itself; held by two corners the cloth hangs in folds, and a click where a control is DRAWN (not where it is in the DOM)
// activates it, typing shows on the folded cloth, and nothing is rendered between two key strokes; a press that moves takes the cloth
// (nothing of the gesture reaches the form: no click, no selection), a press on a slider drags the slider, a click on the button clicks;
// the actions from the gallery's buttons (handle.trigger), superseding, settled(); the frame cap; reduced motion; touch (the hem is
// grabbed, a finger elsewhere scrolls the page); the cloth under and over another effect. `--record` also writes media/cloth.webp.
//
//   npm run build   (the bundles; `npm run test:plugins` runs every gallery e2e)
//   node plugins/cloth/test/gallery.e2e.mjs [--record]
import { join } from 'node:path';
import { ROOT, actionChecks, changed, checklist, clickOn, drag, framesDuring, idle, openGallery, rectOf, scrollRoom, shot, sleep, startRecording, writeWebp } from '../../_shared/gallery-e2e.mjs';

const record = process.argv.includes('--record');
const c = checklist('cloth gallery e2e');

const FORM_PROBE = `(() => {
  const form = document.getElementById('demo-form');
  window.__formEvents = {};
  for (const t of ['pointerup', 'click', 'mouseup', 'selectstart', 'submit']) form.addEventListener(t, () => { window.__formEvents[t] = (window.__formEvents[t] || 0) + 1; }, true);
})()`;
const formState = (/** @type {any} */ page) => page.evaluate(`({ events: window.__formEvents, active: document.activeElement && document.activeElement.id, selection: String(getSelection()),
  email: document.getElementById('email').value, feedback: document.getElementById('form-feedback').dataset.state || '', cursor: document.documentElement.getAttribute('data-hic-cloth-cursor') })`);
const settled = (/** @type {any} */ page, ms = 10000) => page.evaluate(`Promise.race([window.__gallery.handle.settled(), new Promise((r) => setTimeout(() => r('still moving after ${ms} ms'), ${ms}))])`);
/**
 * Where the presented frame draws the centre of an element of the form, by the plugin's own mapper over the state of that frame (the
 * formula the GPU tests compare with the pixels); and what the frame draws at the element's place in the DOM. Canvas content px.
 * @param {any} page @param {string} selector
 */
const drawnAt = (page, selector) => page.evaluate(`(() => {
  const P = window.HicLivePlugins.cloth, canvas = document.getElementById('stage'), state = P.presentedState(canvas);
  const r = canvas.getBoundingClientRect(), ox = r.left + canvas.clientLeft, oy = r.top + canvas.clientTop, W = canvas.clientWidth, H = canvas.clientHeight;
  const e = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
  const cx = e.left + e.width / 2 - ox, cy = e.top + e.height / 2 - oy;
  let best = null;
  for (let y = Math.max(1, cy - 90); y < Math.min(H - 1, cy + 90); y += 1) for (let x = Math.max(1, cx - 90); x < Math.min(W - 1, cx + 90); x += 1) {
    const m = P.mapClothPoint(state, { x, y, width: W, height: H });
    if (P.isNoTarget(m)) continue;
    const d = Math.hypot(m.x - cx, m.y - cy);
    if (!best || d < best.d) best = { x, y, d };
  }
  const shows = P.mapClothPoint(state, { x: cx, y: cy, width: W, height: H });
  return { drawn: best, dom: { x: cx, y: cy }, domShows: P.isNoTarget(shows) ? null : shows, half: { w: e.width / 2, h: e.height / 2 }, ox, oy, mode: state && state[5] };
})()`);

async function main() {
  // ------------------------------------------------------------------------------------------------------------- normal motion
  const g = await openGallery('cloth');
  const { page } = g;
  console.log(`Chrome ${g.chrome}, plugin bundle ${g.bundle.bytes} bytes (minified)`);
  try {
    const st = await page.evaluate(`({ mode: window.__gallery.mode, controls: !!document.querySelector('#effect-controls .hic-cloth-ui'), actions: [...window.__gallery.handle.actions] })`);
    c.check('the gallery runs the effect on WebGPU and mounts the plugin controls inside the drawn form', st.mode === 'effect' && st.controls && st.actions.join() === 'demo,gust,drop,in', st);
    const stage = await rectOf(page, '#stage');
    await page.mouseMove(stage.x + stage.w + 5, stage.y + 5);
    await idle(page);
    const rest = (await shot(page)).img;

    // zero work at rest; control: the opt-in breeze presents frames in the same 3 s
    const idleFrames = await framesDuring(page, 3000);
    await page.evaluate(`window.__gallery.handle.setOptions({ wind: 0.5 })`);
    const breezeFrames = await framesDuring(page, 3000);
    await page.evaluate(`window.__gallery.handle.setOptions({ wind: 0 })`);
    const calm = await settled(page);
    c.check('zero work at rest: no effect frame in 3 s (control: the opt-in wind 0.5 presents frames in the same 3 s; back at 0 the cloth settles)', idleFrames === 0 && breezeFrames >= 30 && calm === 'hanging', { idleFrames, breezeFrames, calm });
    await idle(page);
    const back = changed((await shot(page)).img, rest);
    c.check('settled, the picture is the picture at rest again, to the pixel', back.px === 0, back);

    // the flat cloth: a click focuses the field under it, typing reaches it; the press pokes the cloth and it comes back to rest
    const f0 = await page.evaluate('window.__e2e.frames');
    await clickOn(page, '#email');
    await sleep(120);
    await page.typeText('x');
    await sleep(150);
    let s = await formState(page);
    const poked = (await page.evaluate('window.__e2e.frames')) - f0;
    c.check('a trusted click on the cloth focuses the email field and typing reaches it; the press pokes the cloth (frames are presented)', s.active === 'email' && s.email === 'ada@example.comx' && poked > 5, { active: s.active, email: s.email, frames: poked });
    c.check('the poke dies out: the host goes idle again', (await settled(page)) === 'hanging' && (await idle(page)));

    // a moving pointer pushes the cloth
    await page.evaluate(`document.getElementById('stage').frameCap = 120`);
    const during = framesDuring(page, 700);
    for (let i = 0; i <= 28; i += 1) { await page.mouseMove(stage.x + stage.w * (0.2 + 0.6 * (i / 28)), stage.y + stage.h * (0.72 + 0.1 * Math.sin(i / 4))); await sleep(14); }
    const pushed = changed((await shot(page)).img, rest, 6);
    const pushFrames = await during;
    c.check('a moving pointer pushes the cloth: the presented pixels change and frames are presented', pushed.px > 1500 && pushFrames > 15, { ...pushed, frames: pushFrames });
    await page.mouseMove(stage.x + stage.w + 5, stage.y + 5);
    c.check('the dent dies out by itself and the picture is the picture at rest again', (await settled(page)) === 'hanging' && (await idle(page)) && changed((await shot(page)).img, rest).px === 0);

    // held by its two corners the cloth hangs in folds: input goes to what is drawn, not to where it is in the DOM
    await page.evaluate(`window.__gallery.handle.setOptions({ pins: 'corners' })`);
    const hung = await settled(page, 12000);
    await idle(page);
    const folds = changed((await shot(page)).img, rest, 6);
    const foldFrames = await framesDuring(page, 2000);
    c.check('pins: corners. The cloth sags into folds and comes to rest there: no frame in 2 s', hung === 'hanging' && folds.px > 0.1 * stage.w * stage.h && foldFrames === 0, { hung, ...folds, frames: foldFrames });
    const targets = [];
    for (const sel of ['#consent', '#name', '#email']) targets.push({ sel, ...(await drawnAt(page, sel)) });
    // prefer a control whose place in the DOM shows something clearly outside it, so that the control click means something
    const clear = (/** @type {any} */ t) => !t.domShows || Math.abs(t.domShows.x - t.dom.x) > t.half.w + 3 || Math.abs(t.domShows.y - t.dom.y) > t.half.h + 3;
    const target = targets.find((t) => t.drawn && t.drawn.d < 1.5 && clear(t)) ?? targets.find((t) => t.drawn && t.drawn.d < 1.5);
    const read = () => page.evaluate(`({ checked: document.getElementById('consent').checked, active: document.activeElement && document.activeElement.id })`);
    const activated = (/** @type {any} */ a, /** @type {any} */ b) => (target?.sel === '#consent' ? a.checked !== b.checked : `#${b.active}` === target?.sel);
    if (c.check('a control is drawn away from its place in the DOM (found with the plugin\'s mapper over the presented frame)', !!target && Math.hypot(target.drawn.x - target.dom.x, target.drawn.y - target.dom.y) > 6,
      target && { control: target.sel, drawn: target.drawn, dom: target.dom, domShows: target.domShows })) {
      const t = /** @type {any} */ (target);
      await page.evaluate(`document.activeElement && document.activeElement.blur()`);
      if (clear(t)) {
        const before = await read();
        await page.mouseMove(t.ox + t.dom.x, t.oy + t.dom.y);
        await page.mouseDown(t.ox + t.dom.x, t.oy + t.dom.y); await page.mouseUp(t.ox + t.dom.x, t.oy + t.dom.y);
        await sleep(250);
        c.check(`control: a click at the DOM place of ${t.sel} (the cloth shows something else there) does not activate it`, !activated(before, await read()), { at: t.dom, shows: t.domShows });
        await settled(page, 12000);
        await page.evaluate(`document.activeElement && document.activeElement.blur()`);
      }
      // the cloth has been poked and has settled again: look where the control is drawn now
      const now = await drawnAt(page, t.sel);
      const before = await read();
      await page.mouseMove(now.ox + now.drawn.x, now.oy + now.drawn.y);
      await page.mouseDown(now.ox + now.drawn.x, now.oy + now.drawn.y); await page.mouseUp(now.ox + now.drawn.x, now.oy + now.drawn.y);
      await sleep(250);
      c.check(`a trusted click where ${t.sel} is DRAWN on the folded cloth activates it`, activated(before, await read()), { at: now.drawn, dom: now.dom });
    }
    // typing on the folded cloth: the page changes, the frame follows, and nothing is rendered between two key strokes
    await settled(page, 12000);
    const message = await drawnAt(page, '#message');
    await page.mouseMove(message.ox + message.drawn.x, message.oy + message.drawn.y);
    await page.mouseDown(message.ox + message.drawn.x, message.oy + message.drawn.y); await page.mouseUp(message.ox + message.drawn.x, message.oy + message.drawn.y);
    await settled(page, 12000);
    await idle(page);
    const quiet = (await shot(page)).img;
    await page.typeText(' Typed on the cloth.');
    await sleep(700);
    const typed = changed((await shot(page)).img, quiet, 8);
    s = await page.evaluate(`({ active: document.activeElement && document.activeElement.id, message: document.getElementById('message').value })`);
    // the field draws a blinking caret: between two blinks nothing is presented
    await page.evaluate(`document.activeElement && document.activeElement.blur()`);
    await sleep(300);
    const afterTyping = await framesDuring(page, 1500);
    c.check('on the folded cloth a click where the message field is drawn focuses it, typed text shows on the cloth, and nothing is rendered afterwards', s.active === 'message' && / Typed on the cloth\.$/.test(s.message) && typed.px > 80 && afterTyping === 0,
      { active: s.active, changed: typed, framesAfter: afterTyping });
    await page.evaluate(`window.__gallery.handle.setOptions({ pins: 'top' })`);
    c.check('pins: top again. The cloth is drawn back to its rail and hangs flat', (await settled(page, 12000)) === 'hanging' && (await idle(page)));
    const flatAgain = (await shot(page)).img;

    // a press that moves takes the cloth; nothing of it reaches the form
    await page.evaluate(FORM_PROBE);
    const hero = await rectOf(page, '.hero h1');
    const from = [hero.cx, hero.cy];
    const path = Array.from({ length: 36 }, (_, i) => [from[0] + i * 9, from[1] + i * 5]);
    const fd = await page.evaluate('window.__e2e.frames');
    await drag(page, path, { stepMs: 16, release: false });
    await sleep(500);
    const held = (await shot(page)).img;
    s = await formState(page);
    const lifted = changed(held, flatAgain, 8);
    c.check('a press on the page that moves takes the cloth: it follows the hand (the picture changes), the cursor is grabbing, no text is selected',
      lifted.px > 0.1 * stage.w * stage.h && s.cursor === 'grabbing' && s.selection === '' && (await page.evaluate('window.__e2e.frames')) - fd > 20, { ...lifted, cursor: s.cursor, selection: s.selection });
    const last = path[path.length - 1];
    await page.mouseUp(last[0], last[1]);
    await sleep(120);
    s = await formState(page);
    c.check('release: the pointerup and the click that follows never reach the form; the cursor is back', !s.events.pointerup && !s.events.click && s.cursor === null, s);
    c.check('released, the cloth swings back and comes to rest on the page', (await settled(page)) === 'hanging' && (await idle(page)) && changed((await shot(page)).img, flatAgain).px === 0);

    // the same press and move on the button: the cloth is taken, the form is not submitted; a plain click on it submits
    const submit = await rectOf(page, '#submit');
    await drag(page, Array.from({ length: 20 }, (_, i) => [submit.cx - i * 6, submit.cy - i * 4]), { stepMs: 16 });
    await sleep(200);
    s = await formState(page);
    c.check('a press on the Submit button that moves is the cloth\'s gesture: the form is not submitted', !s.events.submit && s.feedback !== 'success', { events: s.events, feedback: s.feedback });
    await settled(page);
    await clickOn(page, '#submit');
    await sleep(300);
    s = await formState(page);
    c.check('a press on the Submit button that does not move is a click: the form is submitted', s.events.submit === 1 && s.feedback === 'success', { events: s.events, feedback: s.feedback });
    // a slider is dragged itself: the cloth is never taken from it
    await settled(page);
    const cap = await rectOf(page, '#fps-cap');
    const v0 = await page.evaluate(`document.getElementById('fps-cap').value`);
    await drag(page, Array.from({ length: 12 }, (_, i) => [cap.x + cap.w * 0.9 - i * cap.w * 0.04, cap.cy]), { stepMs: 16, release: false });
    s = await formState(page);
    const v1 = await page.evaluate(`document.getElementById('fps-cap').value`);
    await page.mouseUp(cap.x + cap.w * 0.46, cap.cy);
    c.check('a press on a slider that moves drags the slider, not the cloth', v1 !== v0 && s.cursor === null, { from: v0, to: v1, cursor: s.cursor });
    await page.evaluate(`document.getElementById('stage').frameCap = 0`);
    await settled(page);
    await idle(page);

    // the actions of the effect handle, as a page uses them (the gallery's buttons call handle.trigger)
    await actionChecks(page, c.check, [
      { action: 'gust', state: 'hanging', midMs: 350, minChanged: 2000 },
      { action: 'drop', state: 'dropped', midMs: 300, minChanged: 0.2 * stage.w * stage.h },
      { action: 'in', state: 'hanging', midMs: 600, minChanged: 0.2 * stage.w * stage.h },
      { action: 'demo', state: 'hanging', midMs: 350, minChanged: 2000 },
    ], { older: 'demo', newer: 'gust', state: 'hanging' });
    await idle(page);
    c.check('after the actions: zero work at rest (no frame in 3 s) and the picture at rest', (await framesDuring(page, 3000)) === 0 && changed((await shot(page)).img, flatAgain).px < 400);

    // dropped: nothing of the page can be pressed; a press on the wall hangs the cloth again
    await page.evaluate(`window.__gallery.handle.trigger('drop'); true`);
    await settled(page);
    const name = await rectOf(page, '#name');
    await page.evaluate(`document.activeElement && document.activeElement.blur()`);
    await page.mouseMove(name.cx, name.cy);
    await page.mouseDown(name.cx, name.cy); await page.mouseUp(name.cx, name.cy);
    await sleep(100);
    const whileGone = await page.evaluate(`document.activeElement && document.activeElement.id`);
    const again = await settled(page);
    c.check('dropped: a press where the name field was focuses nothing (the wall shows), and hangs the cloth again', whileGone !== 'name' && again === 'hanging', { active: whileGone, state: again });

    // the frame cap bounds the frames of a gust
    await page.evaluate(`document.getElementById('stage').frameCap = 30`);
    await sleep(200);
    const fc = await page.evaluate('window.__e2e.frames');
    const tc = Date.now();
    await page.evaluate(`window.__gallery.handle.trigger('gust'); true`);
    await sleep(1200);
    const fps = (((await page.evaluate('window.__e2e.frames')) - fc) * 1000) / (Date.now() - tc);
    c.check('frame cap 30: a gust is presented at no more than about 30 frames per second', fps <= 34 && fps >= 12, { fps: Math.round(fps * 10) / 10 });
    await page.evaluate(`document.getElementById('stage').frameCap = 0`);
    await settled(page);
    const errors = [...page.errors({ includeWarnings: false }).map((/** @type {any} */ e) => e.text), ...(await page.evaluate('window.__e2e.errors'))];
    c.check('no console error, page exception or effecterror', errors.length === 0, errors.slice(0, 3));

    // the cloth under and over another effect: it still takes a click and comes to rest
    for (const [first, then] of [['cloth', 'crt'], ['water', 'cloth']]) {
      await page.navigate(`${g.server.url}/examples/plugins/?effect=${first}&then=${then}&demo=0`);
      await page.waitForFunction(`!!(window.__gallery && window.__gallery.ready && window.__gallery.active === ${JSON.stringify(first)} && window.__gallery.then === ${JSON.stringify(then)} && window.__gallery.handle2)`, { timeout: 20000 });
      await page.evaluate(`(() => { const c = document.getElementById('stage'); window.__e2e = { frames: 0, last: performance.now(), errors: [] };
        c.addEventListener('effectframe', () => { window.__e2e.frames += 1; window.__e2e.last = performance.now(); });
        c.addEventListener('effecterror', (e) => { window.__e2e.errors.push(String(e.detail && e.detail.error)); }); document.getElementById('stage').scrollIntoView({ block: 'start' }); })()`);
      await sleep(500);
      const cloth = first === 'cloth' ? 'handle' : 'handle2';
      const before = (await shot(page)).img;
      await page.evaluate(`window.__gallery.${cloth}.trigger('gust', { strength: 1.4 }); true`);
      await sleep(450);
      const blown = changed((await shot(page)).img, before, 8);
      const state = await page.evaluate(`Promise.race([window.__gallery.${cloth}.settled(), new Promise((r) => setTimeout(() => r('still moving'), 10000))])`);
      const errs = [...page.errors({ includeWarnings: false }).map((/** @type {any} */ e) => e.text), ...(await page.evaluate('window.__e2e.errors'))];
      c.check(`${first} with ${then} over it: a gust moves the picture, the cloth settles, no error`, blown.px > 2000 && state === 'hanging' && errs.length === 0, { ...blown, state, errors: errs.slice(0, 2) });
    }
  } finally {
    await g.close();
  }

  // ------------------------------------------------------------------------------------------------------------- reduced motion
  const r = await openGallery('cloth', { reducedMotion: true });
  try {
    const stage = await rectOf(r.page, '#stage');
    await idle(r.page);
    const flat = (await shot(r.page)).img;
    for (let i = 0; i <= 20; i += 1) { await r.page.mouseMove(stage.x + 200 + i * 20, stage.y + 300); await sleep(12); }
    const moved = await framesDuring(r.page, 600);
    const demo = await r.page.evaluate(`window.__gallery.handle.trigger('demo')`);
    const gust = await r.page.evaluate(`window.__gallery.handle.trigger('gust', { strength: 2 })`);
    const after = await framesDuring(r.page, 800);
    c.check('prefers-reduced-motion: the pointer pushes nothing, demo and gust resolve hanging at once, and the picture stays the page', moved <= 2 && demo === 'hanging' && gust === 'hanging' && after <= 2 && changed((await shot(r.page)).img, flat).px === 0,
      { framesWhileMoving: moved, demo, gust, framesAfter: after });
    const t0 = Date.now();
    const dropped = await r.page.evaluate(`window.__gallery.handle.trigger('drop')`);
    const ms = Date.now() - t0;
    const wall = changed((await shot(r.page)).img, flat, 8);
    const quiet = await framesDuring(r.page, 1000);
    c.check('prefers-reduced-motion: drop crossfades to the bare wall (no cloth falls) and then nothing is rendered', dropped === 'dropped' && ms < 1500 && wall.px > 0.5 * stage.w * stage.h && quiet === 0, { dropped, ms, ...wall, frames: quiet });
    const back = await r.page.evaluate(`window.__gallery.handle.trigger('in')`);
    await idle(r.page);
    c.check('prefers-reduced-motion: in crossfades back to the page', back === 'hanging' && changed((await shot(r.page)).img, flat).px === 0, { back });
  } finally {
    await r.close();
  }

  // ------------------------------------------------------------------------------------------------------------- touch
  // Chrome's touch emulation: trusted touch events (Input.dispatchTouchEvent), the browser's own scroll and pointer pipeline
  const tg = await openGallery('cloth', { height: 700 });
  try {
    const { page } = tg;
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await page.evaluate(`(() => { window.__touch = { cancel: 0, down: 0 }; addEventListener('pointercancel', () => { window.__touch.cancel += 1; }, true); addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') window.__touch.down += 1; }, true); })()`);
    await scrollRoom(page);
    await page.evaluate(`document.getElementById('stage').scrollIntoView({ block: 'center' })`);
    await sleep(400);
    await idle(page);
    /** a finger along a path @param {number[][]} pts */
    const finger = async (pts) => {
      await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pts[0][0], y: pts[0][1] }] });
      for (const [x, y] of pts.slice(1)) { await sleep(16); await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] }); }
      return async () => { await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); };
    };
    let stage = await rectOf(page, '#stage');
    const before = (await shot(page)).img;
    const y0 = await page.evaluate('scrollY');
    const lift = await finger(Array.from({ length: 30 }, (_, i) => [stage.x + stage.w * 0.6 - i * 4, stage.y + stage.h - 18 - i * 8]));
    await sleep(400);
    const held = (await shot(page)).img;
    const yHeld = await page.evaluate('scrollY');
    const t1 = await page.evaluate('window.__touch');
    await lift();
    const pulled = changed(held, before, 8);
    c.check('touch: a finger on the hem takes the cloth and pulls it up; the page does not scroll and the pointer is not cancelled', t1.down === 1 && t1.cancel === 0 && yHeld === y0 && pulled.px > 0.08 * stage.w * stage.h, { ...t1, scrolled: yHeld - y0, ...pulled });
    await settled(page);
    await idle(page);
    stage = await rectOf(page, '#stage');
    const y1 = await page.evaluate('scrollY');
    const away = await finger(Array.from({ length: 30 }, (_, i) => [stage.x + stage.w * 0.3, stage.cy + 60 - i * 6]));
    await away();
    await sleep(800);
    const y2 = await page.evaluate('scrollY');
    const t2 = await page.evaluate('window.__touch');
    c.check('touch: a finger anywhere else scrolls the page as usual (control: the same kind of drag from the middle of the stage)', y2 > y1 + 40 && t2.cancel >= 1, { scrolled: y2 - y1, cancel: t2.cancel });
    c.check('touch: after the scroll the cloth comes to rest', (await settled(page)) === 'hanging');
  } finally {
    await tg.close();
  }

  // ------------------------------------------------------------------------------------------------------------- the recording
  if (record) {
    const rec = await openGallery('cloth');
    try {
      const { page } = rec;
      const stage = await rectOf(page, '#stage');
      await page.evaluate(`document.getElementById('stage').frameCap = 120`);
      await clickOn(page, '#message');
      await settled(page);
      const stop = await startRecording(page);
      await sleep(500);                                           // the page, at rest
      await page.evaluate(`window.__gallery.handle.trigger('demo'); true`);
      await sleep(3300);                                          // a gust, and the cloth settles
      for (let i = 0; i <= 40; i += 1) { await page.mouseMove(stage.x + stage.w * (0.15 + 0.5 * (i / 40)), stage.y + stage.h * (0.75 + 0.08 * Math.sin(i / 5))); await sleep(16); }
      await sleep(500);                                           // a pointer pushes a dent along its way
      const from = [stage.x + stage.w * 0.3, stage.y + stage.h - 30];
      const arc = Array.from({ length: 56 }, (_, i) => [from[0] + (i / 55) * stage.w * 0.22, from[1] - (i / 55) * stage.h * 0.62 + Math.sin((i / 55) * Math.PI) * 30]);
      await drag(page, arc, { stepMs: 18, release: false, hover: false });
      await page.typeText(' It stays live in your hand.', { intervalMs: 45 });   // typed while the cloth is held
      await sleep(500);
      await page.mouseUp(arc[55][0], arc[55][1]);
      await page.mouseMove(stage.x + stage.w + 5, stage.y + 5);
      await sleep(2600);                                          // released, it swings back and settles
      await page.evaluate(`window.__gallery.handle.trigger('drop'); true`);
      await sleep(1300);                                          // the pins let go
      await page.evaluate(`window.__gallery.handle.trigger('in'); true`);
      await sleep(3000);                                          // hung again
      const frames = await stop();
      const bytes = writeWebp(frames, join(ROOT, 'plugins/cloth/media/cloth.webp'), { x: stage.x, y: stage.y, w: stage.w, h: stage.h }, { quality: 62 });
      c.check('recording: media/cloth.webp under 1400 KB', bytes < 1400 * 1024, { screencastFrames: frames.length, bytes });
    } finally {
      await rec.close();
    }
  }
  c.finish();
  process.exit(process.exitCode ?? 0);
}

main().catch((error) => { console.error(error); process.exit(2); });
