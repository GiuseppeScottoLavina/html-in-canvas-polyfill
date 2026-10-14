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
