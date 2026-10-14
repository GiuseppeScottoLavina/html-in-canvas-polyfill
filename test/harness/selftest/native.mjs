// Native-baseline mode: a SEPARATE Chrome launched with --enable-blink-features=CanvasDrawElement (its own profile, own PID).
// Controls: the stock browser (main selftest browser) must NOT expose drawElementImage; the flag browser must.
import { resolve } from 'node:path';
import { launchChrome } from '../lib/chrome.mjs';
import { NATIVE_PROBE_EXPR } from '../lib/env.mjs';
import { openFixture } from '../lib/fixtures.mjs';
import { referenceDiff } from '../lib/oracle-pixel.mjs';
import { loadSnapshot } from '../lib/load.mjs';

export async function run({ check, info, srv, outDir, chrome, R }) {
  const stock = R.nativeProbeStock;
  const b = await launchChrome({ name: 'selftest-native', chrome, nativeDrawElement: true });
  try {
    const page = await b.newPage();
    await page.requireForeground('native section');
    await page.navigate(`${srv.url}/test/harness/selftest-fixture/app.html`);
    const probe = await page.evaluate(NATIVE_PROBE_EXPR);
    check('flag browser exposes ctx.drawElementImage (native baseline available)', probe.hasDrawElementImage === true, probe.canvasReflection);
    check('control: stock browser (no flag) did NOT expose it', stock?.hasDrawElementImage === false, stock?.canvasReflection);
    info('native reflection', { canvas: probe.canvasReflection, ctx2d: probe.ctx2dProtoMatches, globals: probe.globalsMatches });
    // the launch tab can carry an infobar (shorter viewport): the pair is compared in two freshly created tabs of equal size
    const ref = await b.newPage({ reuseFirst: false }); const surf = await b.newPage({ reuseFirst: false });
    await ref.bringToFront(); await openFixture(ref, srv, 'f1', { mode: 'ref' });
    await surf.bringToFront();
    const o = await openFixture(surf, srv, 'f1', { mode: 'native' });
    check('f1 mode=native: opened, painter drew a frame, no fixture error', o.state.ready && !o.state.fatal, o.state);
    await new Promise(r => setTimeout(r, 400));
    const d = await referenceDiff({ surfacePage: surf, refPage: ref, selector: '#hic-surface', outDir: resolve(outDir, 'native'), name: 'f1-native' });
    check('f1 native canvas is NON-BLANK (readback)', d.surfaceNonBlank, { surfaceStats: d.surfaceStats });
    info('f1 native vs plain DOM (informational; native Chrome 154 earlier measured 0.27 %)', { diffPixels: d.diffPixels, maxDiff: d.maxDiff, countOver16: d.countOver16, fraction: d.fraction, pass: d.pass, reasons: d.reasons });
    R.nativeLoad = loadSnapshot({ ownPids: [b.pid] });
  } finally { R.nativeClose = await b.close(); }
  check('native Chrome terminated, profile removed', R.nativeClose.remaining.length === 0 && R.nativeClose.profileRemoved === true, R.nativeClose);
}
