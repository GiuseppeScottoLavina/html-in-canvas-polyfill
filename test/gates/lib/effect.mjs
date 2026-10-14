// Effect-host setup shared by the effect gates: the F1 page with the polyfill and `painter=none` (the page draws nothing itself), then the water plugin over the form
// through the PUBLIC `HTMLInCanvasEffects.createHost`. Frame stamps and clicks are recorded page-side.
import { H } from './gate.mjs';

/** @param {*} ctx @param {*} page @param {{interposer?:boolean, intensity?:number, installListeners?:boolean}} o */
export async function setupEffect(ctx, page, { interposer = true, intensity = 0.28, extraParams = {} } = {}) {
  // the core, then the optional effects and water bundles (docs/BUNDLES.md), exactly as a page loads them
  await page.navigate(H.fixtureUrl(ctx.srv, 'f1', { mode: 'poly', bundle: ctx.effectsBundle, params: { painter: 'none', ...extraParams } }));
  await page.waitForFunction('!!window.__HIC__ && !!window.HTMLInCanvasEffects && !!window.HicLiveEffectsWater', { timeout: 10000 });
  return page.evaluate(`(async () => {
    const canvas = document.querySelector('#hic-surface'); const form = document.querySelector('#demo-form');
    window.__frames = []; canvas.addEventListener('effectframe', () => window.__frames.push(performance.now()));
    window.__errs = []; canvas.addEventListener('effecterror', (e) => window.__errs.push(String(e.detail && e.detail.error)));
    window.__clicks = { submit: 0, consent: 0 };
    document.querySelector('#submit-button').addEventListener('click', (e) => { e.preventDefault(); window.__clicks.submit++; }, true);
    document.querySelector('#demo-form').addEventListener('submit', (e) => e.preventDefault(), true);
    const host = await HTMLInCanvasEffects.createHost(canvas, form, { maxDpr: 2.5, interposer: ${interposer} });
    window.__host = host;
    window.__water = await host.addPlugin(HicLiveEffectsWater.WaterEffectPlugin, { intensity: ${intensity} });
    await new Promise((r) => setTimeout(r, 700));
    return JSON.stringify({ stats: host.stats() });
  })()`);
}
