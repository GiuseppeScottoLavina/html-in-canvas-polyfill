// Window helpers.
//  * dragResize      REAL window resize: Browser.setWindowBounds in small steps at a given cadence (what a user's drag does).
// A REAL DPR needs launchChrome({dpr}) (or moving monitors).
import { paced, sleep } from './util.mjs';

/** In-page recorder of `resize` events and the sizes they carried. */
export async function installResizeRecorder(page) {
  await page.evaluate(`(() => { const r = window.__hicResize = { events: [] }; addEventListener('resize', () => r.events.push([performance.now(), innerWidth, innerHeight, devicePixelRatio])); return true; })()`);
}
export async function readResizeRecorder(page) {
  const ev = await page.evaluate('window.__hicResize?.events ?? []');
  return {
    resizeEvents: ev.length, distinctWidths: new Set(ev.map(e => e[1])).size, distinctHeights: new Set(ev.map(e => e[2])).size,
    firstToLastMs: ev.length > 1 ? ev[ev.length - 1][0] - ev[0][0] : 0, lastSize: ev.length ? { width: ev[ev.length - 1][1], height: ev[ev.length - 1][2] } : null,
  };
}

const lerpSizes = (from, to, steps) => Array.from({ length: steps }, (_, i) => {
  const f = (i + 1) / steps; return { width: Math.round(from.width + (to.width - from.width) * f), height: Math.round(from.height + (to.height - from.height) * f) };
});

/**
 * Real window-drag resize. `to`/`from` are INNER (viewport) sizes; the browser-chrome delta is added automatically.
 * The window keeps its top-left corner, like dragging the bottom-right handle.
 * @param {import('./page.mjs').Page} page
 * @param {{to:{width:number,height:number}, from?:{width:number,height:number}, steps?:number, intervalMs?:number, settleMs?:number}} o
 * @returns {Promise<{kind:'real-window-drag', injector:import('./util.mjs').PacedReport, pageSaw:object, start:object, finalInner:object, reachedTarget:boolean}>}
 */
export async function dragResize(page, { to, from, steps = 30, intervalMs = 16, settleMs = 400 } = {}) {
  if (from) await page.setInnerSize(from.width, from.height);
  const v0 = await page.viewport();
  const dW = v0.outerWidth - v0.innerWidth, dH = v0.outerHeight - v0.innerHeight;
  const start = { width: v0.innerWidth, height: v0.innerHeight };
  await installResizeRecorder(page);
  const { windowId } = await page.getWindow();
  const path = lerpSizes(start, to, steps);
  const injector = await paced(steps, intervalMs, i => page.conn.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal', width: path[i].width + dW, height: path[i].height + dH } }));
  await sleep(settleMs);
  const v1 = await page.viewport();
  return { kind: 'real-window-drag', injector, pageSaw: await readResizeRecorder(page), start, finalInner: { width: v1.innerWidth, height: v1.innerHeight },
    reachedTarget: v1.innerWidth === to.width && v1.innerHeight === to.height };
}
