#!/usr/bin/env node
// G-platform: what the platform's own theme puts on screen, pinned against native pixels in headless Chrome. Written for Windows, where CI runs it (Segoe UI, the
// classic scrollbars of the default theme, fractional device pixel ratios, Highlight / HighlightText from the system), and runnable on every platform.
//   node test/platform/run.mjs [--chrome=stable|canary|<path>] [--only=fonts,controls,scrollers,dpr,selection] [--dpr=1.25,1.5] [--out=.scratch/platform] [--allow-known]
// Needs the built bundles (npm run build). Every comparison is the polyfill's canvas BACKING STORE against a compositor screenshot of the plain-DOM twin of the
// same page in the same browser (fixture mode=ref), each with a positive control that must fail:
//   fonts      the fonts the platform used for the page text (CSS.getPlatformFontsForNode); on Windows system-ui must be Segoe UI
//   controls   every form control of F6 (light, dark, accent-color, disabled, listboxes, unstyled scrollers) in its own region, with the G-xbrowser controls bounds
//              (<= 15 % of the pixels over 16 and <= 1.5 % over 100, +-1 device row), and the whole surface (<= 5 % / <= 1 %); control: a twin 3 css px off
//   scrollers  F7, unstyled scrollers with the platform's own bars (vertical, dark, both axes with a corner, thin, scrollbar-gutter: stable, textarea,
//              scrollbar-color, overflow-y: scroll without overflow), at DPR 1 and each --dpr, at rest and scrolled: the scrollport is laid out exactly (DPR 1:
//              delta > 6 on <= 2 % of it, the G-scroll-inner region bound; a fractional DPR: the controls bounds, as the page sets text in device pixels and
//              the image is scaled, so glyph edges differ by their antialiasing) and the painted bars match the native ones (<= 3 % over 16, <= 1.5 % over
//              100); there must be a gutter (classic bars);
//              control: the twin scrolled, the canvas not
//   dpr        examples/form at each --dpr (1.25 and 1.5: common Windows laptop scales) against its twin: delta > 16 on <= 3 % (the plain-DOM pixel gate) and
//              the canvas not blank; control: the twin 3 css px off
//   selection  the selection pixel oracle (test/unit/snapshot-capture/selection-oracle.driver.mjs): a real selection painted by the engine vs the polyfill's tile,
//              and the engine's colour model (glyphs in HighlightText on Windows and Linux, in their own colour on macOS) vs the one src/util/engine.js decides
// Classic scrollbars are forced (harness `scrollbars: 'classic'`; Windows and Linux show them anyway). LCD text is off (`--disable-lcd-text`): a canvas never gets
// subpixel text, native drawElementImage included, so ClearType (on by default on Windows) would separate the twin from ANY canvas by the antialiasing alone.
// Writes <out>/results.json and the PNGs of every failing comparison; exits 1 on any failed check. A gap this probe has measured is listed in KNOWN below: it is
// printed as KNOWN RED with its reason, and with --allow-known (CI) it does not fail the run; its thresholds are not changed.
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as H from '../harness/index.mjs';
import { oracle } from '../xbrowser/lib.mjs';

const { values: opt } = parseArgs({
  options: {
    chrome: { type: 'string', default: 'stable' }, only: { type: 'string', default: 'fonts,controls,scrollers,dpr,selection' },
    dpr: { type: 'string', default: '1.25,1.5' }, out: { type: 'string', default: '.scratch/platform' }, 'allow-known': { type: 'boolean', default: false },
  },
});
const ONLY = new Set(opt.only.split(','));
const DPRS = opt.dpr.split(',').map(Number);
const OUT = join(H.PROJECT_ROOT, opt.out);
mkdirSync(OUT, { recursive: true });
const BUNDLE = '/dist/hic-live-polyfill.iife.js';
const F6 = '/test/fixtures/f6-controls/index.html';
const F7 = '/test/fixtures/f7-system-scrollbars/index.html';
const FORM_TWIN = '/examples/form/twin.html';
/** controls bounds of G-xbrowser (test/xbrowser/scenarios.mjs, controls) */
const REGION = { maxFraction: 0.15, maxStructural: 0.015 };
/** Scrollbars are drawn with the engine's own geometry and colours: held to <= 3 % of their pixels over 16 (+-1 device row). The controls bounds let a thumb drawn at
 *  the wrong offset pass (a thumb is 13-16 % of its bar), and then the positive control (the canvas at rest against the scrolled twin) passed too. */
