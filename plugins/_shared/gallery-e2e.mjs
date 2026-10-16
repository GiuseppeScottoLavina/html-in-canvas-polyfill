// Page helpers of the plugin gallery end-to-end tests (plugins/*/test/*.e2e.mjs): open examples/plugins/ with one plugin selected in ONE
// headless Chrome (close() kills it: one browser at a time), drive it with trusted CDP input, read the presented canvas, and optionally
// record it into an animated WebP. They run against the BUILT bundles: `npm run build` first (`npm run test:plugins` runs every e2e).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, decodePng, compareImages, sleep } from '../../test/harness/index.mjs';
import { startServer } from '../../examples/serve.mjs';

export { compareImages, sleep };
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** The built bundle of a plugin, or a clear error when `npm run build` has not run. @param {string} name */
export function builtBundle(name) {
  const file = join(ROOT, 'dist/plugins', `${name}.iife.min.js`);
  if (!existsSync(join(ROOT, 'dist/plugins/manifest.json')) || !existsSync(file)) throw new Error(`dist/plugins/${name}.iife.min.js is missing: run \`npm run build\` first`);
  return { file, bytes: statSync(file).size };
}

/**
 * Open the gallery with this plugin selected, in a new headless Chrome. `window.__e2e` counts the presented effect frames (`frames`), the
 * time of the last one (`last`, performance.now()) and the effecterror events (`errors`).
 * @param {string} name
 * @param {{reducedMotion?: boolean, width?: number, height?: number}} [o]
 */
export async function openGallery(name, { reducedMotion = false, width = 1200, height = 980 } = {}) {
  const bundle = builtBundle(name);
  const server = await startServer();
  const browser = await launchChrome({ name: `${name}-e2e`, windowSize: [width, height + 100], dpr: 1, extraArgs: ['--headless=new', '--hide-scrollbars'] });
  browser.conn.sendTimeoutMs = 30000;
  const close = async () => { await browser.close().catch(() => browser.kill()); await server.close().catch(() => {}); };
  try {
    const page = await browser.newPage();
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    if (reducedMotion) await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await page.navigate(`${server.url}/examples/plugins/?effect=${name}`);
    await page.waitForFunction(`!!(window.__gallery && window.__gallery.ready && window.__gallery.active === ${JSON.stringify(name)})`, { timeout: 20000 });
    await page.evaluate(`(() => {
      const c = document.getElementById('stage');
      window.__e2e = { frames: 0, last: performance.now(), errors: [] };
      c.addEventListener('effectframe', () => { window.__e2e.frames += 1; window.__e2e.last = performance.now(); });
      c.addEventListener('effecterror', (e) => { window.__e2e.errors.push(String(e.detail && e.detail.error)); });
    })()`);
    await sleep(500);
    // the picker above grows with the manifest: scroll once it is laid out, so that the whole canvas is in the viewport
    await page.evaluate(`document.getElementById('stage').scrollIntoView({ block: 'start' })`);
    await sleep(200);
    return { page, browser, server, bundle, close, chrome: browser.version?.Browser };
  } catch (error) {
    await close();
    throw error;
  }
}

