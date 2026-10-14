// PIXEL ORACLE: the canvas variant of a fixture vs the plain-DOM rendering of the same fixture, same window size and DPR.
//
//   const r = await referenceDiff({ surfacePage, refPage, selector: '#hic-surface', outDir, name: 'f3-w1000' });
//   r.diffPixels  pixels with any difference        r.maxDiff     largest channel delta
//   r.countOver16 pixels with delta > 16            r.fraction    countOver16 / totalPixels  <- the project gate is fraction <= 0.03
//   r.surfaceNonBlank / r.refNonBlank               r.pass        preconditions AND gate hold;  r.reasons explains a failure
//
// Both pages live in the SAME window (two tabs) so size and DPR match; each is brought to the front before it is read (a hidden
// tab stalls rAF and cannot be screenshotted). The surface canvas is composited over its CSS background colour because the
// reference is opaque. Exact equality is not expected (text rasteriser differs); judge the numbers, but a BLANK surface fails
// whatever the diff says: a broken renderer compared with an empty reference would otherwise be a perfect 0.
// Pixel readback of a WebGPU-presented canvas is unreliable; use source:'screenshot' for effect-on surfaces.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng, encodePng } from './png.mjs';
import { pixelStats, compareImages, compositeOver } from './pixels.mjs';

/** Canvas backing store -> RGBA. The draw into the scratch canvas happens inside a rAF so a presented frame is read. */
export async function readCanvas(page, selector = '#hic-surface', { waitFrames = 2 } = {}) {
  const dataUrl = await page.evaluate(`(async () => {
    const c = document.querySelector(${JSON.stringify(selector)});
    if (!c || !c.width) throw new Error('canvas not found or zero-size: ' + ${JSON.stringify(selector)});
    for (let i = 0; i < ${waitFrames}; i++) await new Promise(r => requestAnimationFrame(r));
    const s = document.createElement('canvas'); s.width = c.width; s.height = c.height;
    const x = s.getContext('2d');
    await new Promise(r => requestAnimationFrame(() => { x.drawImage(c, 0, 0); r(); }));
    return s.toDataURL('image/png');
  })()`);
  return decodePng(Buffer.from(dataUrl.split(',')[1], 'base64'));
}

/** Compositor screenshot of an element's border box (CSS rect x DPR device pixels). */
export async function screenshotElement(page, selector = '#hic-surface', { file, beyondViewport = false } = {}) {
  const geo = await page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height, dpr: devicePixelRatio, scrollX, scrollY, innerWidth, innerHeight }; })()`);
  if (!geo) throw new Error('element not found: ' + selector);
  // CDP clip is relative to the DOCUMENT origin, not the viewport: add the scroll offset.
  const buf = await page.screenshot({ file, beyondViewport, clip: { x: geo.x + geo.scrollX, y: geo.y + geo.scrollY, width: geo.width, height: geo.height, scale: 1 } });
  return { img: decodePng(buf), geo };
}

/**
 * @typedef {object} RefDiffOptions
 * @property {import('./page.mjs').Page} surfacePage page showing the canvas variant (poly/native)
 * @property {import('./page.mjs').Page} refPage page showing the plain-DOM variant (mode=ref), same window
 * @property {string} [selector='#hic-surface']
 * @property {'canvas'|'screenshot'} [source='canvas'] how the surface pixels are obtained
 * @property {number[]} [bg] background to composite the canvas over (default: its computed background-color)
 * @property {string} [outDir] write <name>.{surface,ref,diff}.png and <name>.json here
 * @property {string} [name='refdiff']
 * @property {number} [tolerance=16]
 * @property {number} [maxFraction=0.03] gate on `fraction`
 */
/** @param {RefDiffOptions} o */
export async function referenceDiff({ surfacePage, refPage, selector = '#hic-surface', source = 'canvas', bg, outDir, name = 'refdiff', tolerance = 16, maxFraction = 0.03 } = {}) {
  const vp = p => p.evaluate(`({iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio})`);
  const reasons = [];
  await surfacePage.requireForeground(`before reading the surface (${name})`);
  const sv = await vp(surfacePage);
  let surface, surfaceGeo;
  if (source === 'canvas') {
    let bgc = bg;
    if (!bgc) {
      const css = await surfacePage.evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).backgroundColor`);
      const m = css.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0]; bgc = [m[0] ?? 0, m[1] ?? 0, m[2] ?? 0];
    }
    surface = compositeOver(await readCanvas(surfacePage, selector), bgc);
  } else {
    ({ img: surface, geo: surfaceGeo } = await screenshotElement(surfacePage, selector));
  }
  await refPage.requireForeground(`before reading the reference (${name})`);
  const rv = await vp(refPage);
  const { img: ref, geo } = await screenshotElement(refPage, selector);

  const viewportMismatch = sv.iw !== rv.iw || sv.ih !== rv.ih || sv.dpr !== rv.dpr ? { surface: sv, ref: rv } : null;
  const surfaceStats = pixelStats(surface), refStats = pixelStats(ref);
  const cmp = compareImages(surface, ref, { tolerance });
  if (viewportMismatch) reasons.push('viewport/DPR differ between the two pages');
  if (!cmp.sizeMatch) reasons.push(`size mismatch surface ${surface.width}x${surface.height} vs ref ${ref.width}x${ref.height}`);
  if (!surfaceStats.nonBlank) reasons.push('SURFACE IS BLANK (broken renderer; a small diff against an empty reference means nothing)');
  if (!refStats.nonBlank) reasons.push('reference is blank (cannot judge)');
  const preconditionsOk = reasons.length === 0;
  const gatePass = !!cmp.sizeMatch && cmp.fraction <= maxFraction;
  if (preconditionsOk && !gatePass) reasons.push(`fraction ${(cmp.fraction * 100).toFixed(3)} % > gate ${(maxFraction * 100).toFixed(1)} %`);
  const report = {
    name, selector, source, tolerance, maxFraction, viewportMismatch, cssRect: geo, surfaceSize: [surface.width, surface.height], refSize: [ref.width, ref.height],
    surfaceNonBlank: surfaceStats.nonBlank, refNonBlank: refStats.nonBlank, surfaceStats, refStats, preconditionsOk, gatePass, pass: preconditionsOk && gatePass, reasons, ...cmp,
  };
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `${name}.surface.png`), encodePng(surface));
    writeFileSync(join(outDir, `${name}.ref.png`), encodePng(ref));
    if (cmp.diffImage) writeFileSync(join(outDir, `${name}.diff.png`), encodePng(cmp.diffImage));
    const { diffImage, ...rest } = report; writeFileSync(join(outDir, `${name}.json`), JSON.stringify(rest, null, 2));
    report.files = { surface: `${name}.surface.png`, ref: `${name}.ref.png`, diff: `${name}.diff.png`, json: `${name}.json`, dir: outDir };
  }
  delete report.diffImage;
  return report;
}