const BAR = { maxFraction: 0.03, maxStructural: 0.015 };
/**
 * A region judged by its pixels: the surface oracle also requires both pictures to be non-blank (more than 8 colours), a guard for a whole surface; a region can be
 * right with 8 colours or fewer (a crisp checkbox, a scrollbar track or an empty gutter failed with none of their pixels different).
 * @param {any} a @param {any} b @param {{maxFraction: number, maxStructural: number}} bounds
 */
const region = (a, b, bounds) => { const o = oracle(a, b, bounds); return { ...o, pass: !!o.sizeMatch && o.shiftTolerant <= bounds.maxFraction && o.structural <= bounds.maxStructural }; };

for (const f of ['dist/hic-live-polyfill.iife.js', 'dist/hic-live-polyfill.iife.min.js']) {
  if (!existsSync(join(H.PROJECT_ROOT, f))) { console.error(`G-platform: ${f} is missing; run npm run build first`); process.exit(1); }
}

/**
 * Gaps of the polyfill this probe measured (Chrome 155, 2026-10-21: Linux in the CI image, macOS with classic bars forced), by check id and platform. Windows shows the
 * same Fluent classic bars as Linux by default and is listed with it. A listed check that PASSES on a listed platform fails the run (KNOWN RED NOW PASSES): the list
 * is the record and must shrink when a gap is fixed.
 * @type {Record<string, {platforms: string[], reason: string}>}
 */
const KNOWN = {
  // empty since the classic-bar fixes (2026-10-21: the bar-sized intrinsic width of textarea and listbox select pinned in the clone, Chromium's own Fluent and macOS
  // bar looks painted, listbox bars painted); measured passing on Linux (CI image) and macOS with classic bars, Windows by its CI job
};
/** @type {{id?: string, section: string, name: string, ok: boolean, status: 'pass'|'fail'|'known'|'now-passes', detail?: any}[]} */
const checks = [];
/** @type {Record<string, any>} */
const facts = { platform: process.platform };
const check = (/** @type {string} */ section, /** @type {string} */ name, /** @type {boolean} */ ok, /** @type {any} */ detail, /** @type {string} */ id = '') => {
  const known = KNOWN[id]?.platforms.includes(process.platform) ? KNOWN[id] : null;
  const status = ok ? (known ? 'now-passes' : 'pass') : known ? 'known' : 'fail';
  checks.push({ id: id || undefined, section, name, ok: !!ok, status, detail });
  const tag = { pass: 'ok  ', fail: 'FAIL', known: 'KNOWN RED', 'now-passes': 'FAIL (KNOWN RED NOW PASSES)' }[status];
  console.log(`${tag} [${section}] ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`);
  if (status === 'known') console.log(`     known gap ${id} on ${process.platform}: ${known?.reason}`);
  if (status === 'now-passes') console.log(`     ${id} is listed in KNOWN for ${process.platform} but passed: remove it from KNOWN (test/platform/run.mjs)`);
};
const save = (/** @type {string} */ name, /** @type {any} */ img) => writeFileSync(join(OUT, `${name}.png`), H.encodePng(img));


/**
 * One headless browser at a real device pixel ratio (--force-device-scale-factor), classic scrollbars, grayscale text.
 * @param {number} dpr @param {(page: any) => Promise<void>} fn
 */
