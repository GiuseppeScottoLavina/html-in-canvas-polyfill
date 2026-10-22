// The gallery end-to-end test of a TRANSITION plugin (disintegrate, shatter): examples/plugins/ in headless Chrome with trusted input
// (CDP Input.*). Idle click-through (click the name field, type), a trusted click on Submit plays the transition, a trusted click DURING
// the transition focuses nothing (the plugin's mapper returns NO_TARGET, the host swallows the press), the form comes back and is usable
// again, plus what each plugin adds (`extra`). --record also writes plugins/<name>/media/<name>.webp.
// Needs the built bundles (`npm run build`); `npm run test:plugins` runs every gallery e2e.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { compareImages, pixelStats, sleep } from '../../test/harness/index.mjs';
import { ROOT, checklist, clickOn, idle, openGallery, rectOf, shot, startRecording, writeWebp } from './gallery-e2e.mjs';

/**
 * @typedef {Object} TransitionPlan
 * @property {string} name  the plugin
 * @property {string} submitLabel  what the Submit click is expected to do (check name)
 * @property {(page: any) => Promise<void>} [beforeSubmit]  e.g. make the form invalid
 * @property {number} midMs  when, after the Submit click, the frame is compared with the idle one
 * @property {(page: any) => Promise<{ok: boolean, name: string, detail?: unknown}>} formState  the page's own state after the Submit
 * @property {string} backLabel  the check name for "the form is back"
 * @property {(page: any, c: ReturnType<typeof checklist>) => Promise<void>} [extra]  further checks after the round trip
 * @property {(page: any) => Promise<void>} recordAction  what --record films (it waits until the transition ended)
 */

/** @param {TransitionPlan} plan */
export async function runTransitionGalleryE2E(plan) {
  const c = checklist(`${plan.name} gallery e2e`);
  const g = await openGallery(plan.name, { width: 1100, height: 1000 });
  const { page } = g;
  console.log(`Chrome ${g.chrome}, plugin bundle ${g.bundle.bytes} bytes (minified)`);
  const active = () => page.evaluate('document.activeElement && document.activeElement.id');
  try {
    c.check('the gallery is ready with the plugin applied', true, await page.evaluate('({ mode: window.__gallery.mode, active: window.__gallery.active })'));
    c.check('the intro ends: the host stops rendering (idle, not continuous)', await idle(page));
    const before = (await shot(page)).img;
    c.check('idle frame is not blank', pixelStats(before).nonBlank);

    await clickOn(page, '#name'); await sleep(150);
    c.check('idle: a trusted click focuses the drawn name field', (await active()) === 'name', await page.evaluate(`(() => { const r = document.getElementById('name').getBoundingClientRect(); const top = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2)[0];
      return { active: document.activeElement && (document.activeElement.id || document.activeElement.localName), top: top && (top.id || top.localName), stats: window.__gallery.host && window.__gallery.host.stats() }; })()`));
    await page.typeText('x');
    c.check('idle: trusted typing reaches it', (await page.evaluate(`document.getElementById('name').value`)) === 'Adax');
    await idle(page);

    await plan.beforeSubmit?.(page);
    const t0 = Date.now();
    await clickOn(page, '#submit');
    await sleep(plan.midMs);
    const moved = compareImages((await shot(page)).img, before).countOver16;
    c.check(`${plan.submitLabel}: the frame ${plan.midMs} ms later differs`, moved > 5000, { changedPixels: moved });
    const focusedBefore = await active();
    await clickOn(page, '#message'); await sleep(60);
    c.check('during the transition a trusted click on the message field changes nothing: no focus change (NO_TARGET, swallowed by the host)',
      (await active()) === focusedBefore, { before: focusedBefore, after: await active() });
    const state = await plan.formState(page);
    c.check(state.name, state.ok, state.detail);
    c.check('the transition ends (idle again)', await idle(page), { ms: Date.now() - t0 });
    const after = (await shot(page)).img;
    const diff = compareImages(after, before).countOver16;
    c.check(plan.backLabel, pixelStats(after).nonBlank && diff < 0.03 * after.width * after.height, { changedPixels: diff });
    await clickOn(page, '#message'); await sleep(150);
    c.check('after the transition the form is usable again: the click focuses the message field', (await active()) === 'message');
    await page.typeText('!');
    c.check('and typing reaches it', /!$/.test(await page.evaluate(`document.getElementById('message').value`)));
    await idle(page);
    await plan.extra?.(page, c);

    // what scripts/check-examples.mjs asks of every plugin of the gallery: picked after "Effect off", its controls mount and the presented
    // pixels 900 ms later differ from "Effect off" (for a transition plugin that is its intro), and the frame is not blank
    const pick = async (/** @type {string} */ name) => {
      await clickOn(page, `#picker button[data-effect="${name}"]`);
      for (let i = 0; i < 80; i += 1) { if (await page.evaluate(`window.__gallery.active === ${JSON.stringify(name)}`)) return true; await sleep(100); }
      return false;
    };
    await page.evaluate(`document.activeElement && document.activeElement.blur()`);
    await page.evaluate('window.scrollTo(0, 0)');
    await pick('off'); await sleep(600);
    await page.evaluate(`document.getElementById('stage').scrollIntoView({ block: 'start' })`); await sleep(100);
    const off = (await shot(page)).img;
    await page.evaluate('window.scrollTo(0, 0)');
    await pick(plan.name);
    await page.evaluate(`document.getElementById('stage').scrollIntoView({ block: 'start' })`); await sleep(800);
    const on = (await shot(page)).img;
    const changedPx = compareImages(on, off).countOver16;
    const controls = await page.evaluate(`document.getElementById('effect-controls').children.length`);
    c.check('the gallery check of scripts/check-examples.mjs: selected after "Effect off", controls mounted, pixels changed at 900 ms, not blank', controls > 0 && changedPx > 300 && pixelStats(on).nonBlank, { controls, changed: changedPx });
    await idle(page);

    if (process.argv.includes('--record')) {
      await page.evaluate(`document.activeElement && document.activeElement.blur()`);
      await idle(page);
      const stage = await rectOf(page, '#stage');
      const stop = await startRecording(page);
      await sleep(300);
      await plan.recordAction(page);
      const frames = await stop();
      const out = join(ROOT, 'plugins', plan.name, 'media', `${plan.name}.webp`);
      mkdirSync(join(out, '..'), { recursive: true });
      const bytes = writeWebp(frames, out, { x: stage.x, y: stage.y, w: stage.w, h: stage.h }, { width: 520, fps: 12, quality: 35 });
      c.check(`recorded media/${plan.name}.webp (${frames.length} compositor frames)`, bytes < 500 * 1024, { kb: Math.round(bytes / 1024) });
    }
    const errors = [...page.errors({ includeWarnings: false }).map((/** @type {any} */ e) => e.text), ...(await page.evaluate('window.__e2e.errors'))];
    c.check('no console error, page exception or effecterror', errors.length === 0, errors.slice(0, 3));
  } finally {
    await g.close();
  }
  return c.finish();
}
