// G-pixel-dpr: DPR 1 and the fractional device pixel ratios 1.25 and 1.5 (common on Windows laptops) against the NATIVE implementation.
// The reference is the canvas backing store that native HTML-in-Canvas (Chrome Canary with CanvasDrawElement) draws for the same fixture with the same painter, captured
// first in its own browser (one browser at a time); the polyfill's backing store is then compared with it.
//   pixel   F1 (fractional canvas size: the painter asks for offsetWidth * dpr, half a pixel off the raster), F2, F4, F5 at rest, and F2 / F4 / F5 after a change that builds a
//           cropped tile: delta > 16 on <= 1 % (F1 <= 2.2 %; measured 0.1-0.6 % and 1.7-2.0 %, 2.5-2.8 % before near-1:1 draws were snapped, api/draw-math.js)
//           and the same with the page moved by a fraction of a device pixel (native's canvas does not depend on it: one native reference serves both)
//   text    the text fixture (test/fixtures/text-weight: light-on-dark and dark-on-light rows, 12-16 px, system-ui and a serif) is held to the pixel bounds above, and
//           every row's ink (the coverage of its glyphs) within 2 % of native's: macOS sets text with font smoothing (strokes dilated, most for light text on dark),
//           and text set without it loses 12-15 % of its ink on the dark rows and 26-30 % on the light ones (mutant text-smoothing-off). Measured: the ratio is 1.000
//           in every row at DPR 1, 1.25 and 1.5 (Chrome 156, Canary 159; the SVG image keeps the smoothing, also over transparent pixels)
//   origin  the polyfill's canvas does not depend on where the page puts the canvas: the same fixture with the whole page moved by a fraction of a device pixel
//           (a relative offset of <body> set before the first paint) has the same backing store (delta > 16 on <= 0.05 %). Native has this property (measured: 0.000 %).
// The plain-DOM pixel oracle (test/unit/snapshot-capture/oracle.driver.mjs) showed > 3 % at DPR 1.25 on F2 / F4 / F5 only because its reference sat on a half device pixel.
// Scrollbars: both browsers show CLASSIC bars (harness `scrollbars: 'classic'`). Left to the system setting, macOS switches between overlay and classic bars when a mouse
// is connected or not, and the reference changed under the gate (2026-10-15: f4 0.107 % -> 2.04 % with the same bundle and browsers). Classic bars are the harder case:
// a gutter of a whole number of device pixels (14.4 css px at DPR 1.25) that the polyfill reproduces as padding, and painted bars.
// Positive control (sabotage originshift): every draw lands one device pixel to the right when the canvas starts on a fractional device pixel: `pixel` and `origin` go red.
//   node test/gates/g-pixel-dpr.mjs --dpr=1|1.25|1.5 (run-all runs all three)
import { runGate, H } from './lib/gate.mjs';
import { canvasShot } from './lib/pixel.mjs';

const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const DPR = Number(arg('dpr') ?? 1.25);
const WINDOW = [1400, 1000];
const FIXTURES = ['f1', 'f2', 'f4', 'f5', 'text'];
/** fixtures that are not in the harness list, by path */
const PATH = { text: '/test/fixtures/text-weight/index.html' };
/** a change that rebuilds a cropped tile of the drawable (the same in both implementations) */
const CHANGE = {
  f2: "document.querySelector('#in-5').value = 'changed text 123'",
  f4: "document.querySelector('#root').querySelectorAll('td, li, p, span')[40].textContent = 'Changed 0123456789'",
  f5: "document.querySelector('#sc-text').value = 'line one changed\\nline two'",
};
const LIMIT = { f1: 0.022, f2: 0.01, f4: 0.01, f5: 0.01, text: 0.01 };
/** text weight: the ink of every row of the text fixture (its own background and text colour, 22 css px rows) within this ratio of native's */
const INK_TOLERANCE = 0.02;
const INK_ROWS = [['dark', 255, 17], ['light', 17, 242]].flatMap(([theme, bg, fg]) => ['sans', 'serif'].flatMap((family) => [12, 14, 16].map((size) => ({ id: `${theme}-${family}-${size}`, bg, fg }))));