async function atDpr(dpr, fn) {
  const browser = await H.launchChrome({ name: 'platform', chrome: opt.chrome, dpr, windowSize: [1400, 1000], scrollbars: 'classic', extraArgs: ['--headless=new', '--disable-lcd-text'] });
  try {
    facts.browser = browser.version?.Browser;
    const page = await browser.newPage();
    facts.userAgent ??= await page.evaluate('navigator.userAgent');
    facts.systemColors ??= await page.evaluate(`(() => { const x = document.createElement('canvas').getContext('2d'); const o = {};
      for (const k of ['Highlight', 'HighlightText', 'Canvas', 'CanvasText', 'ButtonFace', 'Field']) { x.fillStyle = '#123456'; x.fillStyle = k; o[k] = String(x.fillStyle); } return o; })()`);
    await fn(page);
    const errs = page.errors({ includeWarnings: false });
    check(`dpr ${dpr}`, 'no page error', errs.length === 0, errs.length ? errs.slice(0, 3) : undefined);
  } finally {
    await browser.close();
  }
}

/** The plain-DOM twin of examples/form: the example without its scripts (no polyfill, no drawing), the canvas swapped for a div by the fixture boot (mode=ref). */
function formTwin() {
  const src = readFileSync(join(H.PROJECT_ROOT, 'examples/form/index.html'), 'utf8');
  const dist = src.match(/<script src="[^"]*dist\/[^"]*"><\/script>\n?/g) ?? [];
  const inline = src.match(/<script>[\s\S]*?<\/script>/g) ?? [];
  if (dist.length < 1 || inline.length !== 1 || !src.includes('</canvas>')) throw new Error('G-platform: examples/form/index.html changed shape; update formTwin()');
  let html = src;
  for (const s of [...dist, ...inline]) html = html.replace(s, '');
  html = html.replace('</canvas>', '</canvas>\n<script src="/test/fixtures/shared/boot.js"></script>');
  const file = join(OUT, 'form-twin.html');
  writeFileSync(file, html);
  return file;
}

/** @param {any} page @param {string} path @param {'ref'|'poly'} mode */
async function open(page, path, mode) {
  await H.openFixture(page, srv, path, { mode, bundle: mode === 'poly' ? BUNDLE : undefined });
  await H.sleep(mode === 'poly' ? 700 : 300);
}

/** @param {any} page @param {string} sel @returns {Promise<{x: number, y: number, width: number, height: number}>} */
const rectOf = (page, sel) => page.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);

/** The canvas backing store composited over white (every surface here is white). @param {any} page @param {string} sel */
async function canvasOf(page, sel) { return H.compositeOver(await H.readCanvas(page, sel), [255, 255, 255]); }

/** Screenshot of a css rect (viewport coordinates), on whole device pixels. @param {any} page @param {{x: number, y: number, width: number, height: number}} r @param {number} dpr */
async function shot(page, r, dpr) {
  const sx = await page.evaluate('scrollX'), sy = await page.evaluate('scrollY');
  const x = Math.round((r.x + sx) * dpr) / dpr, y = Math.round((r.y + sy) * dpr) / dpr;
  return H.decodePng(await page.screenshot({ clip: { x, y, width: Math.round(r.width * dpr) / dpr, height: Math.round(r.height * dpr) / dpr, scale: 1 } }));
}

/** device-pixel box of css rect `r` inside a surface whose origin is `o`, k device px per css px, `pad` device px around, clamped to the image */
function box(/** @type {any} */ r, /** @type {any} */ o, /** @type {number} */ k, /** @type {any} */ img, pad = 0) {
  const x = Math.max(0, Math.floor((r.x - o.x) * k) - pad), y = Math.max(0, Math.floor((r.y - o.y) * k) - pad);
  return { x, y, w: Math.min(img.width, Math.ceil((r.x - o.x + r.width) * k) + pad) - x, h: Math.min(img.height, Math.ceil((r.y - o.y + r.height) * k) + pad) - y };
}
const crop = (/** @type {any} */ img, /** @type {any} */ b) => H.cropImage(img, b.x, b.y, b.w, b.h);
const pct = (/** @type {number} */ v) => +(v * 100).toFixed(2);

