// Pixel oracle + non-blank assertion, with positive controls: a 1-device-pixel change and a missing child MUST be detected,
// an empty canvas MUST fail.
import { resolve } from 'node:path';
import { referenceDiff } from '../lib/oracle-pixel.mjs';
import { assertNonBlank, pixelStats, BlankImageError, compareImages } from '../lib/pixels.mjs';
import { setDpr } from '../lib/window.mjs';

const U = (srv, view, variant = 'same') => `${srv.url}/test/harness/selftest-fixture/pixel.html?view=${view}&variant=${variant}`;

export async function run({ check, info, browser, srv, outDir, page }) {
  const ref = await browser.newPage({ reuseFirst: false }), surf = await browser.newPage({ reuseFirst: false });
  const dir = resolve(outDir, 'pixel');
  const open = async (p, url) => { await p.bringToFront(); await p.navigate(url); await p.waitForFunction('window.__PIXEL?.ready'); await p.requireForeground('pixel section'); };
  const diff = async (variant, name, extra = {}) => { await open(surf, U(srv, 'canvas', variant)); await open(ref, U(srv, 'ref')); await surf.bringToFront();
    return referenceDiff({ surfacePage: surf, refPage: ref, selector: '#surface', outDir: dir, name, ...extra }); };
  const brief = r => ({ diffPixels: r.diffPixels, maxDiff: r.maxDiff, countOver16: r.countOver16, fraction: r.fraction, surfaceNonBlank: r.surfaceNonBlank, pass: r.pass, reasons: r.reasons });

  for (const dpr of [2, 1]) {
    if (dpr === 1) { for (const p of [surf, ref]) await setDpr(p, 1); }
    const tag = `dpr${dpr}`;
    const same = await diff('same', `same-${tag}`);
    check(`[${tag}] identical rendering: diffPixels 0, non-blank, gate passes`, same.diffPixels === 0 && same.surfaceNonBlank && same.pass, brief(same));
    const one = await diff('pixel', `onepixel-${tag}`);
    check(`[${tag}] POSITIVE CONTROL: a single changed device pixel is detected (diffPixels 1, maxDiff > 16)`, one.diffPixels === 1 && one.countOver16 === 1 && one.maxDiff > 16, brief(one));
    check(`[${tag}] ... and the diff PNG was written`, !!one.files, one.files);
    const miss = await diff('missing', `missingchild-${tag}`);
    const expectPx = 80 * 70 * dpr * dpr;
    check(`[${tag}] POSITIVE CONTROL: a missing child is detected (~${expectPx} px) and the gate FAILS`, miss.countOver16 >= expectPx * 0.95 && miss.countOver16 <= expectPx * 1.05 && miss.pass === false && miss.preconditionsOk, brief(miss));
    const blank = await diff('blank', `blank-${tag}`);
    check(`[${tag}] POSITIVE CONTROL: a blank surface fails with a BLANK reason (non-blank assertion)`, blank.surfaceNonBlank === false && blank.pass === false && blank.reasons.some(r => /BLANK/.test(r)), brief(blank));
    if (dpr === 2) {
      const shot = await diff('same', `same-screenshot-${tag}`, { source: 'screenshot' });
      check('screenshot source (compositor) of the canvas variant also matches the plain DOM', shot.pass && shot.surfaceNonBlank, brief(shot));
    }
  }
  // a blank surface against a BLANK reference would be a perfect 0 diff: the oracle must still refuse
  const emptyImg = { width: 40, height: 30, data: new Uint8Array(40 * 30 * 4).fill(255) };
  const cmp = compareImages(emptyImg, emptyImg);
  check('control: two blank images diff to 0 (why the non-blank assertion exists)', cmp.diffPixels === 0 && !pixelStats(emptyImg).nonBlank, { diffPixels: cmp.diffPixels });
  const thrown = (() => { try { assertNonBlank(emptyImg, 'empty canvas'); return null; } catch (e) { return e; } })();
  check('assertNonBlank THROWS BlankImageError on an empty canvas', thrown instanceof BlankImageError, thrown?.message);
  const transparent = { width: 40, height: 30, data: new Uint8Array(40 * 30 * 4) };
  check('assertNonBlank throws on a fully transparent canvas', (() => { try { assertNonBlank(transparent); return false; } catch { return true; } })());
  await open(surf, U(srv, 'canvas', 'same'));
  const live = (await import('../lib/oracle-pixel.mjs')).readCanvas;
  let okImg = null; try { okImg = await live(surf, '#surface'); assertNonBlank(okImg, 'real canvas'); } catch (e) { okImg = e; }
  check('assertNonBlank passes on a real drawn canvas read back from the page', okImg && okImg.width > 0, okImg?.message ?? { w: okImg?.width });
  await setDpr(surf, 2).catch(() => {}); await surf.close(); await ref.close(); await page.bringToFront();
  void info;
}
