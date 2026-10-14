// Pixel readback helpers: the canvas bitmap (readCanvas) and a compositor screenshot of an element (screenshotElement).
// Pixel readback of a WebGPU-presented canvas is unreliable; use a screenshot for effect-on surfaces.
import { decodePng } from './png.mjs';

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

