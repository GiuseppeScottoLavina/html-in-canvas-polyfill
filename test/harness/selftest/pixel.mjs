// Pixel helpers: why every pixel comparison needs a non-blank test, and canvas readback of a real drawn canvas.
import { readCanvas } from '../lib/oracle-pixel.mjs';
import { pixelStats, compareImages } from '../lib/pixels.mjs';

export async function run({ check, srv, page }) {
  // a blank surface against a BLANK reference would be a perfect 0 diff: the non-blank test must refuse it
  const emptyImg = { width: 40, height: 30, data: new Uint8Array(40 * 30 * 4).fill(255) };
  const cmp = compareImages(emptyImg, emptyImg);
  check('control: two blank images diff to 0 (why the non-blank test exists)', cmp.diffPixels === 0 && !pixelStats(emptyImg).nonBlank, { diffPixels: cmp.diffPixels });
  const transparent = { width: 40, height: 30, data: new Uint8Array(40 * 30 * 4) };
  check('a fully transparent canvas is blank', !pixelStats(transparent).nonBlank);
  await page.navigate(`${srv.url}/test/harness/selftest-fixture/pixel.html?view=canvas&variant=same`);
  await page.waitForFunction('window.__PIXEL?.ready');
  await page.requireForeground('pixel section');
  const img = await readCanvas(page, '#surface');
  check('readCanvas reads a real drawn canvas back from the page, non-blank', img.width > 0 && pixelStats(img).nonBlank, { w: img.width, h: img.height });
}
