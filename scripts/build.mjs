// Build (docs/BUNDLES.md). esbuild is a devDependency only; the library has no runtime deps.
//
//   classic IIFE, each as .js (readable; the gates and the mutants run on it) and .min.js:
//     hic-live-polyfill.iife        core, the 2D path (src/iife.js)
//     hic-live-effects.iife         window.HTMLInCanvasEffects: host, plugin ABI, GPU presenter, interposer (src/effects-iife.js); needs the core
//     hic-live-native-bridge.iife   the native bridge for Chrome 154-156 behind the flag (src/native-bridge.js); loaded BEFORE the core
//     hic-live-gpu.iife             WebGL / WebGPU element textures (src/gpu-iife.js); before or after the core
//     hic-live-engines.iife         the Gecko / WebKit painters (form-control skins, WebKit bars and shadows; src/engines-iife.js); Firefox / Safari, any order with the core
//   ESM with the same split for bundler users: dist/esm/{index,effects,native-bridge}.js (+ shared chunks)
//   effect plugins, discovered by convention (every plugins/<name>/ with an index.js, <name> not starting with '_'; plugins/README.md):
//     dist/plugins/<name>.iife.js, .iife.min.js   classic; registers window.HicLivePlugins.<name> = {meta, plugin, ...the other exports}
//     dist/plugins/<name>.esm.js                  the module, for bundlers
//     dist/plugins/manifest.json                  name, title, description, reducedMotion, defaults and files of every plugin (the gallery reads it)
//     dist/types/plugins/<name>/index.d.ts
//   The .wgsl files of a plugin are inlined: its wgsl.js loader is replaced by a module that returns them as strings. What a plugin imports
//   from plugins/_lib/ and src/effects/no-target.js is bundled into it.
//
//   node scripts/build.mjs [--no-esm] [--quiet]     writes dist/ and dist/sizes.json
import { build } from 'esbuild';
import { cpSync, existsSync, readFileSync, readdirSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, dirname, join, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { LIB_DIR, checkPluginFolder, discoverPlugins } from '../plugins/_shared/contract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const quiet = process.argv.includes('--quiet');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const src = readFileSync(join(root, 'src/version.js'), 'utf8');
const m = /VERSION = '([^']+)'/.exec(src);
if (!m || m[1] !== pkg.version) throw new Error(`VERSION in src/version.js (${m && m[1]}) must equal package.json version (${pkg.version})`);

const common = { bundle: true, target: 'chrome130', legalComments: 'none', logLevel: 'warning' };

/**
 * A built plugin never fetches its shaders: its wgsl.js (a fetch when the plugin runs from source) becomes a module that returns the .wgsl files of
 * the plugin folder as inlined strings.
 * @param {{name: string, dir: string, wgsl: string[]}} p
 */
// the virtual module's path is relative: esbuild prints it in a comment of the readable bundles, which are published (an absolute path leaked the build machine's)
const inlineWgsl = (p) => ({
  name: 'plugin-inline-wgsl',
  setup(/** @type {any} */ b) {
    b.onResolve({ filter: /^\.\/wgsl\.js$/ }, (/** @type {any} */ a) => (a.importer.startsWith(p.dir + sep) ? { path: `plugins/${p.name}/wgsl.js`, namespace: 'plugin-wgsl' } : undefined));
    b.onLoad({ filter: /.*/, namespace: 'plugin-wgsl' }, () => ({
      contents: `const files = { ${p.wgsl.map((f) => `${JSON.stringify(f)}: ${JSON.stringify(readFileSync(join(p.dir, f), 'utf8'))}`).join(', ')} };\n`
        + `export async function wgsl(file) { if (!Object.hasOwn(files, file)) throw new Error('${p.name}: no ' + file + ' in the plugin folder'); return files[file]; }\n`,
      loader: 'js',
    }));
  },
});

/**
 * The classic core carries each feature row as {id, status} only: the summary/reason prose of src/contracts/features.js is ~15 KB minified and nothing at runtime reads it (the store reads
 * `status`; docs/SUPPORT-MATRIX.md is generated from the full table). ESM builds keep the full table. A row that does not match the expected one-line shape fails the build.
 */