/** (d) Which fonts the platform used. On Windows, system-ui is Segoe UI (the form example and the fixtures ask for it). @param {any} page */
async function fonts(page) {
  await page.navigate(`${srv.url}${FORM_TWIN}?mode=ref`);
  await page.waitForFunction('window.__HIC_FIXTURE && window.__HIC_FIXTURE.ready');
  await page.send('DOM.enable'); await page.send('CSS.enable');
  const { root } = await page.send('DOM.getDocument', { depth: 0 });
  /** @type {Record<string, string[]>} */ const used = {};
  for (const sel of ['#contact h2', '#contact label.field', '#send', 'body > p']) {
    const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
    used[sel] = nodeId ? (await page.send('CSS.getPlatformFontsForNode', { nodeId })).fonts.map((/** @type {any} */ f) => f.familyName) : [];
  }
  facts.fonts = used;
  check('fonts', 'the platform reports the fonts of the page text', Object.values(used).every((f) => f.length > 0), used);
  // the paragraph also holds a <code> (ui-monospace, monospace): it must include Segoe UI; the others are system-ui alone
  const segoe = (/** @type {string[]} */ f) => f.length > 0 && f.every((n) => /^Segoe UI/.test(n));
  if (process.platform === 'win32') {
    check('fonts', 'Windows: system-ui text is set in Segoe UI', segoe(used['#contact h2']) && segoe(used['#contact label.field']) && segoe(used['#send'])
      && used['body > p'].some((n) => /^Segoe UI/.test(n)), used);
  }
}

/** (b, d) Every F6 control region and the whole surface against the twin. @param {any} page */
async function controls(page) {
  const RECTS = `[...document.querySelectorAll('[data-ctl]')].map((e) => { const r = e.getBoundingClientRect(); return { id: e.dataset.ctl, x: r.left, y: r.top, width: r.width, height: r.height }; })`;
  await open(page, F6, 'ref');
  const surf = await rectOf(page, '#hic-surface');
  const rects = await page.evaluate(RECTS);
  const ref = await shot(page, surf, 1);
  const off = await shot(page, { ...surf, x: surf.x + 3, y: surf.y + 3 }, 1);
  await open(page, F6, 'poly');
  const poly = await canvasOf(page, '#hic-surface');
  const k = poly.width / surf.width;
  /** @type {Record<string, number[]>} */ const per = {};
  const bad = [], caught = [];
  for (const r of rects) {
    const b = box(r, surf, k, poly, 2);
    const o = region(crop(poly, b), crop(ref, b), REGION);
    per[r.id] = [pct(o.shiftTolerant), pct(o.structural)];
    if (!o.pass) { bad.push(r.id); save(`controls-${r.id}.canvas`, crop(poly, b)); save(`controls-${r.id}.twin`, crop(ref, b)); }
    if (!region(crop(poly, b), crop(off, b), REGION).pass) caught.push(r.id);
  }
  facts.controls = per;
  check('controls', `each of ${rects.length} F6 control regions matches the twin (<= 15 % over 16, <= 1.5 % over 100)`, rects.length > 50 && bad.length === 0, { bad }, 'controls.regions');
  check('controls', 'the bars of the unstyled light and dark scrollers match the twin', !bad.includes('L-bars') && !bad.includes('D-bars'), { light: per['L-bars'], dark: per['D-bars'] }, 'controls.bars');
  // control: a twin 3 css px off must fail most regions (a tiny or flat region can survive a shift)
  check('controls', 'positive control: against a twin 3 css px off, most regions fail', caught.length >= rects.length * 0.6, { caught: caught.length, of: rects.length });
  const whole = oracle(poly, ref);
  check('controls', 'the whole F6 surface matches the twin (<= 5 % over 16, <= 1 % over 100)', whole.pass, { over16: pct(whole.fraction), shiftTolerant: pct(whole.shiftTolerant), structural: pct(whole.structural) }, 'controls.whole');
  if (!whole.pass) { save('controls.canvas', poly); save('controls.twin', ref); }
}

