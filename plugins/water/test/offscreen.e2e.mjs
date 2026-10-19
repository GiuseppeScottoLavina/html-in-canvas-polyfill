#!/usr/bin/env node
// Off-screen pause of the effect host (docs/ARCHITECTURE.md ADR-G) in the plugin gallery with the water plugin (continuous), in headless
// Chrome: scrolled far out of view the host renders no effect frame and the renderer + GPU processes use less CPU; a source change made
// meanwhile is not uploaded until the resume; an action triggered off-screen still resolves; scrolled back with a jump, the first effect
// frame is rendered in the frame that shows the jump and already shows the changed source. Control: the same page with IntersectionObserver silenced
// keeps rendering off-screen (the measurement does see frames when there are any).
//   npm run build && node plugins/water/test/offscreen.e2e.mjs     (`npm run test:plugins` runs every gallery e2e)
import { checklist, openGallery, rectOf, shot, sleep } from '../../_shared/gallery-e2e.mjs';

const c = checklist('water off-screen pause e2e');

/** CPU time (ms) per process type of the browser. @param {any} browser */
async function cpuTimes(browser) {
  const { processInfo } = await browser.conn.send('SystemInfo.getProcessInfo');
  /** @type {Record<string, number>} */ const by = {};
  for (const p of processInfo) by[p.type] = (by[p.type] ?? 0) + p.cpuTime * 1000;
  return by;
}

/** Effect frames and renderer + GPU process CPU (% of one core) during `ms`. @param {any} page @param {any} browser @param {number} ms */
async function measure(page, browser, ms) {
  const f0 = await page.evaluate('window.__e2e.frames');
  const c0 = await cpuTimes(browser);
  const t0 = Date.now();
  await sleep(ms);
  const c1 = await cpuTimes(browser);
  const span = Date.now() - t0;
  const f1 = await page.evaluate('window.__e2e.frames');
  const pct = (/** @type {string} */ k) => Math.round((1000 * ((c1[k] ?? 0) - (c0[k] ?? 0))) / span) / 10;
  return { framesPerSecond: Math.round(((f1 - f0) * 10000) / span) / 10, rendererCpu: pct('renderer'), gpuCpu: pct('GPU') };
}

/** Make room below the gallery and scroll the canvas one viewport above the top of the viewport (twice the pause margin). @param {any} page */
async function scrollAway(page) {
  await page.evaluate(`(() => {
    if (!document.getElementById('e2e-spacer')) { const s = document.createElement('div'); s.id = 'e2e-spacer'; s.style.height = (innerHeight * 4) + 'px'; document.body.append(s); }
    const r = document.getElementById('stage').getBoundingClientRect();
    window.scrollTo(0, scrollY + r.bottom + innerHeight);
  })()`);
  await sleep(400);
  return page.evaluate(`document.getElementById('stage').getBoundingClientRect().bottom`);
}

