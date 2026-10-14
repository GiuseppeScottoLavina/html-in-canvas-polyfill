#!/usr/bin/env node
// G-frameworks: React 19, Vue 3, Svelte 5 and Lit 3 apps whose UI lives inside <canvas content="drawable">, painted with
// drawElementImage from the `paint` event, loaded with dist/hic-live-polyfill.iife.js BEFORE the app, in HEADLESS Chrome.
//
//   (cd test/frameworks && npm install)   once: the framework deps live in test/frameworks/node_modules, never in the root package
//   npm run build                         dist/ must exist
//   npm run test:frameworks               (= node test/frameworks/run.mjs [--only=react,vue] [--no-control] [--chrome=stable|canary|path])
//
// Apps: examples/frameworks/<fw>/ (built into <fw>/dist/app.js by build.mjs). Every app has the same picture and the same test surface
// window.__app = { ready, state: {name, order, selected, badge, badgeClicks}, actions: {add, remove, reverse, toggle}, q, rect, text }.
//
// Scenarios per framework (all input is TRUSTED CDP input unless it says "via the app API"):
//   oracle        canvas readback vs the plain-DOM twin (?mode=ref) of the same app: delta>16 on <= 3 % of pixels, and non-blank
//   typing        click the drawn <input>, check that an editable has focus, type: framework state AND the canvas pixels change
//   list          click a drawn row -> its handler; Reverse / Add / Remove buttons (drawn) -> the row colours in the canvas follow the
//                 keyed list, and a click on a drawn row hits the item now shown there
//   conditional   the badge (a second drawable, drawn at (340,300) while laid out at the origin) is clickable where it is DRAWN and not
//                 where it is laid out; unmount -> pixels gone and no hit; remount -> pixels and hit back; 12 fast toggles via the app API
//   timer         a child component re-renders every 500 ms: the drawn tick region changes, nothing throws
//   reconcile     40 random add/remove/reverse/toggle via the app API, 20 ms apart: no error; live DOM order == state order; canvas follows
//   remount       a sibling after the canvas (parent-facade case), the WHOLE canvas unmounted and remounted (a new canvas element
//                 must be wired, painted, clickable and typeable), 11 fast canvas unmount/remount cycles
//   uninstall     uninstall() while the timer runs, keep mutating, the DOM stays consistent and nothing throws; install() again: the
//                 canvas shows the CURRENT state (addEventListener('paint') survives) and a drawn row is clickable again
//   doc-snippet   the code blocks of docs/guides/FRAMEWORKS.md section 5, extracted and wrapped by build.mjs: paint, click-focus, typing
//   hydration     (React only) hydrateRoot over server-rendered markup: no hydration error, the server node is kept, oracle, typing
//   errors        every scenario fails on any console error / exception / log error (NotFoundError of removeChild/insertBefore,
//                 Vue patch errors, Svelte anchor errors, Lit part errors all surface there)
// Positive controls (the script fails if one stays green):
//   C1 no polyfill (its URL answers 404): oracle, typing, list hit-testing and the doc snippet must fail, per framework
//   C2 inside `conditional`: a click at the badge's LAYOUT position must not reach it (asserted as a check, see above)
//   C3 a reordered twin must fail the pixel oracle (per framework)
//   C4 the error collector must see a NotFoundError thrown from removeChild
//   C5 React: markup that does not match the client must produce a hydration error
// Results: .scratch/results/frameworks-<timestamp>.json (+ PNGs). Headless only; one Chrome, our own PID, watchdog-killed.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as H from '../harness/index.mjs';
import { startServer } from '../../examples/serve.mjs';
import { buildAll } from './build.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const ONLY = arg('only')?.split(',');
const FRAMEWORKS = ['react', 'vue', 'svelte', 'lit'].filter((f) => !ONLY || ONLY.includes(f));
const WITH_CONTROL = !process.argv.includes('--no-control');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = resolve(ROOT, '.scratch/results', `frameworks-${STAMP}`);
const VIEW = { width: 800, height: 600 };
const BADGE = { x: 340, y: 300, w: 120, h: 40 };
const PANEL_BG = [0xf4, 0xf1, 0xe8], BADGE_RED = [0xc0, 0x28, 0x3a];
const sleep = H.sleep, q = JSON.stringify;
const WATCHDOG_MS = 12 * 60 * 1000;

// ---- small helpers --------------------------------------------------------------------------------------------------------------
class Run {
  constructor(page, fw, scenario) { this.page = page; this.fw = fw; this.scenario = scenario; this.checks = []; this.numbers = {}; }
  check(name, ok, detail) { this.checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) }); return !!ok; }
  async step(name, fn) {
    try { const out = await fn(); if (out !== undefined) this.check(name, out === true || out?.ok === true, out === true ? undefined : out); }
    catch (e) { if (e instanceof H.CdpTimeoutError) throw e; this.check(name, false, { error: String(e?.message ?? e).slice(0, 400) }); }
  }
  get ok() { return this.checks.length > 0 && this.checks.every((c) => c.ok); }
}
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgb = (s) => (s.match(/\d+/g) ?? []).slice(0, 3).map(Number);
const near = (a, b, tol = 24) => !!a && !!b && a.every((v, i) => Math.abs(v - b[i]) <= tol);
const px = (img, x, y) => { const i = (Math.round(y) * img.width + Math.round(x)) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };

