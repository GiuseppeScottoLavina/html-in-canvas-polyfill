// Per-rAF blank-frame detector with POSITIVE CONTROLS (a width write that blanks the canvas must be caught; a clean run must not fire).
import { startBlankDetector } from '../lib/oracle-blank.mjs';
import { sleep } from '../lib/util.mjs';

export async function run({ check, info, page, srv }) {
  await page.navigate(`${srv.url}/test/harness/selftest-fixture/app.html`);
  await page.waitForFunction('window.__APP_READY');
  await page.requireForeground('blank section');

  const clean = await startBlankDetector(page, { selector: '#bd' }).then(async dd => { await sleep(500); return dd.stop(); });
  check('detector: clean run has 0 blank frames (no false positives)', clean.valid && clean.blankFrames.length === 0, { frames: clean.frames, baseline: clean.baseline });
  info('observer overhead per sample (grid 96x64) at DPR ' + (await page.evaluate('devicePixelRatio')), clean.sampleCostMs);
  info('rAF frame gaps seen by the detector', clean.frameGapMs);

  // the bug class this exists for: a canvas.width write clears the bitmap and nothing redraws for a few frames
  const d = await startBlankDetector(page, { selector: '#bd' });
  await sleep(150);
  await page.evaluate('__fx.clearViaWidth()');
  await sleep(60); // ~7 frames at 120 Hz
  await page.evaluate('__fx.drawBd()');
  await sleep(150);
  const r = await d.stop();
  check('canvas.width write left blank for several frames: detected as ONE run of >= 3 frames', r.blankRuns === 1 && r.longestBlankRun >= 3, { runs: r.blankRuns, longest: r.longestBlankRun, frames: r.frames });
  check('backing-store size writes are listed (here: same size, so none)', Array.isArray(r.sizeChanges), r.sizeChanges);

  // a real size change must show up in sizeChanges (each one clears a 2D canvas)
  const d2 = await startBlankDetector(page, { selector: '#bd' }); await sleep(100);
  await page.evaluate('(() => { const c = document.getElementById("bd"); c.width += 2; __fx.drawBd(); })()'); await sleep(120);
  const r2 = await d2.stop();
  check('a backing-store size write is reported in sizeChanges', r2.sizeChanges.length === 1, r2.sizeChanges);
  await page.evaluate('(() => { const c = document.getElementById("bd"); c.width -= 2; __fx.drawBd(); })()');

  // an app that never drew anything cannot pass: invalid run
  await page.evaluate('(() => { const c = document.createElement("canvas"); c.id = "never-drawn"; c.width = 200; c.height = 100; document.body.appendChild(c); })()');
  const d3 = await startBlankDetector(page, { selector: '#never-drawn' }); await sleep(200);
  const r3 = await d3.stop();
  check('a canvas that never had content gives an INVALID run (never a silent pass)', r3.valid === false, { valid: r3.valid, blank: r3.blankFrames.length });
  const d4 = await startBlankDetector(page, { selector: '#bd' }).then(async dd => { await sleep(300); return dd.stop(); });
  check('sanity: after the controls the real canvas is clean again', d4.valid && d4.blankFrames.length === 0, { frames: d4.frames });
}
