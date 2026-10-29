// Repo gates that need no browser: G-size, G-deps, G-no-blob, G-plugins, G-doc-sync (--docs only checks docs).
//   node scripts/check-repo.mjs          size + deps + no-blob + plugin folder contract + doc sync
//   node scripts/check-repo.mjs --docs   doc sync only
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const docsOnly = process.argv.includes('--docs');
// --allow-size: a G-size problem is printed as KNOWN RED but does not fail `npm test`. The thresholds themselves are not changed.
const allowSize = process.argv.includes('--allow-size');
const problems = [];

// G-size counts CODE lines only: blank lines and comment-only lines (// and block comments) are not counted.
function codeLines(text) {
  let n = 0, inBlock = false;
  for (const raw of text.split('\n')) {
    let l = raw.trim();
    if (inBlock) { const e = l.indexOf('*/'); if (e < 0) continue; l = l.slice(e + 2).trim(); inBlock = false; }
    while (l.startsWith('/*')) { const e = l.indexOf('*/'); if (e < 0) { inBlock = true; l = ''; break; } l = l.slice(e + 2).trim(); }
    if (l === '' || l.startsWith('//')) continue;
    n++;
  }
  return n;
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out); else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

if (!docsOnly) {
  const files = walk(join(root, 'src'));
  let total = 0;
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    const lines = codeLines(text);
    total += lines;
    const rel = relative(root, f).split(sep).join('/');
    if (lines > 1000) problems.push(`G-size: ${rel} has ${lines} lines (> 1000 code lines)`);
    if (/URL\.createObjectURL|['"`]blob:/.test(text)) problems.push(`G-no-blob: ${rel} uses blob: URLs (taints every sink on Chrome/Safari)`);
    // G-deps: module boundaries (docs/ARCHITECTURE.md section 1)
    if (rel.split('/').length === 2) continue; // src/index.js, src/iife.js: entry points
    const area = rel.split('/')[1];
    const sub = rel.split('/')[2];
    const imports = [...text.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)].map((m) => m[1]);
    for (const imp of imports) {
      const target = relative(root, join(dirname(f), imp)).split(sep).join('/');
      const tArea = target.split('/')[1];
      const tSub = target.split('/')[2];
      if (tArea === 'contracts' || tArea === 'util') continue;
      if (area === 'contracts' || area === 'util') problems.push(`G-deps: ${rel} (leaf) imports ${target}`);
      else if (area === 'api') continue; // api/ is the composition root and the surface
      else if (area === tArea) {
        if (area === 'snapshot' && sub !== tSub) problems.push(`G-deps: ${rel} imports across snapshot/${tSub} (${target}); capture and store talk only through CaptureFn`);
      } else if (!(tArea === 'api' && /patch\.js$/.test(target))) problems.push(`G-deps: ${rel} imports ${target} (other module); use the typed interface instead`);
    }
  }
  // The core ceiling is not a hard design limit: it is raised deliberately, one measured reason at a time (conformance fixes, Firefox / Safari support, the performance work).
  // 12650 -> 12700 (2026-10-15): the page-scroll watch that re-measures sticky / fixed drawables (live/geometry-apply.js, live/live-layer.js).
  // 12700 -> 12850 (2026-10-15, measured 12,827): large drawables (row damage from the children that moved, trailing content left out of pruned tiles), the WebGPU fallback order.
  // 12850 -> 12875 (2026-10-16, measured 12,855): the exact classic scrollbar gutter (snapshot/capture/scroll-emulation.js).
  // 12875 -> 13000 (2026-10-16, measured 12,964): phones and tablets (mobile browser gate, phone budgets, the iOS control look in the WebKit painter).
  // 13000 -> 13150 (2026-10-16, measured 13,119; 13,015 before this step): the Android fixes (listbox selection, toggle zoom, the indeterminate look, the listbox thumb) and
  // the native bridge for Safari Technology Preview's HTML-in-Canvas internal feature (paint requests, standard draw size, device-pixel box in the native modes).
  // 13150 -> 13250 (2026-10-16, measured 13,225; 13,133 before this step): plugin actions in the effects host (handle.trigger / settled, the declared `actions` of ABI v2).
  // 13250 -> 13475 (2026-10-17, measured 13,462; 13,225 before this step): text selections in the engine's colours on every platform (the selection foreground,
  // author ::selection colours, selected page text recoloured in the clone, the glyph copy of a field, the line box and line-break marks; snapshot/capture/selection-paint.js).
  // 13475 -> 13575 (2026-10-19, measured 13,570; 13,462 before this step): the off-screen pause of the effect host (effects/visibility.js: the IntersectionObserver
  // with its margin, the document's visibility, the scroll check for jumps into view; the paused frame hook and the settle frames of pending actions).
  // 13475 -> 13525 (2026-10-19, measured 13,509; 13,462 before this step): the cheaper clone walk (a per-build frame measurer in live/measure.js and LiveLayer, scroll metrics
  // read only of scroll containers, one top-layer query, the token collector skipping repeated class / style values).
  // 13475 -> 13900 (2026-10-19, measured 13,858; 13,460 before this step): inner scrolling at the display rate (live/scroll-sync.js, the per-scroller validity, dirty
  // page regions and rounded ports of snapshot/store/scroll-compose.js, planning in steps, scroll damage outside maxSnapshotFps, paint-only :hover damage).
  // 13575 / 13525 / 13900 -> 14025 (2026-10-19, measured 14,012 with the three steps above together: 13,462 + 108 + 47 + 395).
  // 14025 -> 14075 (2026-10-19, measured 14,053; 14,012 before this step): the scroll synchronisation kept out of the author's sight (the transition hold released in two
  // style updates, the clip of the colour layer, no synchronisation of animated, shadow-host or slotted scrollers).
  // 14075 -> 14100 (2026-10-19, measured 14,083; 14,053 before this step): the truncation test measured once per scroller for its pages (clone.js tailClear, the compositor's memo).
  // 14100 -> 14325 (2026-10-21, measured 14,308; 14,090 before this step): Chromium's classic scrollbars as the platform paints them (snapshot/capture/chromium-bars.js, the
  // bar painter and listbox bar of scroll-emulation.js), the bar-sized intrinsic width of textarea / listbox select pinned in the clone, the raster scale and 1:1 draw
  // of a grid rounded from a fractional device-pixel content box (snapshot/store/surfaces.js gridRasterScale, api/draw-math.js snapDefaultSize).
  // 14325 -> 14400 (2026-10-22, measured 14,399; 14,308 before this step): content the browser leaves out of a canvas drawn as the browser draws it (state-sync.js
  // syncEmbedded / ownBox), SVG filters and masks under the native read-back rules (svg-refs.js settleFilterImages, addOutsideMasks).
  // 14400 -> 14575 (2026-10-22, measured 14,556; 14,399 before this step): same-origin frames drawn (snapshot/capture/frame-doc.js) and their documents observed for changes
  // (schedule/observers/mutation-observer.js).
  // 14575 -> 14600 (2026-10-22, measured 14,579; 14,556 before this step): canvases of declarative shadow roots, paint events in shadow-including tree order (util/tree-order.js).
  // 14600 -> 14900 (2026-10-22, measured 14,880; 14,591 before this step): an ElementImage in a dedicated worker (api/worker-transfer.js and worker-wire.js on the page,
  // api/worker-scope.js in the worker bundle).
  // 14900 -> 14925 (2026-10-22, measured 14,903; 14,881 before this step): the drawable's own backdrop-filter applied by the draw (api/context2d-patch.js).
  // 14925 -> 14975 (2026-10-22, measured 14,965; 14,903 before this step): a playing video repaints its drawable (schedule/observers/video-observer.js).
  // 14975 -> 15250 (2026-10-22, measured 15,243 with the steps above; 14,965 before this step, +271 measured alone on 14,308): the effects over a browser's own HTML-in-Canvas implementation (effects/native-geometry.js,
  // effects/native-interposer.js, the native source provider and frame source, the native checks of the effect host, the frameCap property in the native modes).
  // 15250 -> 15275 (2026-10-22, measured 15,261; 15,243 before this step): the hover sync element of the native effects shared per document, its changes inside a
  // closed shadow root (effects/native-geometry.js createHoverSync).
  // 15275 -> 15400 (2026-10-22, measured 15,374; 15,268 before this step): read-back-allowed rules of WPT master (unreadable mask images, external SVG <use>, the video
  // poster and cross-origin video, popover toggles, moveBefore() into a canvas).
  // 15400 -> 15375 (2026-10-22, measured 15,355 with the WPT re-pin merged: the two-argument getElementTransform removed, the privacy review fixes added).
  // 15375 -> 15875 (2026-10-22, measured 15,861; 15,364 before these steps): animated images (+313, schedule/observers/animated-images.js), the ancestor-change
  // filter (+90, mutation-observer.js watchAncestors), the image-map <area> focus ring (+44), selectAllChildren / selectNodeContents of a canvas (+25), slotted drawables (+25).
  // 15375 -> 15425 (2026-10-23, measured 15,419; 15,364 before this step): the references inside an external SVG <use> document resolved against that document (its
  // ids, classes and <style> rules scoped to it; svg-refs.js addUseTargets), clip paths outside the drawable copied, the read-back rules applied to copied <use> targets.
  // 15425 -> 15475 (2026-10-23, measured 15,457; 15,419 before this step): the macOS overlay thumb of a scrollable listbox select (scroll-emulation.js macOverlayThumb).
  // 15875 -> 15975 (2026-10-26, measured 15,959 with both step lists above merged; 15,861 with the animated images and the WPT steps alone): the two lists were
  // measured on separate branches; merged, the external <use> documents and the overlay listbox thumb add their lines on top.
  // 15975 -> 16000 (2026-10-27, measured 15,994; 15,965 before this step): the scroll compositor on WebKit (+29: the css px layout grid of the snapshot image in the
  // planner and the store, snapPx / outPx / rowOf, the source-over rounded port and its opaque flag).
  // 16000 -> 16025 (2026-10-27, measured 16,010; 15,994 before this step): spacers reach the clone at the live height to the LayoutUnit (+16: clone.js onLiveGrid,
  // layoutPx and the 1000 px bound of a spacer and a merged run; the drift between composed frames and settled tiles on Chromium).
  // 16025 -> 16050 (2026-10-27, measured 16,039; 16,010 before this step): the scroll compositor on Gecko (+29: scroll-pages.js clipInvariant and the 1x rule,
  // scroll-compose.js wholeRow and the re-plan after a change inside the content)
  // 16050 -> 16075 (2026-10-27, measured 16,052; 16,039 before this step): a canvas that never paints stops asking for an in-frame first snapshot (+13: scheduler.js
  // firstDue and Entry.firstSince; scroll-compose.js placeOf, a refused scroller planned again once it has moved on screen)
  // 16075 -> 16125 (2026-10-29, measured 16,121; 16,052 before this step): the first touch gesture is composed (+69: the scrollers a tile finds, clone.js
  // maybeScroll; store.scrollWarm and its candidates; scroll-compose.js prepare `early`, AHEAD_PAGES and yieldToInput; scroll-observer.js the rest timer after a
  // commit on a touch-first device; interaction-tracker.js a finger hovers only by a tap)
  if (total > 16125) problems.push(`G-size: core is ${total} code lines (> 16125)`);
  console.log(`checked ${files.length} files, ${total} code lines (comments and blanks not counted)`);

  // G-plugins: every folder of plugins/ (the template included, the shared test kit excluded) satisfies the folder contract of plugins/README.md
  // (plugins/_lib/, runtime code shared by plugins, is held to the same import rules)
  const { LIB_DIR, checkPluginFolder, checkSharedLib } = await import(pathToFileURL(join(root, 'plugins/_shared/contract.mjs')).href);
  const folders = readdirSync(join(root, 'plugins')).filter((n) => n !== '_shared' && n !== LIB_DIR && !n.startsWith('.') && statSync(join(root, 'plugins', n)).isDirectory());
  for (const n of folders) problems.push(...(await checkPluginFolder(join(root, 'plugins', n))).map((/** @type {string} */ m) => `G-plugins: ${m}`));
  problems.push(...checkSharedLib(join(root, 'plugins', LIB_DIR)).map((/** @type {string} */ m) => `G-plugins: ${m}`));
  const pluginsReadme = readFileSync(join(root, 'plugins/README.md'), 'utf8');
  for (const n of folders.filter((x) => !x.startsWith('_'))) if (!pluginsReadme.includes(`| [\`${n}\`](${n}/) |`)) problems.push(`G-plugins: plugins/README.md has no row for ${n}`);
  console.log(`checked ${folders.length} plugin folders`);
}

// G-doc-sync: the generated block of the matrix is exactly what scripts/gen-support-matrix.mjs renders from src/contracts/features.js
const { MATRIX_PATH, renderMatrix } = await import(pathToFileURL(join(root, 'scripts/gen-support-matrix.mjs')).href);
const matrix = readFileSync(MATRIX_PATH, 'utf8');
if (renderMatrix(matrix) !== matrix) problems.push('G-doc-sync: docs/SUPPORT-MATRIX.md differs from the table of src/contracts/features.js (run npm run docs:sync)');

const known = allowSize ? problems.filter((p) => p.startsWith('G-size')) : [];
const blocking = problems.filter((p) => !known.includes(p));
if (known.length) console.warn('KNOWN RED (G-size):\n' + known.join('\n'));
if (blocking.length) { console.error(blocking.join('\n')); process.exit(1); }
console.log('repo gates: OK');