/** viewport rectangle of an element @param {any} page @param {string} selector */
export function rectOf(page, selector) {
  return page.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, sx: scrollX, sy: scrollY }; })()`);
}

/** a trusted click on an element's centre @param {any} page @param {string} selector */
export async function clickOn(page, selector) {
  const r = await rectOf(page, selector);
  await page.click(r.cx, r.cy);
}

/** pixels whose largest channel difference exceeds `tolerance` (dark-on-dark changes are a few levels), and their bounding box */
export function changed(/** @type {any} */ a, /** @type {any} */ b, tolerance = 4) {
  const r = compareImages(a, b, { tolerance, diffImage: false });
  return { px: r.countOver16, box: r.overBBox };
}

/** the presented canvas as decoded RGBA (compositor screenshot) @param {any} page */
export async function shot(page, scale = 1) {
  const r = await rectOf(page, '#stage');
  const buf = await page.screenshot({ clip: { x: r.x + r.sx, y: r.y + r.sy, width: r.w, height: r.h, scale } });   // clip: document coordinates
  return { img: decodePng(buf), png: buf };
}

/** effect frames presented during `ms` @param {any} page @param {number} ms */
export async function framesDuring(page, ms) {
  const a = await page.evaluate('window.__e2e.frames');
  await sleep(ms);
  return (await page.evaluate('window.__e2e.frames')) - a;
}

/** Wait until no effect frame was presented for `quietMs` (the host went idle); false after `timeoutMs`. @param {any} page */
export async function idle(page, quietMs = 400, timeoutMs = 10000) {
  const t = Date.now();
  for (;;) {
    if (await page.evaluate(`performance.now() - window.__e2e.last > ${quietMs}`)) return true;
    if (Date.now() - t > timeoutMs) return false;
    await sleep(50);
  }
}

/**
 * A trusted click on the gallery's button of a plugin action (each calls handle.trigger(action) and records window.__gallery.lastAction);
 * the button sits above the canvas, so the page is scrolled to it and then back to the canvas.
 * @param {any} page @param {string} action
 */
export async function clickAction(page, action) {
  const selector = `#about button[data-action="${action}"]`;
  await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center' })`);
  await sleep(80);
  await clickOn(page, selector);
  await page.evaluate(`document.getElementById('stage').scrollIntoView({ block: 'start' })`);
}

/** The result of the last gallery action button once its trigger settled: {action, state, error}, or null after `timeoutMs`. @param {any} page */
export async function actionResult(page, timeoutMs = 10000) {
  const t = Date.now();
  for (;;) {
    const r = await page.evaluate('window.__gallery.lastAction');
    if (r && r.done) return r;
    if (Date.now() - t > timeoutMs) return null;
    await sleep(50);
  }
}

/**
 * The actions of the selected plugin, as a page uses them: each step clicks the gallery's button of the action (trusted input; the button
 * calls handle.trigger) and checks that the presented frame changed while it ran (unless `moves: false`), that it resolves with the
 * expected state and that the host goes idle again. Then, from page script on window.__gallery.handle: an unknown action rejects with a
 * TypeError that lists the plugin's actions, a newer trigger resolves the pending one with null, and settled() reports the state at rest.
 * @param {any} page
 * @param {(name: string, ok: boolean, detail?: unknown) => unknown} check
 * @param {{action: string, state: string, moves?: boolean, midMs?: number, minChanged?: number}[]} steps
 * @param {{older: string, newer: string, state: string}} supersede  two actions triggered back to back, and the state the newer one ends in
 * @param {{continuous?: boolean}} [o]  continuous: the plugin renders every frame (water), so the host never goes idle and that is not checked
 */
export async function actionChecks(page, check, steps, supersede, { continuous = false } = {}) {
  const actions = await page.evaluate('window.__gallery.handle ? [...window.__gallery.handle.actions] : []');
  const buttons = await page.evaluate(`[...document.querySelectorAll('#about button[data-action]')].map((b) => b.dataset.action)`);
  check('the gallery lists the actions of the effect handle as buttons', actions.length > 0 && JSON.stringify(actions) === JSON.stringify(buttons), { actions, buttons });
  for (const { action, state, moves = true, midMs = 150, minChanged = 300 } of steps) {
    if (!continuous) await idle(page);
    const before = (await shot(page)).img;
    await clickAction(page, action);
    if (moves) {
      await sleep(midMs);
      const px = compareImages((await shot(page)).img, before).countOver16;
      check(`action '${action}' (the gallery's button, a trusted click): the frame ${midMs} ms later differs`, px > minChanged, { changedPixels: px });
    }
    const r = await actionResult(page);
    check(`action '${action}': handle.trigger resolves '${state}'`, !!r && r.action === action && r.state === state && !r.error, r);
    if (!continuous) check(`action '${action}': the host goes idle again`, await idle(page));
  }
  const unknown = await page.evaluate(`window.__gallery.handle.trigger('no-such-action').then(() => 'resolved', (e) => e.name + ': ' + e.message)`);
  check('an unknown action rejects with a TypeError that lists the actions of the plugin', /^TypeError: .*unknown action "no-such-action".*its actions are/.test(unknown), unknown);
  const pair = await page.evaluate(`(async () => { const h = window.__gallery.handle; const a = h.trigger(${JSON.stringify(supersede.older)}); const b = h.trigger(${JSON.stringify(supersede.newer)}); return [await a, await b]; })()`);
  check(`a newer trigger resolves the pending one with null ('${supersede.older}' -> null, '${supersede.newer}' -> '${supersede.state}')`, pair[0] === null && pair[1] === supersede.state, pair);
  if (!continuous) await idle(page);
  const rest = await page.evaluate('window.__gallery.handle.settled()');
  check(`handle.settled() reports the state at rest ('${supersede.state}')`, rest === supersede.state, rest);
}

