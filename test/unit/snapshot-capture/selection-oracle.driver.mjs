#!/usr/bin/env node
// Native pixel oracle for text selections: a compositor SCREENSHOT of a live drawable with a real selection (painted by the engine) against the tile the capture
// draws for the same drawable and selection. Cases: text fields and paragraphs on dark and light backdrops, author ::selection rules, line heights, wrapped and
// multi-paragraph selections, contenteditable.
//   node test/unit/snapshot-capture/selection-oracle.driver.mjs [--chrome=<path>|stable] [--out=.scratch/selection-oracle]
// Not a unit test (needs a screenshot); run it by hand on each platform (macOS, and Linux, e.g. the CI image). Headless Chrome with its own throwaway profile, focus
// emulation (a selection of an unfocused page is painted in the inactive colours) and grayscale text antialiasing (`--disable-lcd-text`: with LCD text the page and
// the SVG-image tile differ by the antialiasing alone, selected or not; the unselected control below shows it).
// Per case: the selection region (where the native screenshot changes when the selection is made) must have <= 1 % of its pixels with a channel delta > 16, and the
// unselected tile must equal the unselected screenshot there (the comparison is meaningful). Positive controls: the unselected tile against the selected screenshot
// must fail, and the platform model the engine shows (the selected glyphs in HighlightText, or in their own colour) must be the one util/engine.js decides.
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as H from '../../harness/index.mjs';
import { selectionForegroundOf } from '../../../src/util/engine.js';

const { values: opt } = parseArgs({ options: { chrome: { type: 'string', default: 'stable' }, out: { type: 'string', default: '.scratch/selection-oracle' } } });
const OUT = join(H.PROJECT_ROOT, opt.out);
mkdirSync(OUT, { recursive: true });

const CSS = '.d{display:flow-root;width:260px;height:80px;font:16px sans-serif;background:#fff}.i{display:block;box-sizing:border-box;width:200px;height:30px;padding:2px 6px;border:2px solid #888;font:16px sans-serif;margin:4px}*{caret-color:transparent}';
const DARK = 'background:#0e1626;color:#f5d76e';
const LIGHT = 'background:#ffffff;color:#7a1020';
const field = (look, type = 'text') => `<div class="d" drawable style="${look}"><input class="i" type="${type}" value="hello world" style="${look};border-color:${look.split(';')[0].split(':')[1]}"></div>`;
const para = (look, p = '', text = 'hello world static') => `<div class="d" drawable style="${look}"><p style="margin:8px;${p}">${text}</p></div>`;
/** @type {{name: string, html: string, css?: string, sel: [string, number, number], model?: boolean}[]} sel: [selector, start, end]; end -1: to the end of the next paragraph's 6th character */
const CASES = [
  { name: 'field-dark', html: field(DARK), sel: ['input', 0, 11], model: true },
  { name: 'field-light', html: field(LIGHT), sel: ['input', 0, 11], model: true },
  { name: 'field-dark-part', html: field(DARK), sel: ['input', 3, 8], model: true },
  { name: 'field-password', html: field(DARK, 'password'), sel: ['input', 2, 9], model: true },
  { name: 'field-author-bg', html: field(LIGHT), css: '.i::selection{background:rgb(255,0,255)}', sel: ['input', 0, 5] },
  { name: 'field-author-bg-color', html: field(LIGHT), css: '.i::selection{background:rgb(255,0,255);color:rgb(0,128,0)}', sel: ['input', 0, 5] },
  { name: 'field-author-color', html: field(LIGHT), css: '.i::selection{color:rgb(0,160,0)}', sel: ['input', 0, 5] },
  { name: 'field-author-translucent', html: field(DARK), css: '.i::selection{background:rgba(255,0,0,0.5)}', sel: ['input', 0, 5] },
  { name: 'text-dark', html: para(DARK), sel: ['p', 2, 11], model: true },
  { name: 'text-light', html: para(LIGHT), sel: ['p', 2, 11], model: true },
  { name: 'text-author-bg', html: para(LIGHT), css: 'p::selection{background:rgb(255,0,255)}', sel: ['p', 2, 11] },
  { name: 'text-author-color', html: para(LIGHT), css: 'p::selection{color:rgb(0,160,0)}', sel: ['p', 2, 11] },
  { name: 'text-author-inherited', html: para(LIGHT, '', 'hello <b>world</b> static'), css: 'p::selection{color:rgb(0,160,0)}', sel: ['b', 0, 5] },
  ...['0.8', '1', '1.3', '1.5', '2', '2.5', '29px'].map((lh) => ({ name: `text-line-height-${lh}`, html: para(LIGHT, `line-height:${lh}`), sel: /** @type {[string, number, number]} */ (['p', 2, 11]) })),
  { name: 'text-wrapped', html: para(LIGHT, 'width:90px', 'hello world static text'), sel: ['p', 2, 20] },
  { name: 'text-wrapped-line-height', html: para(DARK, 'width:90px;line-height:1.6', 'hello world static text'), sel: ['p', 2, 20] },
  { name: 'text-two-paragraphs', html: `<div class="d" drawable style="${LIGHT}"><p style="margin:8px;width:90px">hello world static text</p><p style="margin:0 8px">second para</p></div>`, sel: ['p', 2, -1] },
  { name: 'contenteditable-dark', html: `<div class="d" drawable style="${DARK}"><div contenteditable style="margin:8px;outline:none">editable text</div></div>`, sel: ['[contenteditable]', 2, 9] },
];