/** Canvas backing store (composited over white, the canvas CSS background) -> RGBA. Works for a canvas in a shadow root (via __app.q). */
async function readSurface(page, sel = '#surface') {
  const url = await page.evaluate(`(async () => {
    const c = __app.q(${q(sel)}); if (!c || !c.width) throw new Error('no canvas or zero width');
    for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r));
    const s = document.createElement('canvas'); s.width = c.width; s.height = c.height; const x = s.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, s.width, s.height);
    await new Promise((r) => requestAnimationFrame(() => { x.drawImage(c, 0, 0); r(); }));
    return s.toDataURL('image/png'); })()`);
  return H.decodePng(Buffer.from(url.split(',')[1], 'base64'));
}
async function screenshotSurface(page) {
  const r = await page.evaluate(`__app.rect('#surface')`);
  return H.decodePng(await page.screenshot({ clip: { x: r.x, y: r.y, width: r.w, height: r.h, scale: 1 } }));
}
const rel = async (page, sel) => page.evaluate(`(() => { const s = __app.rect('#surface'), e = __app.rect(${q(sel)}); return e && { x: e.x - s.x, y: e.y - s.y, w: e.w, h: e.h, sx: s.x, sy: s.y }; })()`);
const state = (page) => page.evaluate(`JSON.parse(JSON.stringify(__app.state))`);
const colorOf = (page, id) => page.evaluate(`(() => { const li = __app.q('li[data-id=${q(id)}]'); return li ? getComputedStyle(li).backgroundColor : null; })()`).then((s) => s && rgb(s));
/** The focused element, through open shadow roots. */
const deepFocusEditable = (page) => page.evaluate(`(() => { let a = document.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  return !!a && (/^(input|textarea|select)$/i.test(a.localName) || a.isContentEditable); })()`);
/** Trusted typing; refuses (throws) when no editable has focus: keys sent to a headless Chrome 154 page without one spin its renderer. */
async function typeTrusted(page, text) {
  if (!(await deepFocusEditable(page))) throw new Error('no editable element has focus: not sending trusted keys');
  for (const ch of text) { await page.key(ch); await sleep(30); }
}
const clickAt = (page, x, y) => page.click(x, y);
/** Every error the page produced since `mark` (console.error, exceptions, Log errors). Warnings are returned separately. */
function errorsSince(page, mark = 0) {
  const all = page.errors({ includeWarnings: true });
  const errs = all.filter((e) => !/warning/.test(e.kind)), warns = all.filter((e) => /warning/.test(e.kind));
  return { errors: errs.slice(mark), warnings: warns.map((w) => String(w.text).slice(0, 300)) };
}
const errorCount = (page) => page.errors({ includeWarnings: false }).length;
const FRAMEWORK_ERROR = /NotFoundError|removeChild|insertBefore|replaceChild|Hydration|hydrat|\[Vue warn\]|patch|anchor|ChildPart|part|HierarchyRequestError|Cannot read propert/i;

async function openApp(page, base, fw, params = '', file = 'index.html') {
  await page.send('Emulation.setDeviceMetricsOverride', { width: VIEW.width, height: VIEW.height, deviceScaleFactor: 1, mobile: false });
  page.clearLogs();
  await page.navigate(`${base}/examples/frameworks/${fw}/${file}${params}`);
  return !!(await H.until(() => page.evaluate(`!!(window.__app && __app.ready)`), 8000));
}
/** Wait for a non-blank canvas showing `fn(img)` truthy. */
async function surfaceUntil(page, fn, timeoutMs = 6000, sel = '#surface') {
  let last = null;
  const hit = await H.until(async () => { last = await readSurface(page, sel); return fn(last) ? last : null; }, timeoutMs, 120);
  return { img: hit ?? last, ok: !!hit };
}
function save(name, img) { mkdirSync(OUT, { recursive: true }); writeFileSync(resolve(OUT, `${name}.png`), H.encodePng(img)); }

// ---- scenarios -----------------------------------------------------------------------------------------------------------------
async function oracle(run, base, { tag = '', reorderRef = false, params = '?tick=0', file } = {}) {
  const { page, fw } = run;
  let ref, surface;
  await run.step('plain-DOM twin renders', async () => {
    if (!(await openApp(page, base, fw, '?mode=ref&tick=0'))) return { ok: false, why: 'twin not ready' };
    if (reorderRef) { await page.evaluate(`__app.actions.reverse()`); await sleep(200); }
    await page.evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    ref = await screenshotSurface(page);
    return { ok: H.pixelStats(ref).nonBlank };
  });
  await run.step('canvas app mounts', async () => ({ ok: await openApp(page, base, fw, params, file) }));
  await run.step('pixel oracle: canvas vs plain-DOM twin (delta>16 on <= 3 %, non-blank)', async () => {
    if (!ref) return { ok: false, why: 'no reference' };
    // wait for a non-blank canvas, then for it to settle (fonts, second commit)
    let res = await surfaceUntil(page, (img) => H.pixelStats(img).nonBlank, 6000);
    await sleep(400); res = { img: await readSurface(page) };
    surface = res.img;
    const stats = H.pixelStats(surface), cmp = H.compareImages(surface, ref);
    save(`${fw}${tag}-oracle.surface`, surface); save(`${fw}${tag}-oracle.ref`, ref); if (cmp.diff) save(`${fw}${tag}-oracle.diff`, cmp.diff);
    run.numbers.oracle = { fraction: cmp.fraction, countOver16: cmp.countOver16, maxDiff: cmp.maxDiff, nonBlank: stats.nonBlank, size: [surface.width, surface.height] };
    return { ok: stats.nonBlank && cmp.sizeMatch && cmp.fraction <= 0.03, fraction: cmp.fraction, nonBlank: stats.nonBlank, sizeMatch: cmp.sizeMatch };
  });
}