/** css rects of a scroller: its scrollport without the bars, and each bar's gutter. @param {any} page @param {string} id */
const scrollerGeometry = (page, id) => page.evaluate(`(() => { const e = document.getElementById(${JSON.stringify(id)}); const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
  const bl = e.clientLeft, bt = e.clientTop, br = parseFloat(cs.borderRightWidth), bb = parseFloat(cs.borderBottomWidth);
  const gv = r.width - bl - br - e.clientWidth, gh = r.height - bt - bb - e.clientHeight;
  return { port: { x: r.left + bl, y: r.top + bt, width: e.clientWidth, height: e.clientHeight }, gv, gh,
    vbar: gv > 0.5 ? { x: r.left + bl + e.clientWidth, y: r.top + bt, width: gv, height: e.clientHeight } : null,
    hbar: gh > 0.5 ? { x: r.left + bl, y: r.top + bt + e.clientHeight, width: e.clientWidth, height: gh } : null,
    overflowY: e.scrollHeight > e.clientHeight, overflowX: e.scrollWidth > e.clientWidth }; })()`);
const SCROLL = { 'v-light': [0, 400], 'v-dark': [0, 400], both: [120, 200], thin: [0, 400], stable: [0, 0], textarea: [0, 120], colored: [0, 400], always: [0, 0] };
const scrollAll = (/** @type {any} */ page, /** @type {boolean} */ on) => page.evaluate(`(async () => { for (const [id, [l, t]] of Object.entries(${JSON.stringify(SCROLL)})) { const e = document.getElementById(id); e.scrollLeft = ${on} ? l : 0; e.scrollTop = ${on} ? t : 0; }
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return true; })()`);

/** (b) F7: layout of the scrollport and the painted bars against the platform's own, at rest and scrolled. @param {any} page @param {number} dpr */
async function scrollers(page, dpr) {
  const S = `scrollers dpr ${dpr}`;
  await open(page, F7, 'ref');
  const surf = await rectOf(page, '#hic-surface');
  const ids = Object.keys(SCROLL);
  /** @type {Record<string, any>} */ const geo = {};
  for (const id of ids) geo[id] = await scrollerGeometry(page, id);
  const ref = { rest: await shot(page, surf, dpr), scrolled: /** @type {any} */ (null) };
  await scrollAll(page, true); await H.sleep(150);
  ref.scrolled = await shot(page, surf, dpr);
  check(S, 'classic bars: the unstyled scroller has a vertical gutter', geo['v-light'].gv > 0.5, { gutter: +geo['v-light'].gv.toFixed(3), thin: +geo.thin.gv.toFixed(3) });
  facts[`gutters@${dpr}`] = Object.fromEntries(ids.map((id) => [id, [+geo[id].gv.toFixed(3), +geo[id].gh.toFixed(3)]]));
  await open(page, F7, 'poly');
  const poly = { rest: await canvasOf(page, '#hic-surface'), scrolled: /** @type {any} */ (null) };
  await scrollAll(page, true); await H.sleep(700);
  poly.scrolled = await canvasOf(page, '#hic-surface');
  const k = poly.rest.width / surf.width;
  const sizeOk = poly.rest.width === ref.rest.width && poly.rest.height === ref.rest.height;
  check(S, 'the canvas has the size of the twin in device pixels', sizeOk, { canvas: [poly.rest.width, poly.rest.height], twin: [ref.rest.width, ref.rest.height] });
  if (!sizeOk) return;
  /** @type {Record<string, any>} */ const rows = {};
  const badPort = [], badBar = [];
  // DPR 1: the G-scroll-inner region bound. A fractional DPR: the page sets text in device pixels and the image is scaled, so every glyph edge can differ by its
  // antialiasing (Linux: 3.7-6.9 % of a text-dense scrollport over 16, layout identical, 0-0.4 % over 100); the region bounds of the controls take that and still
  // fail on a layout error, which moves pixels by far more than 100 levels
  /** @param {any} a @param {any} b @returns {{pass: boolean, n: number[]}} */
  const port = (a, b) => {
    if (dpr === 1) { const c = H.compareImages(a, b, { tolerance: 6, diffImage: false }); return { pass: !!c.sizeMatch && c.fraction <= 0.02, n: [pct(c.fraction ?? 1)] }; }
    const o = oracle(a, b, REGION); return { pass: o.pass, n: [pct(o.fraction ?? 1), pct(o.shiftTolerant), pct(o.structural)] };
  };
  const PORT_TEXT = dpr === 1 ? 'delta > 6 on <= 2 %' : '<= 15 % over 16, <= 1.5 % over 100';
  for (const state of /** @type {const} */ (['rest', 'scrolled'])) {
    for (const id of ids) {
      const g = geo[id];
      const pb = box(g.port, surf, k, poly[state]);
      const c = port(crop(poly[state], pb), crop(ref[state], pb));
      const row = rows[`${id}/${state}`] = { port: c.n };
      if (!c.pass) { badPort.push(`${id}/${state}`); save(`scrollers-${dpr}-${id}-${state}.canvas`, crop(poly[state], pb)); save(`scrollers-${dpr}-${id}-${state}.twin`, crop(ref[state], pb)); }
      for (const bar of ['vbar', 'hbar']) {
        if (!g[bar]) continue;
        const bb = box(g[bar], surf, k, poly[state]);
        const o = region(crop(poly[state], bb), crop(ref[state], bb), BAR);
        row[bar] = [pct(o.shiftTolerant), pct(o.structural)];
        if (!o.pass) { badBar.push(`${id}/${state}/${bar}`); save(`scrollers-${dpr}-${id}-${state}-${bar}.canvas`, crop(poly[state], bb)); save(`scrollers-${dpr}-${id}-${state}-${bar}.twin`, crop(ref[state], bb)); }
      }
    }
  }
  facts[`scrollers@${dpr}`] = rows;
  check(S, `the scrollports are laid out as in the twin (${PORT_TEXT}), at rest and scrolled`, badPort.length === 0, { bad: badPort });
  check(S, `the painted bars match the platform's (<= 3 % over 16, <= 1.5 % over 100), at rest and scrolled`, badBar.length === 0, { bad: badBar }, 'scrollers.bars');
  // positive control: the canvas at rest against the scrolled twin; the scrolled scrollports and their thumbs must fail
  const g = geo['v-light'];
  const portCtl = port(crop(poly.rest, box(g.port, surf, k, poly.rest)), crop(ref.scrolled, box(g.port, surf, k, poly.rest)));
  const barCtl = region(crop(poly.rest, box(g.vbar, surf, k, poly.rest)), crop(ref.scrolled, box(g.vbar, surf, k, poly.rest)), BAR);
  check(S, 'positive control: the canvas at rest fails against the scrolled twin (scrollport and thumb)', !portCtl.pass && !barCtl.pass, { port: portCtl.n, bar: [pct(barCtl.shiftTolerant), pct(barCtl.structural)] });
}

