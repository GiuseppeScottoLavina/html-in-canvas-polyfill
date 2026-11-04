#!/usr/bin/env node
// Gallery click-through of the page-curl plugin in headless Chrome with trusted input (CDP), on examples/plugins/?effect=page-curl:
// the affordances (the hint label, the dog-ear at rest, zero work at rest, the hover lift and the grab cursor), the flat
// page takes clicks and typing, a drag of the dog-eared corner curls the page and NOTHING of the drag reaches the form (no pointer/mouse
// event, no click, no focus change, no selection), typing DURING the drag reaches the focused field and changes the curled sheet (the page
// stays live), the release springs back to the dog-ear and clicks map again, the actions peek and demo from the gallery's buttons
// (handle.trigger; a press takes over from the demo), the frame cap, prefers-reduced-motion, and touch (Chrome's touch emulation, trusted
// touch events): a finger on a corner turns the page and the page does not scroll; a finger elsewhere scrolls the page. `--record` also
// writes media/page-curl.webp.
//
//   npm run build   (the bundles; `npm run test:plugins` runs every gallery e2e)
//   node plugins/page-curl/test/gallery.e2e.mjs [--record]
import { join } from 'node:path';
import { ROOT, actionChecks, changed, drag, framesDuring, idle, openGallery, rectOf, shot, sleep, startRecording, writeWebp } from '../../_shared/gallery-e2e.mjs';

