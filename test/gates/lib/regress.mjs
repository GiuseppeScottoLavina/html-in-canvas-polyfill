// Shared by the regression gates of the review findings (fixtures under test/gates/fixtures/regress).
import { H } from './gate.mjs';

export const REGRESS = '/test/gates/fixtures/regress/';

/** URL of a regress fixture with the bundle under test (poly) and extra query params. */
export function regressUrl(ctx, file, params = {}, { bundle = true } = {}) {
  const u = new URL(REGRESS + file, ctx.srv.url);
  if (bundle) u.searchParams.set('bundle', ctx.bundle);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u.href;
}

/** Open a regress page, foreground it, wait for the first paint. */
export async function openRegress(ctx, page, file, params = {}) {
  await page.navigate(regressUrl(ctx, file, params));
  await ctx.focus(page);
  await page.waitForFunction('(window.__paints || 0) >= 1', { timeout: 8000 });
  await H.sleep(300);
}

/** The number of pixels that differ by more than 8 levels in any channel between two RGBA buffers given as base64, or null when their sizes differ. */
export function differingPixels(aBase64, bBase64) {
  const A = Buffer.from(aBase64, 'base64'), B = Buffer.from(bBase64, 'base64');
  if (A.length !== B.length) return null;
  let differ = 0;
  for (let p = 0; p < A.length; p += 4) { let m = 0; for (let k = 0; k < 4; k++) m = Math.max(m, Math.abs(A[p + k] - B[p + k])); if (m > 8) differ++; }
  return differ;
}

/** The query of proportional-counter.html for M6 of G-regress-paint and G-regress-paint-rate: the Georgia counter beside 2,000 inline cells, with a label wider than the
 *  ink margins around the counter, so the counter's own damage cannot cover where it moves its neighbours. */
export const LARGE_COUNTER = { font: 'georgia', filler: 2000, label: 'your total score' };