const g = await openGallery('water');
const { page, browser } = g;
try {
  const stage = await rectOf(page, '#stage');
  await page.mouseMove(stage.x + 5, stage.y + stage.h - 5);
  await sleep(1000);
  /** share of red over blue in the presented canvas, and the share of pixels that are not near black @param {any} img */
  const colour = (img) => {
    let red = 0, blue = 0, lit = 0;
    for (let i = 0; i < img.data.length; i += 4) { red += img.data[i]; blue += img.data[i + 2]; if (img.data[i] + img.data[i + 1] + img.data[i + 2] > 60) lit += 1; }
    return { redOverBlue: Math.round((100 * red) / Math.max(1, blue)) / 100, litShare: Math.round((100 * lit) / (img.width * img.height)) / 100 };
  };
  const before = colour((await shot(page)).img);
  const visible = await measure(page, browser, 2000);
  c.check('on screen: the continuous water renders (about the 60 fps cap of the gallery)', visible.framesPerSecond > 40, visible);

  const bottom = await scrollAway(page);
  const off = await measure(page, browser, 2000);
  const stats = await page.evaluate('window.__gallery.host.stats()');
  c.check('scrolled one viewport out of view: no effect frame', off.framesPerSecond === 0, { canvasBottom: bottom, ...off });
  c.check('host.stats() reports the pause', stats.paused === true && stats.pauses >= 1, { paused: stats.paused, pauses: stats.pauses });
  const busyOn = visible.rendererCpu + visible.gpuCpu;
  const busyOff = off.rendererCpu + off.gpuCpu;
  c.check('renderer + GPU process CPU drop off-screen (below 60 % of the on-screen value)', busyOff < 0.6 * busyOn, { onScreen: busyOn, offScreen: busyOff });

  // an action triggered off-screen resolves (the paused host advances it at about 10 frames per second)
  const act = await page.evaluate(`(async () => { const t = performance.now(); const s0 = window.__gallery.host.stats(); const state = await window.__gallery.handle.trigger('drop');
    const s1 = window.__gallery.host.stats(); return { state, ms: Math.round(performance.now() - t), offscreenFrames: s1.offscreenFrames - s0.offscreenFrames, paused: s1.paused }; })()`);
  const rate = act.ms > 0 ? (1000 * act.offscreenFrames) / act.ms : Infinity;
  c.check("handle.trigger('drop') off-screen resolves 'calm', at about 10 frames per second", act.state === 'calm' && act.paused && act.offscreenFrames > 0 && rate <= 12, { ...act, framesPerSecond: Math.round(rate * 10) / 10 });
  await sleep(300);

  // the drawn form changes while the canvas cannot be seen: snapshots go on (as natively), the host does not upload or render
  const s1 = await page.evaluate('window.__gallery.host.stats()');
  await page.evaluate(`document.getElementById('demo-form').style.background = 'rgb(200, 40, 70)'`);
  await sleep(800);
  const s2 = await page.evaluate('window.__gallery.host.stats()');
  c.check('a source change off-screen is neither uploaded nor rendered while paused', s2.sourceVersion === s1.sourceVersion && s2.frames === s1.frames, { before: s1.sourceVersion, now: s2.sourceVersion, frames: s2.frames - s1.frames });

  // back with a jump: the first effect frame in the frame of the jump, already on the changed source
  const versionOff = s2.sourceVersion;
  await page.evaluate(`(() => {
    const R = (window.__resume = { rafs: [], effs: [] });
    const cv = document.getElementById('stage');
    cv.addEventListener('effectframe', (e) => { if (R.effs.length < 5) R.effs.push({ now: e.detail.now, version: e.detail.sourceVersion }); });
    const loop = (t) => { R.rafs.push(t); if (R.rafs.length < 12) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    cv.scrollIntoView({ block: 'start' });
  })()`);
  await sleep(500);
  const resume = await page.evaluate('window.__resume');
  const first = resume.effs[0];
  const framesUntil = first ? resume.rafs.filter((/** @type {number} */ t) => t <= first.now + 0.5).length : Infinity;
  // the jump runs in a task, so the frame that shows it dispatches the scroll event before its animation frame callbacks (visibility.js)
  c.check('scrolled back with a jump: the first effect frame is rendered in the very frame that shows the jump', framesUntil === 1, { framesUntil, rafs: resume.rafs.slice(0, 4), first });
  c.check('that first frame already shows the source as changed off-screen (a newer source version)', !!first && first.version !== null && first.version !== versionOff, { versionOff, first });
  const after = colour((await shot(page)).img);
  c.check('the presented canvas is not blank and shows the new red background (red over blue well above the dark blue form of before)', after.litShare > 0.5 && after.redOverBlue > 1.2 && after.redOverBlue > 2 * before.redOverBlue, { before, after });
  const again = await measure(page, browser, 1000);
  c.check('on screen again: the water renders at the cap again', again.framesPerSecond > 40 && !(await page.evaluate('window.__gallery.host.stats().paused')), again);
  const errors = [...page.errors({ includeWarnings: false }).map((/** @type {any} */ e) => e.text), ...(await page.evaluate('window.__e2e.errors'))];
  c.check('no console error, page exception or effecterror', errors.length === 0, errors.slice(0, 3));
} finally {
  await g.close();
}

// Control: IntersectionObserver silenced before the page loads (it never reports), so the host cannot know the canvas left the viewport.
const silenced = 'window.IntersectionObserver = class { constructor() {} observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };';
const k = await openGallery('water', { initScript: silenced });
try {
  await k.page.mouseMove(5, 5);
  await sleep(500);
  const bottom = await scrollAway(k.page);
  const off = await measure(k.page, k.browser, 2000);
  const paused = await k.page.evaluate('window.__gallery.host.stats().paused');
  c.check('control: with IntersectionObserver silenced the off-screen canvas keeps rendering (the frame count sees it)', off.framesPerSecond > 40 && paused === false, { canvasBottom: bottom, paused, ...off });
} finally {
  await k.close();
}
c.finish();