const record = process.argv.includes('--record');
/** @type {{name: string, ok: boolean, detail: unknown}[]} */
const checks = [];
const check = (/** @type {string} */ name, /** @type {boolean} */ ok, /** @type {unknown} */ detail) => { checks.push({ name, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}  ${JSON.stringify(detail)}`); };

const FORM_PROBE = `(() => {
  const form = document.getElementById('demo-form');
  window.__formEvents = {};
  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'click', 'mousedown', 'mouseup', 'focusin', 'focusout', 'selectstart']) {
    form.addEventListener(t, () => { window.__formEvents[t] = (window.__formEvents[t] || 0) + 1; }, true);
  }
})()`;
const formState = (/** @type {any} */ page) => page.evaluate(`({ events: window.__formEvents, active: document.activeElement && document.activeElement.id, selection: String(getSelection()), email: document.getElementById('email').value })`);
/** the computed cursor of the element under a viewport point @param {any} page @param {number} x @param {number} y */
const cursorAt = (page, x, y) => page.evaluate(`(() => { const el = document.elementFromPoint(${x}, ${y}); return el ? getComputedStyle(el).cursor : null; })()`);

/** pixels of the back of the sheet / the page beneath (cream paper) in the top-right `size` x `size` px of a canvas shot */
function paperTopRight(/** @type {any} */ img, size = 160) {
  let n = 0;
  for (let y = 0; y < Math.min(size, img.height); y += 1) {
    for (let x = Math.max(0, img.width - size); x < img.width; x += 1) {
      const k = (y * img.width + x) * 4;
      if (img.data[k] > 150 && img.data[k + 1] > 140 && img.data[k + 2] > 120 && img.data[k] >= img.data[k + 2]) n += 1;
    }
  }
  return n;
}

async function main() {
  // ------------------------------------------------------------------------------------------------------------- normal motion
  const g = await openGallery('page-curl');
  const { page } = g;
  console.log(`Chrome ${g.chrome}, plugin bundle ${g.bundle.bytes} bytes (minified)`);
  try {
    const st = await page.evaluate(`({ controls: !!document.querySelector('#effect-controls .hic-curl-ui'), hint: (document.querySelector('#effect-controls .hic-curl-hint') || {}).textContent, mode: window.__gallery.mode })`);
    check('the gallery runs the effect and mounts the plugin controls with the hint label inside the drawn form',
      st.mode === 'effect' && st.controls && /Drag the top-right corner/.test(st.hint), st);
    const c = await rectOf(page, '#stage');

    // zero work at rest: with the defaults nothing moves and nothing is drawn once the page has settled (no auto-peek, no timer)
    await idle(page);
    const restPaper = paperTopRight((await shot(page)).img);
    const idleFrames = await framesDuring(page, 3000);
    check('at rest the top-right corner is a dog-ear (paper visible there)', restPaper > 300, { restPaper });
    // control: the opt-in auto-peek (every second) is periodic work, and the same count sees it
    await page.evaluate(`window.__gallery.handle.setOptions({ autoPeek: 1 })`);
    const peekFrames = await framesDuring(page, 3000);
    await page.evaluate(`window.__gallery.handle.setOptions({ autoPeek: 0 })`);
    await sleep(1900);
    check('zero work at rest: no effect frame in 3 s once settled (control: the opt-in autoPeek 1 presents frames in the same 3 s)', idleFrames === 0 && peekFrames >= 20, { idleFrames, peekFrames });

    const email = await rectOf(page, '#email');
    await page.click(email.cx, email.cy);
    await sleep(200);
    await page.typeText('x');
    await sleep(150);
    let s = await formState(page);
    check('flat page: a trusted click focuses the drawn email field and typing reaches it', s.active === 'email' && s.email === 'ada@example.comx', s);

    await page.evaluate(`document.getElementById('stage').frameCap = 120`);
    await page.mouseMove(c.cx, c.cy);
    await sleep(600);
    const corner = [c.x + c.w - 14, c.y + 14];
    const awayCursor = await cursorAt(page, c.cx, c.cy + 60);
    await page.mouseMove(corner[0], corner[1]);   // hovering is not part of the drag: the form may see this move
    await sleep(600);
    const hoverCursor = await cursorAt(page, corner[0], corner[1]);
    const hoverPaper = paperTopRight((await shot(page)).img);
    check('hovering the hot zone lifts the dog-ear further and the cursor becomes grab', hoverCursor === 'grab' && awayCursor !== 'grab' && hoverPaper > 1.5 * restPaper,
      { hoverCursor, awayCursor, hoverPaper, restPaper });

    await page.evaluate(FORM_PROBE);
    const before = (await shot(page)).img;
    // a human-speed drag (16 ms between moves, about a second) from the dog-ear towards the lower left
    const path = Array.from({ length: 50 }, (_, i) => [corner[0] - (i / 49) * (c.w * 0.5), corner[1] + (i / 49) * (c.h * 0.5) + Math.sin((i / 49) * Math.PI) * 30]);
    let dragCursor = null;
    const fd = await page.evaluate('window.__e2e.frames');
    const t0 = Date.now();
    await drag(page, path, { stepMs: 16, release: false, hover: false, onStep: async (i) => { if (i === 30) dragCursor = await cursorAt(page, path[i][0], path[i][1]); } });
    const dragFrames = (await page.evaluate('window.__e2e.frames')) - fd;
    const dragMs = Date.now() - t0;
    await sleep(700);   // the corner settles under the pointer
    const held = (await shot(page)).img;
    const curled = changed(held, before);
    check('dragging the dog-eared top-right corner curls the page (presented pixels change, paper shows)',
      curled.px > 0.12 * c.w * c.h && paperTopRight(held, 500) > 20000, { ...curled, paper: paperTopRight(held, 500) });
    check('during the drag the cursor is grabbing', dragCursor === 'grabbing', { dragCursor });
    s = await formState(page);
    check('during the drag nothing reaches the form: no pointer/mouse/focus/selectstart event, focus and value unchanged, no selection',
      Object.keys(s.events).length === 0 && s.active === 'email' && s.selection === '' && s.email === 'ada@example.comx', s);
    check('the drag is presented frame by frame (effect frames during the drag, frame cap 120)', dragFrames >= 20, { frames: dragFrames, ms: dragMs, fps: Math.round((dragFrames * 1000) / dragMs) });

    // the page stays live while it is curled: typing goes to the focused field (the email field, on the folded flap now), and its text
    // changes on the back of the curled sheet, mirrored, away from where the field lies flat
    const quietHeld = (await shot(page)).img;
    await page.typeText('yz live');
    await sleep(500);
    const typed = changed((await shot(page)).img, quietHeld);
    s = await formState(page);
    const fieldAt = { x: email.x - c.x, y: email.y - c.y, w: email.w, h: email.h };
    const tcx = typed.box ? typed.box.x + typed.box.w / 2 : -1, tcy = typed.box ? typed.box.y + typed.box.h / 2 : -1;
    const elsewhere = !(tcx > fieldAt.x && tcx < fieldAt.x + fieldAt.w && tcy > fieldAt.y && tcy < fieldAt.y + fieldAt.h);
    check('while the page is held curled, trusted typing reaches the focused field and the typed text appears on the curled sheet (mirrored, away from the field\'s flat place)',
      s.email === 'ada@example.comxyz live' && typed.px > 60 && elsewhere, { email: s.email, changed: typed, field: fieldAt });

    const lastPt = path[path.length - 1];
    await page.mouseUp(lastPt[0], lastPt[1]);
    const releaseFrames = await framesDuring(page, 1200);
    s = await formState(page);
    check('release: the pointerup and the click that follows never reach the form; focus, value and selection unchanged',
      Object.keys(s.events).length === 0 && s.active === 'email' && s.selection === '', s);

    const name = await rectOf(page, '#name');
    await page.click(name.cx, name.cy);
    await sleep(200);
    s = await formState(page);
    check('after the release a click maps to the field the user sees again (name focused)', s.active === 'name', { active: s.active });

    await page.evaluate(`document.activeElement && document.activeElement.blur()`);
    await page.mouseMove(c.cx, c.cy + 60);
    await sleep(800);
    const rest = (await shot(page)).img;
    const restAfter = paperTopRight(rest);
    check('release: the page springs back on its own (animation frames) to the dog-ear at rest', releaseFrames >= 10 && Math.abs(restAfter - restPaper) < 0.25 * restPaper,
      { releaseFrames, restPaper, restAfter });
    const quiet = await framesDuring(page, 5600);
    check('after the drag: no frame in 5.6 s at rest', quiet === 0, { frames: quiet });
    // the actions of the effect handle, as a page uses them (the gallery's buttons call handle.trigger): the hint on demand, and the demo
    // (the page turns most of the way over, mid-way at about 1.1 s)
    await actionChecks(page, check, [{ action: 'peek', state: 'rest', midMs: 900, minChanged: 1000 }, { action: 'demo', state: 'rest', midMs: 1100, minChanged: 0.2 * c.w * c.h }],
      { older: 'demo', newer: 'peek', state: 'rest' });
    await idle(page);
    check('after the demo: zero work at rest (no frame in 3 s)', (await framesDuring(page, 3000)) === 0, {});
    // a press on the page takes over from the demo at once: the hand lets go and the page springs back long before the demo would end
    await page.evaluate(`window.__demoRun = { t0: performance.now() }; window.__gallery.handle.trigger('demo').then((s) => { window.__demoRun.state = s; window.__demoRun.ms = performance.now() - window.__demoRun.t0; }); true`);   // true: do not wait for the trigger here
    await sleep(700);
    const nameNow = await rectOf(page, '#name');
    await page.click(nameNow.cx, nameNow.cy);
    await sleep(1500);
    const cut = await page.evaluate('window.__demoRun');
    s = await formState(page);
    check('a press during the demo takes over at once: the demo resolves rest well before its 3 s, and the press reaches the field under it', cut.state === 'rest' && cut.ms < 2000 && s.active === 'name', { ...cut, active: s.active });

    await page.evaluate(`document.getElementById('stage').frameCap = 30`);
    await sleep(300);
    const capPath = Array.from({ length: 60 }, (_, i) => [c.x + 3 + i * 6, c.y + c.h - 3 - i * 3]);
    const fc0 = await page.evaluate('window.__e2e.frames');
    const tc = Date.now();
    await drag(page, capPath, { stepMs: 16 });
    const capFps = ((await page.evaluate('window.__e2e.frames')) - fc0) * 1000 / (Date.now() - tc);
    check('frame cap 30: the drag of the bottom-left corner is presented at no more than ~30 frames per second', capFps <= 34 && capFps >= 10, { fps: Math.round(capFps * 10) / 10 });
    await sleep(1500);
    const errors = [...page.errors({ includeWarnings: false }).map((/** @type {any} */ e) => e.text), ...(await page.evaluate('window.__e2e.errors'))];
    check('no console error, page exception or effecterror', errors.length === 0, errors.slice(0, 3));
  } finally {
    await g.close();
  }

  // ------------------------------------------------------------------------------------------------------------- reduced motion
  const r = await openGallery('page-curl', { reducedMotion: true });
  try {
    const c = await rectOf(r.page, '#stage');
    const flat = (await shot(r.page)).img;
    const still = await framesDuring(r.page, 3500);
    const dogEar = paperTopRight(flat);
    check('prefers-reduced-motion: the dog-ear is there and still (no auto-peek: no frame in 3.5 s)', dogEar > 300 && still <= 2, { dogEar, frames: still });
    await drag(r.page, Array.from({ length: 16 }, (_, i) => [c.x + c.w - 3 - i * 25, c.y + c.h - 3 - i * 15]), { stepMs: 16, release: false });
    await sleep(100);
    const curled = changed((await shot(r.page)).img, flat).px;
    await r.page.mouseUp(c.x + c.w - 378, c.y + c.h - 228);
    const frames = await framesDuring(r.page, 500);
    const back = changed((await shot(r.page)).img, flat).px;
    check('prefers-reduced-motion: the drag still curls (it follows the hand); the release lays the page back at once, without animation frames',
      curled > 0.08 * c.w * c.h && frames <= 3 && back < 0.002 * c.w * c.h, { curledPx: curled, framesAfterRelease: frames, differingPx: back });
    const state = await r.page.evaluate(`window.__gallery.handle.trigger('peek')`);
    const later = await framesDuring(r.page, 1000);
    check('prefers-reduced-motion: the action peek opens nothing and resolves rest at once', state === 'rest' && later <= 2, { state, frames: later });
    const demoState = await r.page.evaluate(`window.__gallery.handle.trigger('demo')`);
    const demoLater = await framesDuring(r.page, 1500);
    check('prefers-reduced-motion: the action demo turns nothing and resolves rest at once', demoState === 'rest' && demoLater <= 2, { state: demoState, frames: demoLater });
  } finally {
    await r.close();
  }

  // ------------------------------------------------------------------------------------------------------------- touch
  // Chrome's touch emulation: trusted touch events (Input.dispatchTouchEvent), the browser's own scroll and pointer pipeline
  const tg = await openGallery('page-curl', { height: 700 });
  try {
    const { page } = tg;
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await page.evaluate(`(() => { window.__touch = { cancel: 0, down: 0 }; addEventListener('pointercancel', () => { window.__touch.cancel += 1; }, true); addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') window.__touch.down += 1; }, true); })()`);
    await page.evaluate(`document.getElementById('stage').scrollIntoView({ block: 'center' })`);
    await sleep(400);
    await idle(page);
    /** a finger along a path @param {number[][]} pts */
    const finger = async (pts) => {
      await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pts[0][0], y: pts[0][1] }] });
      for (const [x, y] of pts.slice(1)) { await sleep(16); await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] }); }
      return async () => { await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); };
    };
    let c = await rectOf(page, '#stage');
    const before = (await shot(page)).img;
    const y0 = await page.evaluate('scrollY');
    const lift = await finger(Array.from({ length: 30 }, (_, i) => [c.x + c.w - 12 - i * c.w * 0.016, c.y + 12 + i * c.h * 0.016]));
    await sleep(500);
    const held = (await shot(page)).img;
    const yHeld = await page.evaluate('scrollY');
    const t1 = await page.evaluate('window.__touch');
    await lift();
    const curledPx = changed(held, before).px;
    check('touch: a finger on the top-right corner turns the page (the sheet follows it) and the page does not scroll; no pointercancel',
      t1.down === 1 && t1.cancel === 0 && yHeld === y0 && curledPx > 0.05 * c.w * c.h && paperTopRight(held, 400) > 8000, { ...t1, scrolled: yHeld - y0, curledPx });
    await sleep(1500);
    await idle(page);
    c = await rectOf(page, '#stage');
    const y1 = await page.evaluate('scrollY');
    const flat = (await shot(page)).img;
    const away = await finger(Array.from({ length: 30 }, (_, i) => [c.cx, c.cy - 80 + i * 6]));
    await away();
    await sleep(800);
    const y2 = await page.evaluate('scrollY');
    const t2 = await page.evaluate('window.__touch');
    c = await rectOf(page, '#stage');
    check('touch: a finger anywhere else scrolls the page as usual (control: the same gesture from the middle of the stage)', y2 < y1 - 40 && t2.cancel >= 1, { scrolled: y2 - y1, cancel: t2.cancel });
    await page.evaluate(`document.getElementById('stage').scrollIntoView({ block: 'center' })`);
    await sleep(600);
    await idle(page);
    const back = changed((await shot(page)).img, flat).px;
    check('touch: the scroll did not curl the page', back < 0.002 * c.w * c.h, { differingPx: back });
  } finally {
    await tg.close();
  }

  // ------------------------------------------------------------------------------------------------------------- the recording
  if (record) {
    const rec = await openGallery('page-curl');
    try {
      const { page } = rec;
      const c = await rectOf(page, '#stage');
      await page.evaluate(`document.getElementById('stage').frameCap = 120`);
      const msg = await rectOf(page, '#message');
      await page.click(msg.x + msg.w - 20, msg.y + msg.h - 14);   // the caret at the end of the message
      const stop = await startRecording(page);
      await sleep(700);                                         // the dog-ear at rest
      await page.evaluate(`window.__gallery.handle.trigger('demo'); true`);
      await sleep(3200);                                        // the demo: the page turns most of the way and springs back
      const corner = [c.x + c.w - 14, c.y + 14];
      await page.mouseMove(corner[0] - 30, corner[1] + 40);
      await sleep(150);
      await page.mouseMove(corner[0], corner[1]);              // the hover lift
      await sleep(700);
      const arc = Array.from({ length: 60 }, (_, i) => [corner[0] - (i / 59) * c.w * 0.64, corner[1] + (i / 59) * c.h * 0.6 + Math.sin((i / 59) * Math.PI) * 50]);
      await drag(page, arc, { stepMs: 18, release: false, hover: false });
      await page.typeText(' It stays live while it curls.', { intervalMs: 45 });   // typed while held: the back of the sheet shows it
      await sleep(500);
      await page.mouseUp(arc[59][0], arc[59][1]);
      await sleep(1100);
      const bl = [c.x + 12, c.y + c.h - 12];
      await page.mouseMove(bl[0], bl[1]);
      await sleep(500);
      const arc2 = Array.from({ length: 44 }, (_, i) => [bl[0] + (i / 43) * c.w * 0.5, bl[1] - (i / 43) * c.h * 0.55 - Math.sin((i / 43) * Math.PI) * 40]);
      await drag(page, arc2, { stepMs: 18, release: false, hover: false });
      await sleep(400);
      await page.mouseUp(arc2[43][0], arc2[43][1]);
      await page.mouseMove(c.cx, c.cy);
      await sleep(1200);
      const frames = await stop();
      const bytes = writeWebp(frames, join(ROOT, 'plugins/page-curl/media/page-curl.webp'), { x: c.x, y: c.y, w: c.w, h: c.h }, { quality: 72 });
      check('recording: media/page-curl.webp under 900 KB', bytes < 900 * 1024, { screencastFrames: frames.length, bytes });
    } finally {
      await rec.close();
    }
  }
  const failed = checks.filter((x) => !x.ok);
  console.log(`\npage-curl gallery click-through: ${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(2); });