async function typing(run, base, { params = '?tick=1', file } = {}) {
  const { page, fw } = run;
  await run.step('app mounts (timer running)', async () => ({ ok: await openApp(page, base, fw, params, file) }));
  const before = (await surfaceUntil(page, (img) => H.pixelStats(img).nonBlank, 6000)).img;
  const echo = await rel(page, '#echo').catch(() => null), input = await rel(page, '#name').catch(() => null);
  await run.step('click on the drawn input focuses it', async () => {
    if (!input || !input.w) return { ok: false, why: 'input has no box', input };
    await clickAt(page, input.sx + input.x + 20, input.sy + input.y + input.h / 2);
    return { ok: !!(await H.until(() => deepFocusEditable(page), 1500)) };
  });
  await run.step('typing updates framework state', async () => {
    await typeTrusted(page, 'ada');
    const s = await H.until(async () => { const st = await state(page); return st.name === 'ada' ? st : null; }, 3000);
    return { ok: !!s, name: (await state(page)).name };
  });
  await run.step('typing updates the canvas pixels (input and echo regions)', async () => {
    const region = (img, r) => H.cropImage(img, Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h));
    const echo2 = await rel(page, '#echo');
    const w = Math.max(echo.w, echo2.w);
    const res = await surfaceUntil(page, (img) => {
      const a = H.compareImages(region(img, { ...echo, w }), region(before, { ...echo, w })), b = H.compareImages(region(img, input), region(before, input));
      return a.countOver16 > 20 && b.countOver16 > 20;
    }, 4000);
    const a = H.compareImages(region(res.img, { ...echo, w }), region(before, { ...echo, w })), b = H.compareImages(region(res.img, input), region(before, input));
    save(`${fw}-typing.after`, res.img);
    return { ok: res.ok, echoChanged: a.countOver16, inputChanged: b.countOver16 };
  });
}

/** Rows are 24 px + 2 px gap from the top of #list; sample 4 px inside the left edge, mid-height. */
async function rowGeom(page) { const ul = await rel(page, '#list'); return (k) => ({ x: ul.x + 4, y: ul.y + k * 26 + 12, px: ul.sx + ul.x + 150, py: ul.sy + ul.y + k * 26 + 12 }); }

async function rowsMatch(page, row, order) {
  const want = []; for (const id of order) want.push(await colorOf(page, id));
  const res = await surfaceUntil(page, (img) => want.every((c, k) => near(px(img, row(k).x, row(k).y), c)) && (order.length >= 6 || near(px(img, row(order.length).x, row(order.length).y), PANEL_BG)), 4000);
  return { ok: res.ok, got: order.map((_, k) => px(res.img, row(k).x, row(k).y)), want };
}

async function clickRowExpect(page, row, k, id) {
  const r = row(k); await clickAt(page, r.px, r.py);
  const s = await H.until(async () => { const st = await state(page); return st.selected === id ? st : null; }, 2000);
  return { ok: !!s, expected: id, selected: (await state(page)).selected };
}

async function list(run, base, { params = '?tick=1' } = {}) {
  const { page } = run;
  await run.step('app mounts', async () => ({ ok: await openApp(page, base, run.fw, params) }));
  const row = await rowGeom(page);
  const btn = async (id) => { const b = await rel(page, id); await clickAt(page, b.sx + b.x + b.w / 2, b.sy + b.y + b.h / 2); };
  await run.step('initial rows drawn in state order', async () => rowsMatch(page, row, (await state(page)).order));
  await run.step('click drawn row 2 -> its handler (selected = b)', async () => clickRowExpect(page, row, 1, 'b'));
  await run.step('Reverse (drawn button): state, live DOM and drawn rows follow', async () => {
    await btn('#btn-reverse');
    const s = await H.until(async () => { const st = await state(page); return st.order.join() === 'c,b,a' ? st : null; }, 2000);
    const dom = await page.evaluate(`[...__app.q('#list').children].map((li) => li.dataset.id).join()`);
    const m = await rowsMatch(page, row, ['c', 'b', 'a']);
    return { ok: !!s && dom === 'c,b,a' && m.ok, dom, rows: m };
  });
  await run.step('after reverse: click drawn row 1 hits c', async () => clickRowExpect(page, row, 0, 'c'));
  let added;
  await run.step('Add: new row drawn at the end and clickable', async () => {
    await btn('#btn-add');
    const s = await H.until(async () => { const st = await state(page); return st.order.length === 4 ? st : null; }, 2000);
    if (!s) return { ok: false, why: 'state did not grow' };
    added = s.order[3];
    const m = await rowsMatch(page, row, s.order);
    const c = await clickRowExpect(page, row, 3, added);
    return { ok: m.ok && c.ok, rows: m, click: c };
  });
  await run.step('Remove first: rows shift up in the canvas, freed row is background, click hits the shifted item', async () => {
    await btn('#btn-remove');
    const s = await H.until(async () => { const st = await state(page); return st.order.length === 3 ? st : null; }, 2000);
    if (!s) return { ok: false, why: 'state did not shrink' };
    const m = await rowsMatch(page, row, s.order);
    const c = await clickRowExpect(page, row, 0, s.order[0]);
    return { ok: m.ok && c.ok && s.order.join() === `b,a,${added}`, order: s.order, rows: m, click: c };
  });
}