/**
 * Ink of each row of the text fixture: the sum over the row of (luminance - background) / (text - background), clamped to [0, 1], in css px^2 (divided by dpr^2).
 * A rasteriser that thins glyph strokes (macOS font smoothing lost in the image) lowers it; a shift of the text does not change it.
 * @param {{width: number, height: number, data: Uint8Array}} img @param {number} dpr @returns {number[]}
 */
function rowInk(img, dpr) {
  return INK_ROWS.map(({ bg, fg }, i) => {
    let sum = 0;
    for (let y = Math.ceil(i * 22 * dpr) + 1; y < Math.floor((i + 1) * 22 * dpr) - 1; y++) {
      for (let x = 0; x < img.width; x++) { const o = (y * img.width + x) * 4; sum += Math.min(1, Math.max(0, ((img.data[o] + img.data[o + 1] + img.data[o + 2]) / 3 - bg) / (fg - bg))); }
    }
    return sum / dpr / dpr;
  });
}
/** the same scrollbar mode in both browsers, never the system setting (see above) */
const SCROLLBARS = 'classic';
/** moves the page by a fraction of a device pixel before the first paint: onto a whole device pixel when the canvas starts on a fractional one, else by half a device pixel */
const SHIFT = `addEventListener('DOMContentLoaded', () => { const c = document.querySelector('#hic-surface'); if (!c) return; const d = devicePixelRatio; const x = c.getBoundingClientRect().left * d;
  let f = Math.ceil(x - 1e-3) - x; if (f < 1e-3) f = 0.5; document.body.style.position = 'relative'; document.body.style.left = (f / d) + 'px'; window.__shifted = f / d; });`;

/** @param {import('../harness/lib/page.mjs').Page} page @param {any} srv @param {string} fx @param {'native'|'poly'} mode @param {string} [bundle] @param {boolean} [shift] */
async function open(page, srv, fx, mode, bundle, shift = false) {
  let id = null;
  if (shift) id = (await page.send('Page.addScriptToEvaluateOnNewDocument', { source: SHIFT })).identifier;
  try {
    await page.setInnerSize(fx === 'f2' ? 1301 : 1300, 900);
    await H.openFixture(page, srv, PATH[fx] ?? fx, { mode, bundle });
  } finally {
    if (id) await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: id });
  }
  await H.sleep(700);
}

/** @param {import('../harness/lib/page.mjs').Page} page @param {string} fx */
async function change(page, fx) {
  const p0 = await page.evaluate('window.__HIC_DRAW.paints');
  await page.evaluate(CHANGE[fx]);
  await page.waitForFunction(`window.__HIC_DRAW.paints > ${p0}`, { timeout: 5000 }).catch(() => {});
  await H.sleep(700);
}

/** Native references, captured before the gate's own browser starts. @returns {Promise<{refs: Map<string, any>, version: string|null, error: string|null}>} */
async function nativeReferences() {
  const refs = new Map();
  const srv = await H.startServer();
  let browser = null;
  try {
    browser = await H.launchChrome({ name: 'gate-G-pixel-dpr-native', chrome: 'canary', nativeDrawElement: true, dpr: DPR, windowSize: WINDOW, scrollbars: SCROLLBARS });
    const page = await browser.newPage({ reuseFirst: true });
    await page.ensureForeground({ timeout: 2500 }).catch(() => {});
    for (const fx of FIXTURES) {
      await open(page, srv, fx, 'native');
      refs.set(fx, (await canvasShot(page)).img);
      if (CHANGE[fx]) { await change(page, fx); refs.set(`${fx}+change`, (await canvasShot(page)).img); }
    }
    return { refs, version: browser.version?.Browser ?? null, error: null };
  } catch (err) {
    return { refs, version: browser?.version?.Browser ?? null, error: String(err?.message ?? err).slice(0, 400) };
  } finally {
    await browser?.close().catch(() => {});
    await srv.close();
  }
}