/** (c) examples/form at a fractional DPR against its twin. @param {any} page @param {number} dpr */
async function formAtDpr(page, dpr) {
  const S = `dpr ${dpr}`;
  await page.navigate(`${srv.url}${FORM_TWIN}?mode=ref`);
  await page.waitForFunction('window.__HIC_FIXTURE && window.__HIC_FIXTURE.ready');
  // The canvas grid is the content box at whole device pixels, and its pixels do not depend on where the page puts the canvas (G-pixel-dpr, origin); the twin's
  // content box can start on a fraction of a device pixel (33 css px = 41.25 device px at 1.25), where text snaps differently and a clip resamples: the twin is
  // moved onto whole device pixels by a relative offset of <body> (no layout change), as the plain-DOM capture oracle does.
  const shift = await page.evaluate(`(() => { const s = document.getElementById('stage'); const r = s.getBoundingClientRect(); const d = devicePixelRatio;
    const x = r.left + s.clientLeft, y = r.top + s.clientTop; const fx = (Math.ceil(x * d - 1e-6) - x * d) / d, fy = (Math.ceil(y * d - 1e-6) - y * d) / d;
    document.body.style.position = 'relative'; document.body.style.left = fx + 'px'; document.body.style.top = fy + 'px'; return [fx, fy]; })()`);
  await H.sleep(200);
  const content = await page.evaluate(`(() => { const s = document.getElementById('stage'); const r = s.getBoundingClientRect(); return { x: r.left + s.clientLeft, y: r.top + s.clientTop, width: s.clientWidth, height: s.clientHeight }; })()`);
  const ref = await shot(page, content, dpr);
  const off = await shot(page, { ...content, x: content.x + 3, y: content.y + 3 }, dpr);
  await page.navigate(`${srv.url}/examples/form/index.html`);
  const painted = await page.evaluate(`(async () => { for (let i = 0; i < 100 && !window.__HIC__?.installed; i++) await new Promise((r) => setTimeout(r, 50));
    if (!window.__HIC__?.installed) return 'not installed: ' + (window.__HIC__?.error?.message ?? 'no __HIC__');
    return window.__HIC__.installed.whenPainted(document.getElementById('stage'), 8000).then(() => 'painted', (e) => 'no paint: ' + e.message); })()`);
  check(S, 'the form example installs the polyfill and paints', painted === 'painted', painted === 'painted' ? undefined : painted);
  if (painted !== 'painted') return;
  await H.sleep(700);
  const poly = await canvasOf(page, '#stage');
  const cmp = H.compareImages(poly, ref, { tolerance: 16 });
  const stats = H.pixelStats(poly);
  const row = { canvas: [poly.width, poly.height], twin: [ref.width, ref.height], shift, over16: cmp.sizeMatch ? pct(cmp.fraction) : null, maxDiff: cmp.maxDiff, content: +stats.nonDominantFraction.toFixed(4) };
  facts[`form@${dpr}`] = row;
  check(S, 'examples/form: the canvas is not blank', stats.nonDominantFraction > 0.01, row);
  check(S, 'examples/form: the canvas equals the plain-DOM twin (delta > 16 on <= 3 %)', cmp.sizeMatch && cmp.fraction <= 0.03, row);
  if (!cmp.sizeMatch || cmp.fraction > 0.03) { save(`form-${dpr}.canvas`, poly); save(`form-${dpr}.twin`, ref); if (cmp.diffImage) save(`form-${dpr}.diff`, cmp.diffImage); }
  const ctl = H.compareImages(poly, off, { tolerance: 16, diffImage: false });
  check(S, 'positive control: the canvas fails against the twin 3 css px off', ctl.sizeMatch && ctl.fraction > 0.03, { over16: ctl.sizeMatch ? pct(ctl.fraction) : null });
}