async function conditional(run, base) {
  const { page } = run;
  await run.step('app mounts', async () => ({ ok: await openApp(page, base, run.fw, '?tick=1') }));
  const surf = await page.evaluate(`__app.rect('#surface')`);
  const badgePx = (img) => px(img, BADGE.x + 6, BADGE.y + 20);
  const clicks = async () => (await state(page)).badgeClicks;
  const clickDrawnBadge = () => clickAt(page, surf.x + BADGE.x + 60, surf.y + BADGE.y + 30);
  const btn = async (id) => { const b = await rel(page, id); await clickAt(page, b.sx + b.x + b.w / 2, b.sy + b.y + b.h / 2); };
  await run.step('badge drawn at (340,300)', async () => { const r = await surfaceUntil(page, (img) => near(badgePx(img), BADGE_RED)); return { ok: r.ok, got: badgePx(r.img) }; });
  await run.step('click where the badge is DRAWN reaches its handler', async () => {
    const n0 = await clicks(); await clickDrawnBadge();
    return { ok: !!(await H.until(async () => (await clicks()) === n0 + 1, 2000)), clicks: await clicks() };
  });
  await run.step('control C2: click where the badge is LAID OUT (origin) does not reach it', async () => {
    const n0 = await clicks(); await clickAt(page, surf.x + 100, surf.y + 30); await sleep(400);
    return { ok: (await clicks()) === n0, clicks: await clicks() };
  });
  await run.step('unmount (drawn toggle button): badge pixels gone, no hit', async () => {
    await btn('#btn-toggle');
    const s = await H.until(async () => ((await state(page)).badge === false ? true : null), 2000);
    const r = await surfaceUntil(page, (img) => near(badgePx(img), PANEL_BG));
    const n0 = await clicks(); await clickDrawnBadge(); await sleep(400);
    return { ok: !!s && r.ok && (await clicks()) === n0, got: badgePx(r.img), badgeInDom: await page.evaluate(`!!__app.q('#badge')`) };
  });
  await run.step('remount: badge pixels back, new element clickable', async () => {
    await btn('#btn-toggle');
    const r = await surfaceUntil(page, (img) => near(badgePx(img), BADGE_RED));
    const n0 = await clicks(); await clickDrawnBadge();
    return { ok: r.ok && !!(await H.until(async () => (await clicks()) === n0 + 1, 2000)), got: badgePx(r.img) };
  });
  await run.step('12 fast toggles via the app API (30 ms apart), ends mounted and drawn', async () => {
    for (let i = 0; i < 12; i++) { await page.evaluate(`__app.actions.toggle()`); await sleep(30); }
    const r = await surfaceUntil(page, (img) => near(badgePx(img), BADGE_RED));
    return { ok: r.ok && (await state(page)).badge === true, got: badgePx(r.img) };
  });
}

async function timer(run, base) {
  const { page } = run;
  await run.step('app mounts (timer running)', async () => ({ ok: await openApp(page, base, run.fw, '?tick=1') }));
  await run.step('the drawn tick region changes as the timer component re-renders', async () => {
    const t = await rel(page, '.tick');
    const crop = (img) => H.cropImage(img, Math.round(t.x), Math.round(t.y), 120, Math.round(t.h));
    let prev = crop(await readSurface(page)), changes = 0;
    const text0 = await page.evaluate(`__app.text('.tick')`);
    for (let i = 0; i < 14; i++) { await sleep(250); const cur = crop(await readSurface(page)); if (H.compareImages(cur, prev).countOver16 > 5) changes++; prev = cur; }
    const text1 = await page.evaluate(`__app.text('.tick')`);
    run.numbers.tickChanges = changes;
    return { ok: changes >= 3 && text0 !== text1, changes, text0, text1 };
  });
}

