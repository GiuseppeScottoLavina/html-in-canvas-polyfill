// Environment facts + feature probes. Record the output of environmentFacts() with every measurement.
import { execFileSync } from 'node:child_process';

/** In-page scrollbar probe: classic bars have a non-zero gutter, overlay bars report 0. */
export const SCROLLBAR_PROBE_EXPR = `(() => {
  const d = document.createElement('div'); d.style.cssText = 'position:fixed;left:-9999px;top:0;width:100px;height:100px;overflow:scroll';
  d.innerHTML = '<div style="width:300px;height:300px"></div>'; document.body.appendChild(d);
  const r = { verticalGutterPx: d.offsetWidth - d.clientWidth, horizontalGutterPx: d.offsetHeight - d.clientHeight };
  d.remove(); r.overlay = r.verticalGutterPx === 0; return r;
})()`;

/** Feature-detect the native HTML-in-Canvas surface in the current page. Run it on a page WITHOUT a polyfill bundle. */
export const NATIVE_PROBE_EXPR = `(() => {
  const out = {};
  const protoNames = (o) => { const s = new Set(); for (let p = o; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) for (const n of Object.getOwnPropertyNames(p)) s.add(n); return [...s]; };
  const re = /element|paint|layoutsubtree|drawable|geometry|snapshot|captureElement|requestPaint|^content$/i;
  const c = document.createElement('canvas');
  out.canvasReflection = { content: 'content' in c, layoutSubtree: 'layoutSubtree' in c, onpaint: 'onpaint' in c, requestPaint: typeof c.requestPaint,
    captureElementImage: typeof c.captureElementImage, getElementTransform: typeof c.getElementTransform, updateElementGeometry: typeof c.updateElementGeometry,
    onelementgeometryupdate: 'onelementgeometryupdate' in c };
  out.canvasProtoMatches = protoNames(HTMLCanvasElement.prototype).filter(n => re.test(n));
  out.ctx2dProtoMatches = protoNames(CanvasRenderingContext2D.prototype).filter(n => re.test(n));
  out.webglProtoMatches = typeof WebGL2RenderingContext !== 'undefined' ? protoNames(WebGL2RenderingContext.prototype).filter(n => re.test(n)) : null;
  out.gpuQueueProtoMatches = typeof GPUQueue !== 'undefined' ? protoNames(GPUQueue.prototype).filter(n => re.test(n)) : null;
  out.globalsMatches = Object.getOwnPropertyNames(globalThis).filter(n => /(ElementImage|GeometryUpdate|CanvasPaint)/.test(n));
  out.hasDrawElementImage = typeof CanvasRenderingContext2D.prototype.drawElementImage === 'function';
  return out;
})()`;

/**
 * Collect browser/OS/display facts. The refresh rate is NOT read from the OS (system_profiler hides ProMotion): it is the rAF
 * cadence of a foreground focused page, i.e. the rate Chrome actually renders at. Needs a foreground page.
 * @param {import('./chrome.mjs').Browser} browser @param {import('./page.mjs').Page} page
 */
export async function environmentFacts(browser, page, { measureRaf = true, rafFrames = 240 } = {}) {
  const info = await browser.info();
  const viewport = await page.viewport();
  const inPage = await page.evaluate(`(async () => { let gpu = null;
    try { const a = await navigator.gpu?.requestAdapter(); gpu = a ? { vendor: a.info?.vendor, architecture: a.info?.architecture, features: [...a.features].length } : null; } catch (e) { gpu = { error: String(e) }; }
    return { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, crossOriginIsolated, secureContext: isSecureContext, webgpu: !!navigator.gpu, gpuAdapter: gpu }; })()`);
  let mac = {};
  try {
    mac = { os: execFileSync('sw_vers', { encoding: 'utf8' }).trim().replace(/\n/g, ' | '), cpu: execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim() };
  } catch { /* not macOS */ }
  const raf = measureRaf ? await page.measureRaf({ frames: rafFrames }) : null;
  return {
    chrome: info.product, protocol: info.protocolVersion, pid: browser.pid, launch: { channel: browser.options?.chrome, dprFlag: browser.options?.dpr ?? null, nativeDrawElement: !!browser.options?.nativeDrawElement, scrollbars: browser.options?.scrollbars },
    viewport, focus: await page.focusState(), focusEmulated: page.focusEmulated, scrollbar: await page.evaluate(SCROLLBAR_PROBE_EXPR), ...inPage, mac,
    rafMeasured: raf ? { n: raf.n, p50Ms: raf.p50, p95Ms: raf.p95, maxMs: raf.max, impliedHz: raf.hz } : null,
  };
}