const srv = await H.startServer();
const browser = await H.launchChrome({ name: 'selection-oracle', chrome: opt.chrome, extraArgs: ['--headless=new', '--hide-scrollbars', '--disable-lcd-text'] });
let failed = false;
try {
  const page = await browser.newPage();
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.navigate(`${srv.url}/test/unit/lib/host.html?file=`);
  await H.sleep(300);
  const nav = await page.evaluate('({ userAgent: navigator.userAgent, userAgentData: navigator.userAgentData ? { platform: navigator.userAgentData.platform, brands: navigator.userAgentData.brands } : undefined })');
  const highlightText = await page.evaluate("(() => { const c = document.createElement('canvas').getContext('2d'); c.fillStyle = 'HighlightText'; const v = String(c.fillStyle); return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)); })()");
  const decided = selectionForegroundOf(nav);
  console.log(`${nav.userAgent}\npolyfill model: ${decided ? 'glyphs in HighlightText' : 'glyphs keep their colour'} (HighlightText ${highlightText})`);

  /** @param {typeof CASES[number]} c @param {boolean} selected */
  const step = (c, selected) => page.evaluate(`(async () => {
    const S = await import('/test/unit/snapshot-capture/_support.mjs');
    if (!${selected}) {
      document.querySelectorAll('[id^=fixture-]').forEach((e) => e.remove());
      getSelection().removeAllRanges(); document.activeElement?.blur?.();
      window.__m = S.mount(${JSON.stringify(c.html)}, { css: ${JSON.stringify(CSS + (c.css ?? ''))}, width: 280, height: 100 });
    }
    const m = window.__m; const d = m.layerEl.firstElementChild;
    const [sel, a, b] = ${JSON.stringify(c.sel)};
    const t = d.querySelector(sel);
    let focus = null;
    if (t instanceof HTMLInputElement) { t.focus(); t.setSelectionRange(${selected} ? a : 0, ${selected} ? b : 0); focus = t; }
    else {
      if (t.isContentEditable) { t.focus(); focus = t; }
      if (${selected}) { const r = document.createRange(); r.setStart(t.firstChild, a); if (b < 0) r.setEnd(t.nextElementSibling.firstChild, 6); else r.setEnd(t.firstChild, b); getSelection().removeAllRanges(); getSelection().addRange(r); }
      else if (!t.isContentEditable) getSelection().removeAllRanges();
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const x = await S.rasterize(m.capture(m.request(d, { interaction: { hover: new Set(), active: new Set(), focus, focusVisible: true, caretVisible: false } })));
    const rect = d.getBoundingClientRect();
    return { rect: { x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height }, tile: x.canvas.toDataURL('image/png') };
  })()`);
  for (const c of CASES) {
    /** @type {Record<string, {tile: any, shot: any}>} */
    const s = {};
    for (const selected of [false, true]) {
      const r = await step(c, selected);
      await H.sleep(120);
      s[String(selected)] = { tile: H.decodePng(Buffer.from(r.tile.split(',')[1], 'base64')), shot: H.decodePng(await page.screenshot({ clip: { ...r.rect, scale: 1 } })) };
    }
    const plain = s.false, sel = s.true;
    const region = changedBox(plain.shot, sel.shot);
    if (!region || sel.tile.width !== sel.shot.width || sel.tile.height !== sel.shot.height) { console.log(`FAIL ${c.name}: ${region ? 'size mismatch' : 'the native selection is not visible'}`); failed = true; continue; }
    const cmp = over16(sel.shot, sel.tile, region);
    const base = over16(plain.shot, plain.tile, region);
    const control = over16(sel.shot, plain.tile, region);
    let note = '';
    let pass = cmp <= 1 && base === 0 && control > 5;
    if (c.model) {
      // which model the engine shows: the selected glyph core is HighlightText, or the field's / paragraph's own colour
      const glyph = farthest(sel.shot, region);
      const own = (c.html.includes(DARK) ? [245, 215, 110] : [122, 16, 32]);
      const native = dist(glyph, highlightText) < dist(glyph, own);
      note = `, engine model: ${native ? 'HighlightText' : 'own colour'} (glyph ${glyph})`;
      if (native !== decided) pass = false;
    }
    if (!pass) failed = true;
    writeFileSync(join(OUT, `${c.name}.native.png`), H.encodePng(sel.shot));
    writeFileSync(join(OUT, `${c.name}.tile.png`), H.encodePng(sel.tile));
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${c.name}: ${cmp.toFixed(2)} % of the selection over 16 (unselected ${base.toFixed(2)} %, control ${control.toFixed(1)} %)${note}`);
  }
} finally {
  await browser.close();
  await srv.close();
}
console.log(failed ? 'selection oracle: FAILED' : 'selection oracle: OK');
process.exit(failed ? 1 : 0);

/** @param {number[]} a @param {number[]} b */
function dist(a, b) { return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]); }
/** @param {{width: number, data: Uint8Array}} img @param {number} x @param {number} y */
function px(img, x, y) { const i = (y * img.width + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; }
/** the bounding box of the pixels that differ by more than 8 @param {any} a @param {any} b */
function changedBox(a, b) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) if (Math.max(...px(a, x, y).map((v, k) => Math.abs(v - px(b, x, y)[k]))) > 8) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
/** percentage of the region's pixels with a channel delta > 16 @param {any} a @param {any} b @param {{x: number, y: number, w: number, h: number}} r */
function over16(a, b, r) {
  let n = 0;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (Math.max(...px(a, x, y).map((v, k) => Math.abs(v - px(b, x, y)[k]))) > 16) n++;
  return (n / (r.w * r.h)) * 100;
}
/** the pixel farthest from the region's most common colour (a glyph core) @param {any} img @param {{x: number, y: number, w: number, h: number}} r */
function farthest(img, r) {
  const count = new Map();
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) { const k = px(img, x, y).join(); count.set(k, (count.get(k) ?? 0) + 1); }
  const bg = [...count.entries()].sort((p, q) => q[1] - p[1])[0][0].split(',').map(Number);
  let best = bg, d = -1;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) { const p = px(img, x, y); const e = dist(p, bg); if (e > d) { d = e; best = p; } }
  return best;
}