async function reconcile(run, base) {
  const { page } = run;
  await run.step('app mounts (timer running)', async () => ({ ok: await openApp(page, base, run.fw, '?tick=1') }));
  await run.step('40 random add/remove/reverse/toggle via the app API, 20 ms apart: no error', async () => {
    let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const ops = ['add', 'remove', 'reverse', 'toggle', 'add', 'reverse'];
    const done = [];
    for (let i = 0; i < 40; i++) { const op = ops[Math.floor(rnd() * ops.length)]; done.push(op); await page.evaluate(`__app.actions.${op}()`); await sleep(20); }
    await sleep(300);
    return { ok: errorCount(page) === 0, errors: errorsSince(page).errors.slice(0, 5) };
  });
  await run.step('live DOM order == state order; children really live in <hic-layer> (mode polyfill) yet the canvas facade answers the logical tree', async () => {
    const r = await page.evaluate(`(() => { const ids = [...__app.q('#list').children].map((li) => li.dataset.id); const c = __app.q('#surface'), p = __app.q('#panel');
      return { ids, order: __app.state.order, facade: c.firstElementChild === p && p.parentNode === c && [...c.children].includes(p),
      realParent: Object.getOwnPropertyDescriptor(Node.prototype, 'parentNode').get.call(p).localName, mode: window.__HIC__?.installed?.mode }; })()`);
    return { ok: r.ids.join() === r.order.join() && r.facade && r.realParent === 'hic-layer' && r.mode === 'polyfill', ...r };
  });
  await run.step('the canvas shows the final state', async () => { const row = await rowGeom(page); return rowsMatch(page, row, (await state(page)).order); });
}

async function uninstall(run, base) {
  const { page } = run;
  await run.step('app mounts (timer running)', async () => ({ ok: await openApp(page, base, run.fw, '?tick=1') }));
  await surfaceUntil(page, (img) => H.pixelStats(img).nonBlank);
  await run.step('uninstall() while running: children back in the canvas, app keeps updating without errors', async () => {
    const before = await page.evaluate(`__app.text('.tick')`);
    await page.evaluate(`window.__HIC__.installed.uninstall()`);
    for (const op of ['reverse', 'toggle', 'add', 'toggle', 'remove']) { await page.evaluate(`__app.actions.${op}()`); await sleep(60); }
    await sleep(1200);
    const r = await page.evaluate(`(() => { const c = __app.q('#surface'), p = __app.q('#panel');
      return { realParentIsCanvas: Node.prototype.contains.call(c, p), layers: (__app.q('#surface').getRootNode()).querySelectorAll('hic-layer').length,
        ids: [...__app.q('#list').children].map((li) => li.dataset.id).join(), order: __app.state.order.join(), tick: __app.text('.tick') }; })()`);
    return { ok: errorCount(page) === 0 && r.realParentIsCanvas && r.layers === 0 && r.ids === r.order && r.tick !== before, ...r, errors: errorsSince(page).errors.slice(0, 3) };
  });
  await run.step('install() again: the canvas shows the CURRENT state and a drawn row is clickable', async () => {
    await page.evaluate(`HicLivePolyfill.install()`);
    await page.evaluate(`__app.actions.reverse()`);
    const row = await rowGeom(page);
    const order = (await state(page)).order;
    const m = await rowsMatch(page, row, order);
    const c = await clickRowExpect(page, row, 1, order[1]);
    return { ok: m.ok && c.ok && errorCount(page) === 0, rows: m, click: c };
  });
}

/** Real (non-facade) element children of the canvas's parent, by localName/id. */
const realSiblings = (page) => page.evaluate(`(() => { const app = __app.q('.app'); const kids = Object.getOwnPropertyDescriptor(Node.prototype, 'childNodes').get.call(app);
  return [...kids].filter((n) => n.nodeType === 1).map((n) => n.id || n.localName).join(); })()`);

async function remount(run, base) {
  const { page } = run;
  await run.step('app mounts', async () => ({ ok: await openApp(page, base, run.fw, '?tick=1') }));
  const nonBlank = () => surfaceUntil(page, (img) => H.pixelStats(img).nonBlank);
  await nonBlank();
  await run.step('a sibling rendered AFTER the canvas lands after the live layer', async () => {
    await page.evaluate(`__app.actions.toggleNote()`); await sleep(200);
    const real = await realSiblings(page);
    return { ok: real === 'surface,hic-layer,note' && errorCount(page) === 0, real };
  });
  await run.step('the whole canvas unmounts (route-change style): its layer goes with it, the sibling stays', async () => {
    await page.evaluate(`window.__oldCanvas = __app.q('#surface'); __app.actions.toggleSurface()`); await sleep(300);
    const real = await realSiblings(page);
    return { ok: real === 'note' && errorCount(page) === 0, real, errors: errorsSince(page).errors.slice(0, 3) };
  });
  await run.step('the canvas remounts: a NEW canvas is wired, painted, rows and badge clickable', async () => {
    await page.evaluate(`__app.actions.toggleSurface()`);
    const fresh = await H.until(() => page.evaluate(`!!__app.q('#surface') && __app.q('#surface') !== window.__oldCanvas && __app.q('#surface').width > 0`), 3000);
    const real = await realSiblings(page);
    const row = await rowGeom(page); const order = (await state(page)).order;
    const m = await rowsMatch(page, row, order);
    const c = await clickRowExpect(page, row, 2, order[2]);
    const surf = await page.evaluate(`__app.rect('#surface')`), n0 = (await state(page)).badgeClicks;
    await clickAt(page, surf.x + BADGE.x + 60, surf.y + BADGE.y + 30);
    const b = await H.until(async () => (await state(page)).badgeClicks === n0 + 1, 2000);
    return { ok: !!fresh && real === 'surface,hic-layer,note' && m.ok && c.ok && !!b, real, rows: m.ok, click: c, badgeHit: !!b };
  });
  await run.step('typing still works in the remounted canvas (state kept by the framework)', async () => {
    const input = await rel(page, '#name');
    await clickAt(page, input.sx + input.x + 20, input.sy + input.y + input.h / 2);
    if (!(await H.until(() => deepFocusEditable(page), 1500))) return { ok: false, why: 'no focus' };
    await typeTrusted(page, 'zed');
    return { ok: !!(await H.until(async () => ((await state(page)).name === 'zed' ? true : null), 2000)), name: (await state(page)).name };
  });
  await run.step('sibling after the canvas removed while the canvas stays: layer stays next to the canvas', async () => {
    await page.evaluate(`__app.actions.toggleNote()`); await sleep(200);
    const real = await realSiblings(page);
    return { ok: real === 'surface,hic-layer' && errorCount(page) === 0, real };
  });
  await run.step('11 fast canvas unmount/remount via the app API (25 ms apart): one canvas, one layer, painted, clickable', async () => {
    for (let i = 0; i < 11; i++) { await page.evaluate(`__app.actions.toggleSurface()`); await sleep(25); }
    if ((await state(page)).surface === false) await page.evaluate(`__app.actions.toggleSurface()`);
    await sleep(300);
    const real = await realSiblings(page);
    const row = await rowGeom(page); const order = (await state(page)).order;
    const m = await rowsMatch(page, row, order);
    const c = await clickRowExpect(page, row, 0, order[0]);
    return { ok: real === 'surface,hic-layer' && m.ok && c.ok && errorCount(page) === 0, real, rows: m.ok, click: c };
  });
}

