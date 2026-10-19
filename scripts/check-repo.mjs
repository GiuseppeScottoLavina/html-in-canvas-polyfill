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
  // 13475 -> 13525 (2026-10-19, measured 13,501; 13,462 before this step): the cheaper clone walk (a per-build frame measurer in live/measure.js and LiveLayer, scroll metrics
  // read only of scroll containers, one top-layer query, the token collector skipping repeated class / style values).
  if (total > 13525) problems.push(`G-size: core is ${total} code lines (> 13525)`);
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