/** (a) The selection pixel oracle, in its own browser. */
function selection() {
  const driver = join(H.PROJECT_ROOT, 'test/unit/snapshot-capture/selection-oracle.driver.mjs');
  const r = spawnSync(process.execPath, [driver, `--chrome=${opt.chrome}`, `--out=${join(opt.out, 'selection')}`], { stdio: 'inherit' });
  check('selection', 'the selection oracle passes (native selection pixels vs the polyfill tile, the engine colour model vs src/util/engine.js)', r.status === 0, { exit: r.status });
}

// ---- run (after every declaration above: the helpers are consts)
const srv = await H.startServer({ files: { [FORM_TWIN]: formTwin() } });
try {
  if (ONLY.has('fonts') || ONLY.has('controls')) await atDpr(1, async (page) => { if (ONLY.has('fonts')) await fonts(page); if (ONLY.has('controls')) await controls(page); });
  if (ONLY.has('scrollers')) for (const dpr of [1, ...DPRS]) await atDpr(dpr, (page) => scrollers(page, dpr));
  if (ONLY.has('dpr')) for (const dpr of DPRS) await atDpr(dpr, (page) => formAtDpr(page, dpr));
} finally {
  await srv.close();
}
if (ONLY.has('selection')) selection();

const failed = checks.filter((c) => c.status === 'fail' || c.status === 'now-passes' || (c.status === 'known' && !opt['allow-known']));
const known = checks.filter((c) => c.status === 'known');
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ facts, checks }, null, 1));
console.log(`G-platform: ${checks.filter((c) => c.ok).length}/${checks.length} checks passed, ${known.length} KNOWN RED${known.length && opt['allow-known'] ? ' (allowed: --allow-known)' : ''}`
  + ` on ${process.platform} (${facts.browser ?? 'unknown browser'}) - ${failed.length ? 'FAILED' : 'OK'}`);
process.exit(failed.length || !checks.length ? 1 : 0);
