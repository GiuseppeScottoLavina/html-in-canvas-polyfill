#!/usr/bin/env node
// True plain-DOM pixel oracle for snapshot-capture: a compositor SCREENSHOT of the plain-DOM fixture against the tile of the same drawable
// (fixtures in mode=ref: the canvas is a div, its children are the drawables). Gate: <= 3 % of the pixels with a channel delta > 16.
//   node test/unit/snapshot-capture/oracle.driver.mjs [--fixtures=f1,f2,f3,f5] [--dpr=1,2,1.5] [--out=.scratch/capture-oracle]
// Not a unit test (needs a screenshot); run it by hand. Headless Chrome with its own throwaway profile; positive controls included.
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as H from '../../harness/index.mjs';

const { values: opt } = parseArgs({ options: { fixtures: { type: 'string', default: 'f1,f2,f3,f5' }, dpr: { type: 'string', default: '1,2' }, out: { type: 'string', default: '.scratch/capture-oracle' }, prune: { type: 'boolean', default: false } } });
const OUT = join(H.PROJECT_ROOT, opt.out);
mkdirSync(OUT, { recursive: true });

const SCENARIOS = {
  f1: [{ name: 'rest' }],
  f2: [{ name: 'top' }, { name: 'list-scrolled-410', scroll: { '#list': 410 } }, { name: 'side-scrolled', scroll: { '#side': 120, '#list': 33 } }],
  f3: [{ name: 'rest' }],
  f5: [{ name: 'rest' }, { name: 'scrolled', scroll: { '#sc-v': 200, '#sc-both': 90 } }],
};

const srv = await H.startServer();
const results = [];
let failed = false;
for (const dpr of opt.dpr.split(',').map(Number)) {
  const classic = true;
  const browser = await H.launchChrome({ name: 'capture-oracle', dpr, windowSize: [1400, 1000], extraArgs: ['--headless=new'], scrollbars: classic ? 'default' : 'hidden' });
  try {
    for (const fx of opt.fixtures.split(',')) {
      const [fid, nodes] = fx.split(':');
      for (const sc of SCENARIOS[fid] ?? [{ name: 'rest' }]) {
        const page = await browser.newPage({ reuseFirst: true });
        await H.openFixture(page, srv, fid, { mode: 'ref', nodes: nodes ? +nodes : undefined });
        // a drawable at a fractional x or y is painted by the page with snapped text and by the tile at an integer origin; centred fixtures need an inner width that keeps the margin whole
        await page.setInnerSize(fid === 'f2' ? 1301 : 1300, 900);
        await H.sleep(150);
        // The tile is the drawable at a whole device-pixel origin, which is how a canvas grid draws it (native included: its canvas output does not depend on where the page
        // puts the canvas, measured at DPR 1.25 / 1.5 against Canary, G-pixel-dpr). At DPR 1.25 / 1.5 a whole css origin can be half a device pixel, where the page snaps text
        // differently and the screenshot clip resamples by half a pixel: the reference is moved by that fraction (a relative offset of <body>, no layout change).
        const shift = await page.evaluate(`(() => { const s = document.querySelector('#hic-surface'); const r = (s.firstElementChild || s).getBoundingClientRect(); const d = devicePixelRatio;
          const fx = (Math.ceil(r.left * d - 1e-6) - r.left * d) / d, fy = (Math.ceil(r.top * d - 1e-6) - r.top * d) / d;
          if (fx > 1e-6 || fy > 1e-6) { document.body.style.position = 'relative'; document.body.style.left = fx + 'px'; document.body.style.top = fy + 'px'; }
          return [fx, fy]; })()`);
        if (shift[0] || shift[1]) await H.sleep(100);
        const tiles = await page.evaluate(`(async () => { const m = await import('/test/unit/snapshot-capture/oracle.page.mjs'); return m.run('#hic-surface', ${JSON.stringify({ scale: dpr, scroll: sc.scroll, prune: opt.prune })}); })()`);
        const shotOf = async (rect) => decodeShot(await page.screenshot({ clip: { ...rect, scale: 1 } }));
        for (const t of tiles) {
          let tile = H.compositeOver(H.decodePng(Buffer.from(t.png.split(',')[1], 'base64')), t.bg);
          // the clip on whole device pixels with the tile's own pixel size (a fractional clip is resampled or rounded by one pixel at the edges)
          const clip = { x: Math.round(t.rect.x * dpr) / dpr, y: Math.round(t.rect.y * dpr) / dpr, width: tile.width / dpr, height: tile.height / dpr };
          let ref = await shotOf(clip);
          // a fractional border box (F1: 1178.4 css px, read as 1178.4000244 through getBoundingClientRect) can round to one more tile pixel than the screenshot has:
          // compare the common area (at most one row / column left out)
          if (Math.abs(tile.width - ref.width) <= 1 && Math.abs(tile.height - ref.height) <= 1 && (tile.width !== ref.width || tile.height !== ref.height)) {
            const w = Math.min(tile.width, ref.width), h = Math.min(tile.height, ref.height);
            tile = H.cropImage(tile, 0, 0, w, h); ref = H.cropImage(ref, 0, 0, w, h);
          }
          const cmp = H.compareImages(tile, ref, { tolerance: 16 });
          // positive controls: the oracle must see a 3 css px shift and a blank tile
          let shifted = await shotOf({ ...clip, x: clip.x + 3, y: clip.y + 3 });
          if (shifted.width !== tile.width || shifted.height !== tile.height) shifted = H.cropImage(shifted, 0, 0, Math.min(tile.width, shifted.width), Math.min(tile.height, shifted.height));
          const ctl = H.compareImages(tile, shifted, { tolerance: 16 });
          const stats = H.pixelStats(tile);
          const row = {
            fixture: fx, scenario: sc.name, dpr, drawable: t.id, size: [tile.width, tile.height], fraction: +(cmp.fraction * 100).toFixed(3), maxDiff: cmp.maxDiff, nodes: t.nodes, complete: t.complete,
            rect: t.rect, unsupported: t.unsupported.map((u) => u.feature), kb: +(t.bytes / 1024).toFixed(1), shiftControl: +(ctl.fraction * 100).toFixed(2), nonBlank: stats.nonBlank, ms: t.ms,
          };
          row.pass = cmp.sizeMatch && cmp.fraction <= 0.03 && stats.nonBlank && ctl.fraction > cmp.fraction && t.complete;
          if (!row.pass) failed = true;
          results.push(row);
          const base = `${fx.replace(':', '')}-${sc.name}-dpr${dpr}`;
          writeFileSync(join(OUT, `${base}.tile.png`), H.encodePng(tile));
          writeFileSync(join(OUT, `${base}.ref.png`), H.encodePng(ref));
          if (cmp.diffImage) writeFileSync(join(OUT, `${base}.diff.png`), H.encodePng(cmp.diffImage));
          console.log(`${row.pass ? 'ok  ' : 'FAIL'} ${fx} ${sc.name} dpr${dpr} ${t.id}: ${row.fraction} % (max delta ${row.maxDiff}), shift control ${row.shiftControl} %, ${row.kb} KB, ${row.nodes} nodes${row.unsupported.length ? ', unsupported ' + row.unsupported : ''}`);
        }
        await page.close();
      }
    }
  } finally { await browser.close(); }
}
writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 1));
await srv.close();
console.log(failed ? 'oracle: FAILED' : 'oracle: OK');
process.exit(failed ? 1 : 0);

function decodeShot(buf) { return H.decodePng(buf); }