/** The code blocks of FRAMEWORKS.md section 5 as built by build.mjs (buildDocSnippets): mount, paint, focus by click, type. */
async function docSnippet(run, base) {
  const { page, fw } = run;
  await page.send('Emulation.setDeviceMetricsOverride', { width: VIEW.width, height: VIEW.height, deviceScaleFactor: 1, mobile: false });
  page.clearLogs();
  await page.navigate(`${base}/__snip/${fw}.html`);
  // a minimal __app with a query that walks open shadow roots (the snippets have no test hooks)
  await page.evaluate(`window.__app = { q(sel) { const walk = (root) => { const e = root.querySelector(sel); if (e) return e; for (const h of root.querySelectorAll('*')) if (h.shadowRoot) { const f = walk(h.shadowRoot); if (f) return f; } return null; }; return walk(document); },
    rect(sel) { const e = this.q(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; } }; true`);
  let before;
  await run.step('the snippet mounts and paints (non-blank canvas)', async () => {
    const r = await surfaceUntil(page, (img) => H.pixelStats(img).nonBlank, 6000, 'canvas').catch((e) => ({ ok: false, error: String(e) }));
    before = r.img; if (r.img) save(`${fw}-snippet`, r.img);
    return { ok: r.ok };
  });
  await run.step('a click on the drawn input focuses it; typing changes the canvas', async () => {
    const c = await page.evaluate(`__app.rect('canvas')`), i = await page.evaluate(`__app.rect('input')`);
    if (!before || !i || !i.w) return { ok: false, why: 'no input box' };
    await clickAt(page, i.x + 20, i.y + i.h / 2);
    if (!(await H.until(() => deepFocusEditable(page), 1500))) return { ok: false, why: 'no focus' };
    await typeTrusted(page, 'abc');
    const box = { x: Math.round(i.x - c.x), y: Math.round(i.y - c.y), w: Math.round(i.w), h: Math.round(i.h) };
    const crop = (img) => H.cropImage(img, box.x, box.y, box.w, box.h);
    const r = await surfaceUntil(page, (img) => H.compareImages(crop(img), crop(before)).countOver16 > 20, 4000, 'canvas');
    return { ok: r.ok, changed: H.compareImages(crop(r.img), crop(before)).countOver16, value: await page.evaluate(`__app.q('input').value`) };
  });
}