const native = await nativeReferences();

/** @param {any} a @param {any} b */
const diff = (a, b) => { const c = H.compareImages(a, b, { tolerance: 16 }); return c.sizeMatch ? c.fraction : 1; };

runGate('G-pixel-dpr', async (ctx) => {
  const numbers = { dpr: DPR, native: native.version };
  ctx.check('the native reference was captured (Chrome Canary with CanvasDrawElement)', !native.error && native.refs.size > 0, native.error, 'surface');
  if (native.error) return { numbers };
  const page = await ctx.page();
  await ctx.focus(page);
  const errors0 = page.errors().length;
  for (const fx of FIXTURES) {
    await open(page, ctx.srv, fx, 'poly', ctx.bundle);
    const rest = (await canvasShot(page)).img;
    const ref = native.refs.get(fx);
    const row = { size: [rest.width, rest.height], vsNative: +(diff(rest, ref) * 100).toFixed(3), content: H.pixelStats(rest).nonDominantFraction };
    ctx.check(`${fx} at DPR ${DPR}: the canvas is not blank`, row.content > 0.005, row, 'content');
    ctx.check(`${fx} at DPR ${DPR}: the polyfill's canvas equals native's (delta > 16 on <= ${+(LIMIT[fx] * 100).toFixed(1)} %)`, row.vsNative <= LIMIT[fx] * 100, row, 'pixel');
    if (fx === 'text') {
      const mine = rowInk(rest, DPR), theirs = rowInk(ref, DPR);
      row.inkRatio = Object.fromEntries(INK_ROWS.map(({ id }, i) => [id, +(mine[i] / theirs[i]).toFixed(4)]));
      const off = INK_ROWS.filter(({ id }) => Math.abs(row.inkRatio[id] - 1) > INK_TOLERANCE).map(({ id }) => id);
      ctx.check(`text at DPR ${DPR}: every row is set with native's weight (ink of light-on-dark and dark-on-light rows, 12-16 px, sans and serif, within ${INK_TOLERANCE * 100} % of native's)`, off.length === 0, { off, inkRatio: row.inkRatio }, 'pixel');
    }
    if (CHANGE[fx]) {
      await change(page, fx);
      const after = (await canvasShot(page)).img;
      row.changed = +(diff(after, rest) * 100).toFixed(3);
      row.changedVsNative = +(diff(after, native.refs.get(`${fx}+change`)) * 100).toFixed(3);
      ctx.check(`${fx} at DPR ${DPR}: after a change (a cropped tile) the canvas still equals native's (<= 1 %), and the change is drawn`, row.changed > 0 && row.changedVsNative <= 1, row, 'pixel');
    }
    await open(page, ctx.srv, fx, 'poly', ctx.bundle, true);
    row.shifted = await page.evaluate('window.__shifted ?? null');
    const moved = (await canvasShot(page)).img;
    row.vsShifted = +(diff(moved, rest) * 100).toFixed(3);
    ctx.check(`${fx} at DPR ${DPR}: the canvas does not depend on the page position (moved by ${row.shifted?.toFixed(3)} css px: delta > 16 on <= 0.05 %)`, row.shifted !== null && row.vsShifted <= 0.05, row, 'origin');
    // native's canvas does not depend on the page position: the moved page is compared with the same native reference
    row.shiftedVsNative = +(diff(moved, ref) * 100).toFixed(3);
    ctx.check(`${fx} at DPR ${DPR}: moved by a fraction of a device pixel, the canvas still equals native's (<= ${+(LIMIT[fx] * 100).toFixed(1)} %)`, row.shiftedVsNative <= LIMIT[fx] * 100, row, 'pixel');
    numbers[fx] = row;
  }
  const errs = page.errors({ includeWarnings: false }).slice(errors0);
  ctx.check('no page error', errs.length === 0, errs.slice(0, 3), 'surface');
  return { numbers };
}, { dpr: DPR, windowSize: WINDOW, scrollbars: SCROLLBARS, controlSabotage: ['originshift'], controlClasses: ['pixel', 'origin'] });