/** Trusted mouse drag along a path (CDP Input.dispatchMouseEvent), with an optional callback after each step. */
export async function drag(/** @type {any} */ page, /** @type {number[][]} */ path, { stepMs = 16, onStep = /** @type {any} */ (null), release = true, hover = true } = {}) {
  const [x0, y0] = path[0];
  if (hover) await page.mouseMove(x0, y0);
  await page.mouseDown(x0, y0);
  for (let i = 1; i < path.length; i += 1) {
    await page.mouseMove(path[i][0], path[i][1], { buttons: 1 });
    await sleep(stepMs);
    if (onStep) await onStep(i);
  }
  const [x1, y1] = path[path.length - 1];
  if (release) await page.mouseUp(x1, y1);
}

/**
 * Record what the compositor shows (CDP screencast: a JPEG per new frame, at the display rate; screenshots are ~10 times slower here).
 * @param {any} page
 * @returns {Promise<() => Promise<{data: string, t: number}[]>>}  call it to stop and get the frames
 */
export async function startRecording(page) {
  /** @type {{data: string, t: number}[]} */ const frames = [];
  const off = page.on('Page.screencastFrame', (/** @type {any} */ e) => {
    frames.push({ data: e.data, t: e.metadata.timestamp });
    page.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {});
  });
  await page.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 });
  return async () => { await page.send('Page.stopScreencast'); off(); return frames; };
}

/**
 * Encode recorded frames into an animated WebP (ffmpeg, libwebp_anim, lossy): cropped to `crop` (CSS px = device px at DPR 1), scaled to
 * `width`, resampled to `fps`. Needs ffmpeg on the PATH (only for --record).
 * @param {{data: string, t: number}[]} frames @param {string} out @param {{x: number, y: number, w: number, h: number}} crop
 */
export function writeWebp(frames, out, crop, { width = 660, fps = 30, quality = 55 } = {}) {
  mkdirSync(dirname(out), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), 'hic-webp-'));
  try {
    let list = '';
    frames.forEach((f, i) => {
      const file = join(dir, `f${String(i).padStart(5, '0')}.jpg`);
      writeFileSync(file, Buffer.from(f.data, 'base64'));
      const next = frames[i + 1] ? frames[i + 1].t - f.t : 0.1;
      list += `file '${file}'\nduration ${Math.max(0.001, next).toFixed(4)}\n`;
    });
    list += `file '${join(dir, `f${String(frames.length - 1).padStart(5, '0')}.jpg`)}'\n`;
    writeFileSync(join(dir, 'list.txt'), list);
    const c = [crop.w, crop.h, crop.x, crop.y].map((v) => Math.round(v));
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'),
      '-vf', `crop=${c[0]}:${c[1]}:${c[2]}:${c[3]},fps=${fps},scale=${width}:-2:flags=lanczos`,
      '-c:v', 'libwebp_anim', '-lossless', '0', '-q:v', String(quality), '-compression_level', '6', '-loop', '0', out], { stdio: 'pipe' });
    return statSync(out).size;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** A list of named checks, printed as they are made; `finish()` prints the summary and sets the exit code. @param {string} title */
export function checklist(title) {
  /** @type {{name: string, ok: boolean, detail: unknown}[]} */ const checks = [];
  return {
    checks,
    check(/** @type {string} */ name, /** @type {unknown} */ ok, /** @type {unknown} */ detail) {
      checks.push({ name, ok: !!ok, detail });
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : '  ' + JSON.stringify(detail)}`);
      return !!ok;
    },
    finish() {
      const failed = checks.filter((x) => !x.ok);
      console.log(`\n${title}: ${checks.length - failed.length}/${checks.length} checks passed`);
      process.exitCode = failed.length ? 1 : 0;
      return failed.length === 0;
    },
  };
}