const leanFeatures = {
  name: 'lean-features',
  setup(b) {
    b.onLoad({ filter: /contracts[\\/]features\.js$/ }, (a) => {
      const text = readFileSync(a.path, 'utf8');
      const rows = (text.match(/^\s*\{ id: '/gm) ?? []).length;
      let lean = 0;
      const contents = text.replace(/^(\s*\{ id: '[^']+', status: '[^']+'), summary: .*\},?$/gm, (_m, head) => { lean++; return `${head} },`; });
      if (!rows || lean !== rows) throw new Error(`lean-features: ${lean} of ${rows} rows of features.js have the expected one-line shape`);
      return { contents, loader: 'js' };
    });
  },
};

const IIFES = [
  { name: 'hic-live-polyfill', entry: 'src/iife.js', plugins: [leanFeatures] },
  { name: 'hic-live-effects', entry: 'src/effects-iife.js', plugins: [] },
  { name: 'hic-live-native-bridge', entry: 'src/native-bridge.js', plugins: [] },
  { name: 'hic-live-engines', entry: 'src/engines-iife.js', plugins: [] },
  { name: 'hic-live-gpu', entry: 'src/gpu-iife.js', plugins: [] },
];

mkdirSync(join(root, 'dist'), { recursive: true });
// a classic bundle that is no longer built (a renamed or removed entry) must not stay in dist/, where the package and the Pages site would pick it up
const built = new Set(IIFES.flatMap(({ name }) => [`${name}.iife.js`, `${name}.iife.min.js`]));
for (const f of readdirSync(join(root, 'dist'))) if (/\.iife(\.min)?\.js$/.test(f) && !built.has(f)) rmSync(join(root, 'dist', f));
const rows = [];
const measure = (file, path) => {
  const text = readFileSync(path);
  rows.push({ file, raw: text.length, gzip: gzipSync(text, { level: 9 }).length });
};
for (const { name, entry, plugins } of IIFES) {
  for (const min of [false, true]) {
    const file = `${name}.iife${min ? '.min' : ''}.js`;
    await build({ ...common, entryPoints: [join(root, entry)], format: 'iife', minify: min, plugins, outfile: join(root, 'dist', file) });
    measure(file, join(root, 'dist', file));
  }
}

if (!process.argv.includes('--no-esm')) {
  rmSync(join(root, 'dist/esm'), { recursive: true, force: true });
  await build({
    ...common, format: 'esm', splitting: true, outdir: join(root, 'dist/esm'), chunkNames: 'chunks/[name]-[hash]',
    entryPoints: { index: join(root, 'src/index.js'), effects: join(root, 'src/effects.js'), 'native-bridge': join(root, 'src/native-bridge.js') },
  });
  for (const f of ['index.js', 'effects.js', 'native-bridge.js']) measure(`esm/${f}`, join(root, 'dist/esm', f));
}

// ---- effect plugins (plugins/README.md): discovered by convention, each checked against the folder contract before it is built
const plugins = discoverPlugins(root);
const pluginDist = join(root, 'dist/plugins');
rmSync(pluginDist, { recursive: true, force: true });
mkdirSync(pluginDist, { recursive: true });
const manifest = [];
for (const p of plugins) {
  const problems = await checkPluginFolder(p.dir);
  if (problems.length) throw new Error(`plugin contract:\n${problems.join('\n')}`);
  const register = `import * as m from './index.js';\n`
    + `const g = globalThis;\n`
    + `const r = g.HicLivePlugins || Object.defineProperty(g, 'HicLivePlugins', { value: {}, configurable: true }).HicLivePlugins;\n`
    + `Object.defineProperty(r, ${JSON.stringify(p.name)}, { value: Object.freeze({ ...m }), configurable: true, enumerable: true });\n`;
  for (const min of [false, true]) {
    const file = `plugins/${p.name}.iife${min ? '.min' : ''}.js`;
    await build({ ...common, stdin: { contents: register, resolveDir: p.dir, sourcefile: `${p.name}-register.js`, loader: 'js' }, format: 'iife', minify: min, plugins: [inlineWgsl(p)], outfile: join(root, 'dist', file) });
    measure(file, join(root, 'dist', file));
  }
  const files = { iife: `${p.name}.iife.js`, min: `${p.name}.iife.min.js` };
  if (!process.argv.includes('--no-esm')) {
    const file = `plugins/${p.name}.esm.js`;
    await build({ ...common, entryPoints: [join(p.dir, 'index.js')], format: 'esm', plugins: [inlineWgsl(p)], outfile: join(root, 'dist', file) });
    measure(file, join(root, 'dist', file));
    Object.assign(files, { esm: `${p.name}.esm.js` });
  }
  const { meta, plugin } = await import(pathToFileURL(join(p.dir, 'index.js')).href);
  manifest.push({ name: meta.name, title: meta.title, description: meta.description, ...(meta.reducedMotion ? { reducedMotion: meta.reducedMotion } : {}), version: plugin.version, defaults: meta.defaults ?? {}, files });
}
writeFileSync(join(pluginDist, 'manifest.json'), JSON.stringify({ plugins: manifest }, null, 1) + '\n');

// TypeScript declarations generated from the JSDoc types (dist/types/<entry>.d.ts, wired as `types` in package.json exports).
if (!process.argv.includes('--no-esm') && !process.argv.includes('--no-types')) {
  rmSync(join(root, 'dist/types'), { recursive: true, force: true });
  // one emission for src/ and plugins/ (jsconfig.json includes both) under a temporary root: src/ becomes dist/types/, each built plugin
  // dist/types/plugins/<name>/ with its type imports of ../../src/ pointed at dist/types/
  const tmp = join(root, 'dist/.types');
  rmSync(tmp, { recursive: true, force: true });
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'jsconfig.json'), '--noEmit', 'false', '--declaration', '--emitDeclarationOnly',
    '--rootDir', root, '--outDir', tmp], { stdio: 'inherit' });
  cpSync(join(tmp, 'src'), join(root, 'dist/types'), { recursive: true });
  // plugins/_lib/ (runtime code shared by plugins) goes next to them, so that their `../_lib/` type imports resolve
  const libDir = join(root, 'plugins', LIB_DIR);
  for (const dir of [...plugins.map((p) => p.dir), ...(existsSync(libDir) ? [libDir] : [])]) {
    const to = join(root, 'dist/types/plugins', basename(dir));
    cpSync(join(tmp, relative(root, dir)), to, { recursive: true });
    for (const f of readdirSync(to)) if (f.endsWith('.d.ts')) writeFileSync(join(to, f), readFileSync(join(to, f), 'utf8').replaceAll('../../src/', '../../'));
  }
  rmSync(tmp, { recursive: true, force: true });
}

writeFileSync(join(root, 'dist/sizes.json'), JSON.stringify(rows, null, 1) + '\n');

// docs/BUNDLES.md carries no hand-typed byte counts: the table between the markers is generated from the rows just measured (a full build only).
if (!process.argv.includes('--no-esm')) {
  const doc = join(root, 'docs/BUNDLES.md');
  const text = readFileSync(doc, 'utf8');
  const marked = /(<!-- sizes:begin[^\n]*-->\n)[\s\S]*?(<!-- sizes:end -->)/;
  if (!marked.test(text)) throw new Error('docs/BUNDLES.md has no <!-- sizes:begin --> ... <!-- sizes:end --> block');
  const n = (/** @type {number} */ v) => v.toLocaleString('en-US');
  const table = ['| file (in `dist/`) | bytes | gzip (level 9) |', '|---|---|---|', ...rows.map((r) => `| \`${r.file}\` | ${n(r.raw)} | ${n(r.gzip)} |`)].join('\n');
  writeFileSync(doc, text.replace(marked, (_m, a, b) => `${a}${table}\n${b}`));
}
if (!quiet) for (const r of rows) console.log(r.file.padEnd(40), String(r.raw).padStart(8), 'bytes', String(r.gzip).padStart(8), 'gzip');