async function hydration(run, base) {
  const { page } = run;
  await oracle(run, base, { tag: '-hydrate', params: '?tick=0', file: 'dist/hydrate.html' });
  await run.step('hydrateRoot kept the server-rendered panel node', async () => ({ ok: await page.evaluate(`!!window.__ssrPanel && window.__ssrPanel === __app.q('#panel') && __app.q('#panel').isConnected`) }));
  await run.step('no hydration error or warning', async () => {
    const e = errorsSince(page);
    const bad = [...e.errors.map((x) => x.text), ...e.warnings].filter((t) => /hydrat|did not match|mismatch/i.test(t));
    return { ok: e.errors.length === 0 && bad.length === 0, errors: e.errors.slice(0, 3), bad };
  });
  await typing(run, base, { params: '?tick=1', file: 'dist/hydrate.html' });
  // KNOWN probe (docs/guides/FRAMEWORKS.md, section 4): without suppressHydrationWarning on the canvas, React reports the attributes the polyfill added.
  // Recorded, not failed; it reports 'fixed' once the polyfill stops adding them before hydration.
  const p2 = await run.page.browser.newPage();
  try {
    await openApp(p2, base, 'react', '?tick=0&strict-hydration=1', 'dist/hydrate.html'); await sleep(500);
    const t = errorsSince(p2).errors.map((x) => String(x.text)).find((x) => /didn't match the client properties/.test(x));
    run.known = [t ? { id: 'react-hydration-canvas-attributes', still: true, attributes: (t.match(/^-\s+([\w-]+)=/gm) ?? []).map((x) => x.replace(/^-\s+/, '').replace('=', '')) } : { id: 'react-hydration-canvas-attributes', still: false }];
    // second probe: a top-level drawable WITHOUT id gets a generated id before hydration; suppressHydrationWarning on the canvas does not cover it
    p2.clearLogs();
    await p2.navigate(`${base}/__probe/probe-noid.html`); await H.until(() => p2.evaluate('!!window.__probeDone'), 4000);
    const t2 = errorsSince(p2).errors.map((x) => String(x.text)).find((x) => /didn't match/.test(x));
    run.known.push(t2 ? { id: 'react-hydration-generated-child-id', still: true, attributes: (t2.match(/^-\s+([\w-]+)=.*$/gm) ?? []).map((x) => x.replace(/^-\s+/, '').slice(0, 60)) } : { id: 'react-hydration-generated-child-id', still: false, note: errorsSince(p2).errors.length + ' errors' });
  } finally { await p2.close(); }
}

// ---- main ------------------------------------------------------------------------------------------------------------------------
const SCENARIOS = { oracle, typing, list, conditional, timer, reconcile, remount, uninstall };

async function runScenario(browser, base, fw, name, fn, opts) {
  const page = await browser.newPage();
  const run = new Run(page, fw, name);
  try { await fn(run, base, opts); }
  catch (e) { if (e instanceof H.CdpTimeoutError) throw e; run.check('scenario crashed', false, { error: String(e?.stack ?? e).slice(0, 400) }); }
  const { errors, warnings } = errorsSince(page);
  if (!opts?.control) run.check('no console error / exception / failed request', errors.length === 0, errors.length ? { errors: errors.slice(0, 5).map((e) => String(e.text).slice(0, 300)), frameworkLooking: errors.filter((e) => FRAMEWORK_ERROR.test(e.text)).length } : undefined);
  run.warnings = [...new Set(warnings)].slice(0, 8);
  await page.close();
  return run;
}

function line(run) {
  const bad = run.checks.filter((c) => !c.ok);
  return `${run.ok ? 'ok  ' : 'FAIL'} ${run.fw.padEnd(6)} ${run.scenario.padEnd(12)} ${run.checks.filter((c) => c.ok).length}/${run.checks.length}` +
    (bad.length ? '\n' + bad.map((c) => `       x ${c.name} ${JSON.stringify(c.detail ?? '').slice(0, 400)}`).join('\n') : '');
}

async function main() {
  for (const f of ['dist/hic-live-polyfill.iife.js']) { try { readFileSync(resolve(ROOT, f)); } catch { console.error(`${f} missing: run npm run build`); process.exit(2); } }
  await buildAll();
  mkdirSync(OUT, { recursive: true });
  const browser = await H.launchChrome({ name: 'frameworks', chrome: arg('chrome') ?? 'stable', windowSize: [VIEW.width, VIEW.height + 100], dpr: 1, extraArgs: ['--headless=new', '--hide-scrollbars'] });
  const watchdog = setTimeout(async () => { console.error(`WATCHDOG: ${WATCHDOG_MS / 1000}s exceeded, killing our Chrome`); await browser.close().catch(() => {}); process.exit(3); }, WATCHDOG_MS);
  browser.conn.sendTimeoutMs = 30000;
  const result = { script: 'test/frameworks/run.mjs', startedAt: new Date().toISOString(), headless: true, dpr: 1, viewport: VIEW, chrome: browser.version?.Browser,
    versions: Object.fromEntries(['react', 'react-dom', 'vue', 'svelte', 'lit'].map((p) => [p, JSON.parse(readFileSync(resolve(ROOT, 'test/frameworks/node_modules', p, 'package.json'), 'utf8')).version])),
    runs: [], controls: [], pass: false };
  let server, broken;
  const problems = [];
  try {
    const B = resolve(ROOT, '.scratch/frameworks-build');
    const snipFiles = Object.fromEntries(['react', 'vue', 'svelte', 'lit'].flatMap((f) => [[`/__snip/${f}.html`, resolve(B, 'snippets', `${f}.html`)], [`/__snip/${f}.bundle.js`, resolve(B, 'snippets', `${f}.bundle.js`)]]));
    server = await startServer({ files: { '/examples/frameworks/react/dist/hydrate-mismatch.html': resolve(B, 'hydrate-mismatch.html'),
      '/__probe/probe-noid.html': resolve(B, 'probe-noid.html'), '/__probe/probe-noid.js': resolve(B, 'probe-noid.js'),
      ...snipFiles } });
    console.log(`Chrome ${result.chrome} (headless), server ${server.url}; frameworks: ${q(result.versions)}`);
    for (const fw of FRAMEWORKS) {
      const names = Object.keys(SCENARIOS);
      for (const n of names) { const run = await runScenario(browser, server.url, fw, n, SCENARIOS[n]); result.runs.push(serial(run)); console.log(line(run)); if (!run.ok) problems.push(`${fw}/${n}`); }
      { const run = await runScenario(browser, server.url, fw, 'doc-snippet', docSnippet); result.runs.push(serial(run)); console.log(line(run)); if (!run.ok) problems.push(`${fw}/doc-snippet`); }
      if (fw === 'react') {
        const run = await runScenario(browser, server.url, fw, 'hydration', hydration); result.runs.push(serial(run)); console.log(line(run)); if (!run.ok) problems.push(`${fw}/hydration`);
        for (const k of run.known ?? []) console.log(`       KNOWN ${k.id}: ${k.still ? 'still present, attributes ' + k.attributes.join(', ') : 'NOT reproduced any more (fixed?)'}`);
      }
    }
    if (WITH_CONTROL) {
      broken = await startServer({ files: { '/dist/hic-live-polyfill.iife.js': resolve(ROOT, '.scratch/does-not-exist.js'), ...snipFiles } });
      for (const fw of FRAMEWORKS) {
        // C1: no polyfill. Each sub-check must turn red.
        for (const [n, fn] of [['oracle', oracle], ['typing', typing], ['list', list], ['doc-snippet', docSnippet]]) {
          const run = await runScenario(browser, broken.url, fw, `C1:${n}`, fn, { control: true });
          const red = run.checks.filter((c) => !c.ok).map((c) => c.name);
          const want = n === 'oracle' ? /pixel oracle/ : n === 'typing' ? /focuses|state|pixels/ : n === 'list' ? /hit|click/ : /paints|typing/;
          const turned = red.some((r) => want.test(r));
          result.controls.push({ control: `C1 no polyfill -> ${n}`, fw, turnedRed: turned, red });
          console.log(`${turned ? 'ok  ' : 'FAIL'} control C1 (no polyfill) ${fw}/${n}: ${red.length} red`);
          if (!turned) problems.push(`control C1 ${fw}/${n} stayed green`);
        }
        // C3: a reordered twin must fail the oracle
        const run = await runScenario(browser, server.url, fw, 'C3:reordered-twin', (r, b) => oracle(r, b, { tag: '-c3', reorderRef: true }), { control: true });
        const c3 = run.checks.find((c) => /pixel oracle/.test(c.name));
        const turned = !!c3 && !c3.ok && (c3.detail?.nonBlank === true);
        result.controls.push({ control: 'C3 reordered twin fails the oracle', fw, turnedRed: turned, detail: c3?.detail });
        console.log(`${turned ? 'ok  ' : 'FAIL'} control C3 (reordered twin) ${fw}: fraction ${c3?.detail?.fraction}`);
        if (!turned) problems.push(`control C3 ${fw} stayed green`);
      }
      // C4: the error collector sees a NotFoundError thrown by removeChild
      {
        const page = await browser.newPage();
        await openApp(page, server.url, FRAMEWORKS[0], '?tick=0');
        await page.evaluate(`setTimeout(() => document.body.removeChild(document.createElement('div')))`); await sleep(300);
        const e = errorsSince(page).errors; const turned = e.some((x) => /NotFoundError/.test(x.text));
        result.controls.push({ control: 'C4 error collector sees NotFoundError', turnedRed: turned });
        console.log(`${turned ? 'ok  ' : 'FAIL'} control C4 (error collector) sees NotFoundError`);
        if (!turned) problems.push('control C4 stayed green');
        await page.close();
      }
      // C5: React hydration mismatch is reported
      if (FRAMEWORKS.includes('react')) {
        const page = await browser.newPage();
        const src = readFileSync(resolve(ROOT, 'examples/frameworks/react/dist/hydrate.html'), 'utf8').replace('nobody', 'SERVER');
        writeFileSync(resolve(ROOT, '.scratch/frameworks-build/hydrate-mismatch.html'), src);
        await openApp(page, server.url, 'react', '?tick=0', 'dist/hydrate-mismatch.html'); await sleep(500);
        const e = errorsSince(page); const turned = [...e.errors.map((x) => x.text), ...e.warnings].some((t) => /hydrat|did not match/i.test(t));
        result.controls.push({ control: 'C5 React hydration mismatch reported', turnedRed: turned });
        console.log(`${turned ? 'ok  ' : 'FAIL'} control C5 (hydration mismatch) reported`);
        if (!turned) problems.push('control C5 stayed green');
        await page.close();
      }
    }
  } finally {
    clearTimeout(watchdog);
    await server?.close().catch(() => {}); await broken?.close().catch(() => {});
    const closed = await browser.close().catch((e) => ({ error: String(e) }));
    result.browserClose = closed;
  }
  result.pass = problems.length === 0; result.problems = problems; result.finishedAt = new Date().toISOString();
  const file = resolve(ROOT, '.scratch/results', `frameworks-${STAMP}.json`);
  writeFileSync(file, JSON.stringify(result, null, 1));
  console.log(`\n${result.pass ? 'PASS' : 'FAIL'}  ${problems.length} problem(s)${problems.length ? ': ' + problems.join(', ') : ''}\nresults: ${file}`);
  process.exit(result.pass ? 0 : 1);
}
function serial(run) { return { fw: run.fw, scenario: run.scenario, ok: run.ok, known: run.known, numbers: run.numbers, checks: run.checks, warnings: run.warnings }; }

main().catch((e) => { console.error(e); process.exit(1); });
