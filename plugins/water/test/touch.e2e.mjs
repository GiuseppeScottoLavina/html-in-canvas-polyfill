#!/usr/bin/env node
// The water plugin and a finger, in the plugin gallery in headless Chrome with touch emulation (trusted CDP touch events): a tap on the
// stage makes a drop (the water renders); a finger drag that starts on the stage scrolls the page (the water never claims the gesture),
// and while it scrolls the finger keeps stirring the water (its touch moves, which go on during the scroll; control: the same scroll with
// the touch moves stopped before they reach the canvas comes to rest much earlier). Positive control of the scroll: the same drag with a
// non-passive touchstart listener that calls preventDefault() on the canvas and its live layer (what a plugin that claims the gesture does)
// does not scroll.
//   npm run build && node plugins/water/test/touch.e2e.mjs     (`npm run test:plugins` runs every gallery e2e)
import { checklist, framesDuring, idle, openGallery, rectOf, sleep } from '../../_shared/gallery-e2e.mjs';

const c = checklist('water touch e2e');
const g = await openGallery('water');
const { page } = g;
try {
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  // room to scroll below the gallery
  await page.evaluate(`(() => { const s = document.createElement('div'); s.style.height = (innerHeight * 3) + 'px'; document.body.append(s); return true; })()`);
  await idle(page, 600, 12000);
  const stage = await rectOf(page, '#stage');
  const touch = (/** @type {string} */ type, /** @type {number} */ x, /** @type {number} */ y) => page.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });

  const tapAt = { x: stage.x + stage.w * 0.3, y: stage.y + stage.h * 0.82 };
  const frames = framesDuring(page, 600);
  await touch('touchStart', tapAt.x, tapAt.y);
  await sleep(40);
  await touch('touchEnd', tapAt.x, tapAt.y);
  const tapFrames = await frames;
  c.check('a tap on the water makes a drop: the water renders', tapFrames > 10, { effectFrames: tapFrames });
  await idle(page, 400, 8000);

  /** a finger drag upwards that starts on the stage; returns how far the page scrolled */
  const drag = async () => {
    await page.evaluate('window.scrollTo(0, 0)');
    await page.evaluate(`document.getElementById('stage').scrollIntoView({ block: 'start' })`);
    await sleep(300);
    const r = await rectOf(page, '#stage');
    const y0 = await page.evaluate('scrollY');
    const x = r.x + r.w * 0.3, y = r.y + r.h * 0.8;
    await touch('touchStart', x, y);
    for (let i = 1; i <= 12; i += 1) { await touch('touchMove', x, y - i * 25); await sleep(16); }
    await touch('touchEnd', x, y - 300);
    await sleep(500);
    return (await page.evaluate('scrollY')) - y0;
  };
  const scrolled = await drag();
  c.check('a finger drag that starts on the water scrolls the page (the plugin never claims the gesture)', scrolled > 100, { scrolledPx: scrolled });
  await idle(page, 400, 8000);

  /** a slow finger scroll of 1.2 s that starts on the stage: how far the page scrolled, and the time from the lift to the last effect frame (the water at rest) */
  const longScroll = async () => {
    await page.evaluate('window.scrollTo(0, 0)');
    await page.evaluate(`document.getElementById('stage').scrollIntoView({ block: 'start' })`);
    await idle(page, 400, 8000);
    const r = await rectOf(page, '#stage');
    const y0 = await page.evaluate('scrollY');
    const x = r.x + r.w * 0.3, y = r.y + r.h * 0.85;
    await touch('touchStart', x, y);
    for (let i = 1; i <= 60; i += 1) { await touch('touchMove', x, y - i * 6); await sleep(20); }
    await touch('touchEnd', x, y - 360);
    const lift = await page.evaluate('performance.now()');
    await idle(page, 500, 10000);
    return { scrolledPx: (await page.evaluate('scrollY')) - y0, stirredMsAfterLift: Math.round((await page.evaluate('window.__e2e.last')) - lift) };
  };
  const stirred = await longScroll();
  // control: the same scroll with the touch moves kept from the canvas and its layer (a window capture listener stops them; pointer events still arrive until the scroll starts)
  await page.evaluate(`window.addEventListener('touchmove', (e) => e.stopPropagation(), { capture: true, passive: true }); true`);
  const unstirred = await longScroll();
  c.check('a finger that scrolls the page keeps stirring the water: it moves on well after the lift (the touch moves go on during the scroll)', stirred.scrolledPx > 100 && stirred.stirredMsAfterLift > unstirred.stirredMsAfterLift + 600, { stirred, unstirred });
  c.check('control: without the touch moves only the drop of the touch start shows; the water comes to rest early', unstirred.scrolledPx > 100 && unstirred.stirredMsAfterLift < stirred.stirredMsAfterLift, unstirred);
  await page.evaluate(`(() => {
    const block = (e) => e.preventDefault();
    for (const el of [document.getElementById('stage'), document.querySelector('hic-layer') || document.getElementById('demo-form')]) el.addEventListener('touchstart', block, { passive: false });
    return true;
  })()`);
  const blocked = await drag();
  c.check('control: with a non-passive touchstart that calls preventDefault() the same drag does not scroll', blocked < 20, { scrolledPx: blocked });
  const errors = [...page.errors({ includeWarnings: false }).map((/** @type {any} */ e) => e.text), ...(await page.evaluate('window.__e2e.errors'))];
  c.check('no console error, page exception or effecterror', errors.length === 0, errors.slice(0, 3));
} finally {
  await g.close();
}
c.finish();
