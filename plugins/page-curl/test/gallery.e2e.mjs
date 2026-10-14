#!/usr/bin/env node
// Gallery click-through of the page-curl plugin in headless Chrome with trusted input (CDP), on examples/plugins/?effect=page-curl:
// the flat page takes clicks and typing, a corner drag peels the page and NOTHING of the drag reaches the form (no pointer/mouse event,
// no click, no focus change, no selection), the release springs back to the flat page and clicks map again, the hover lift, the frame
// cap, and prefers-reduced-motion. `--record` also writes media/page-curl.webp.
//
//   npm run build   (the bundles; `npm run test:plugins` runs every gallery e2e)
//   node plugins/page-curl/test/gallery.e2e.mjs [--record]
import { join } from 'node:path';
import { ROOT, changed, drag, framesDuring, openGallery, rectOf, shot, sleep, startRecording, writeWebp } from '../../_shared/gallery-e2e.mjs';

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
const formState = (/** @type {any} */ page) => page.evaluate(`({ events: window.__formEvents, active: document.activeElement && document.activeElement.id, selection: String(getSelection()), name: document.getElementById('name').value })`);

async function main() {
  // ------------------------------------------------------------------------------------------------------------- normal motion
  const g = await openGallery('page-curl');
  const { page } = g;
  console.log(`Chrome ${g.chrome}, plugin bundle ${g.bundle.bytes} bytes (minified)`);
  try {
    const st = await page.evaluate(`({ controls: !!document.querySelector('#effect-controls .hic-curl-ui'), mode: window.__gallery.mode })`);
    check('the gallery runs the effect and mounts the plugin controls inside the drawn form', st.mode === 'effect' && st.controls, st);
    const c = await rectOf(page, '#stage');
    const name = await rectOf(page, '#name');
    await page.click(name.cx, name.cy);
    await sleep(200);
    await page.typeText('x');
    await sleep(150);
    let s = await formState(page);
    check('flat page: a trusted click focuses the drawn name field and typing reaches it', s.active === 'name' && s.name === 'Adax', s);

    await page.evaluate(`document.getElementById('stage').frameCap = 120`);
    const corner = [c.x + c.w - 3, c.y + c.h - 3];
    await page.mouseMove(corner[0], corner[1]);   // hovering is not part of the drag: the form may see this move
    await sleep(400);
    await page.evaluate(FORM_PROBE);
    const before = (await shot(page)).img;
    const path = Array.from({ length: 31 }, (_, i) => [corner[0] - (i / 30) * (c.w * 0.55), corner[1] - (i / 30) * (c.h * 0.45) - Math.sin((i / 30) * Math.PI) * 40]);
    let mid = null;
    const f0 = await page.evaluate('window.__e2e.frames');
    const t0 = Date.now();
    await drag(page, path, { stepMs: 16, release: false, hover: false, onStep: async (i) => { if (i === 30) mid = (await shot(page)).img; } });
    const dragFrames = (await page.evaluate('window.__e2e.frames')) - f0;
    const dragMs = Date.now() - t0;
    const curled = changed(mid, before);
    check('dragging the bottom-right corner peels the page (presented pixels change)', curled.px > 0.15 * c.w * c.h, curled);
    s = await formState(page);
    check('during the drag nothing reaches the form: no pointer/mouse/focus/selectstart event, focus and value unchanged, no selection',
      Object.keys(s.events).length === 0 && s.active === 'name' && s.selection === '' && s.name === 'Adax', s);
    check('the drag is presented frame by frame (effect frames during the drag, frame cap 120)', dragFrames >= 20, { frames: dragFrames, ms: dragMs, fps: Math.round((dragFrames * 1000) / dragMs) });

    const last = path[path.length - 1];
    await page.mouseUp(last[0], last[1]);
    const releaseFrames = await framesDuring(page, 700);
    const after = (await shot(page)).img;
    const back = changed(after, before);
    s = await formState(page);
    check('release: the page springs back on its own (animation frames) to the flat picture', releaseFrames >= 10 && back.px < 0.002 * c.w * c.h, { releaseFrames, differing: back });
    check('release: the pointerup and the click that follows never reach the form; focus, value and selection unchanged',
      Object.keys(s.events).length === 0 && s.active === 'name' && s.selection === '' && s.name === 'Adax', s);

    const email = await rectOf(page, '#email');
    await page.click(email.cx, email.cy);
    await sleep(200);
    s = await formState(page);
    check('after the release a click maps to the field the user sees again (email focused)', s.active === 'email', { active: s.active });

    await page.evaluate(`document.activeElement && document.activeElement.blur()`);
    await page.mouseMove(c.cx, c.cy);
    await sleep(400);
    const rest = (await shot(page)).img;
    await page.mouseMove(c.x + 6, c.y + 6);
    await sleep(400);
    const lifted = changed((await shot(page)).img, rest);
    await page.mouseMove(c.cx, c.cy);
    await sleep(400);
    const laid = changed((await shot(page)).img, rest);
    check('hovering a corner hot zone lifts that corner a little (the grab affordance), leaving it lays it flat again',
      lifted.px > 200 && !!lifted.box && lifted.box.x + lifted.box.w < 80 && lifted.box.y + lifted.box.h < 80 && laid.px < 50, { lifted, afterLeaving: laid });

    await page.evaluate(`document.getElementById('stage').frameCap = 30`);
    await sleep(300);
    const capPath = Array.from({ length: 60 }, (_, i) => [c.x + 3 + i * 6, c.y + 3 + i * 3]);
    const fc0 = await page.evaluate('window.__e2e.frames');
    const tc = Date.now();
    await drag(page, capPath, { stepMs: 16 });
    const capFps = ((await page.evaluate('window.__e2e.frames')) - fc0) * 1000 / (Date.now() - tc);
    check('frame cap 30: the drag is presented at no more than ~30 frames per second', capFps <= 34 && capFps >= 10, { fps: Math.round(capFps * 10) / 10 });
    await sleep(600);
    const errors = await page.evaluate('window.__e2e.errors');
    check('no effecterror', errors.length === 0, errors);

    if (record) {
      await page.evaluate(`document.getElementById('stage').frameCap = 120`);
      await page.mouseMove(c.cx, c.cy);
      await sleep(400);
      const stop = await startRecording(page);
      await sleep(500);
      await page.mouseMove(corner[0] - 12, corner[1] - 12);   // the hover lift
      await sleep(700);
      const arc = Array.from({ length: 40 }, (_, i) => [corner[0] - 12 - (i / 39) * c.w * 0.62, corner[1] - 12 - (i / 39) * c.h * 0.5 - Math.sin((i / 39) * Math.PI) * 70]);
      await drag(page, arc, { stepMs: 22, release: false, hover: false });
      await sleep(350);
      await page.mouseUp(arc[39][0], arc[39][1]);
      await sleep(900);
      const tl = [c.x + 8, c.y + 8];
      await page.mouseMove(tl[0], tl[1]);
      await sleep(500);
      const arc2 = Array.from({ length: 32 }, (_, i) => [tl[0] + (i / 31) * c.w * 0.42, tl[1] + (i / 31) * c.h * 0.6 + Math.sin((i / 31) * Math.PI) * 50]);
      await drag(page, arc2, { stepMs: 22, release: false, hover: false });
      await sleep(350);
      await page.mouseUp(arc2[31][0], arc2[31][1]);
      await sleep(900);
      const frames = await stop();
      const bytes = writeWebp(frames, join(ROOT, 'plugins/page-curl/media/page-curl.webp'), { x: c.x, y: c.y, w: c.w, h: c.h });
      check('recording: media/page-curl.webp under 500 KB', bytes < 500 * 1024, { screencastFrames: frames.length, bytes });
    }
  } finally {
    await g.close();
  }

  // ------------------------------------------------------------------------------------------------------------- reduced motion
  const r = await openGallery('page-curl', { reducedMotion: true });
  try {
    const c = await rectOf(r.page, '#stage');
    const flat = (await shot(r.page)).img;
    await drag(r.page, Array.from({ length: 16 }, (_, i) => [c.x + c.w - 3 - i * 25, c.y + c.h - 3 - i * 15]), { stepMs: 16, release: false });
    const curled = changed((await shot(r.page)).img, flat).px;
    await r.page.mouseUp(c.x + c.w - 378, c.y + c.h - 228);
    const frames = await framesDuring(r.page, 500);
    const back = changed((await shot(r.page)).img, flat).px;
    check('prefers-reduced-motion: the drag still peels (it follows the hand); the release lays the page flat at once, without animation frames',
      curled > 0.08 * c.w * c.h && frames <= 3 && back < 0.002 * c.w * c.h, { curledPx: curled, framesAfterRelease: frames, differingPx: back });
  } finally {
    await r.close();
  }
  const failed = checks.filter((x) => !x.ok);
  console.log(`\npage-curl gallery click-through: ${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(2); });
