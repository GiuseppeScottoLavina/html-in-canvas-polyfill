// Build (docs/BUNDLES.md). esbuild is a devDependency only; the library has no runtime deps.
//
//   classic IIFE, each as .js (readable; the gates and the mutants run on it) and .min.js:
//     hic-live-polyfill.iife        core, the 2D path (src/iife.js)
//     hic-live-effects.iife         window.HTMLInCanvasEffects: host, plugin ABI, GPU presenter, interposer (src/effects-iife.js); needs the core
//     hic-live-effects-water.iife   the water plugin, WGSL inlined (src/effects-water-iife.js); needs the effects bundle
//     hic-live-native-bridge.iife   the native bridge for Chrome 154-156 behind the flag (src/native-bridge.js); loaded BEFORE the core
//     hic-live-gpu.iife             WebGL / WebGPU element textures (src/gpu-iife.js); before or after the core
//     hic-live-engines.iife         the Gecko / WebKit painters (form-control skins, WebKit bars and shadows; src/engines-iife.js); Firefox / Safari, any order with the core
//   ESM with the same split for bundler users: dist/esm/{index,effects,effects-water,native-bridge}.js (+ shared chunks)
//
//   node scripts/build.mjs [--no-esm] [--quiet]     writes dist/ and dist/sizes.json
import { build } from 'esbuild';
import { readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const quiet = process.argv.includes('--quiet');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const src = readFileSync(join(root, 'src/version.js'), 'utf8');
const m = /VERSION = '([^']+)'/.exec(src);
if (!m || m[1] !== pkg.version) throw new Error(`VERSION in src/version.js (${m && m[1]}) must equal package.json version (${pkg.version})`);

const waterDir = join(root, 'src/effects/water');
const common = { bundle: true, target: 'chrome130', legalComments: 'none', loader: { '.wgsl': 'text' }, logLevel: 'warning' };

/** The water plugin never fetches its shader: shader-source.js (a fetch in source mode) becomes a module that returns the inlined water.wgsl. */
const inlineShader = {
  name: 'water-inline-shader',
  setup(b) {
    b.onResolve({ filter: /(^|\/)shader-source\.js$/ }, () => ({ path: 'shader-source', namespace: 'inline-shader' }));
    b.onLoad({ filter: /.*/, namespace: 'inline-shader' }, () => ({
      contents: "import wgsl from './water.wgsl';\nexport const shaderSource = async (shader) => (typeof shader === 'string' && shader !== '' ? shader : wgsl);\n",
      loader: 'js', resolveDir: waterDir,
    }));
  },
};

/** The classic water bundle reuses the definePlugin of the effects bundle already on the page instead of carrying its own copy of the plugin ABI. */
const sharedAbi = {
  name: 'water-shared-abi',
  setup(b) {
    b.onResolve({ filter: /(^|\/)plugin-abi\.js$/ }, (a) => (a.importer.endsWith('water-plugin.js') ? { path: 'plugin-abi', namespace: 'shared-abi' } : undefined));
    b.onLoad({ filter: /.*/, namespace: 'shared-abi' }, () => ({
      contents: "export const definePlugin = (def) => {\n  const api = globalThis.HTMLInCanvasEffects;\n  if (!api) throw new Error('[hic-live-polyfill] load hic-live-effects.iife.js before hic-live-effects-water.iife.js');\n  return api.definePlugin(def);\n};\n",
      loader: 'js',
    }));
  },
};

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
  { name: 'hic-live-effects-water', entry: 'src/effects-water-iife.js', plugins: [inlineShader, sharedAbi] },
  { name: 'hic-live-native-bridge', entry: 'src/native-bridge.js', plugins: [] },
  { name: 'hic-live-engines', entry: 'src/engines-iife.js', plugins: [] },
  { name: 'hic-live-gpu', entry: 'src/gpu-iife.js', plugins: [] },
];

mkdirSync(join(root, 'dist'), { recursive: true });
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
    ...common, format: 'esm', splitting: true, plugins: [inlineShader], outdir: join(root, 'dist/esm'), chunkNames: 'chunks/[name]-[hash]',
    entryPoints: { index: join(root, 'src/index.js'), effects: join(root, 'src/effects.js'), 'effects-water': join(root, 'src/effects-water.js'), 'native-bridge': join(root, 'src/native-bridge.js') },
  });
  for (const f of ['index.js', 'effects.js', 'effects-water.js', 'native-bridge.js']) measure(`esm/${f}`, join(root, 'dist/esm', f));
}

// TypeScript declarations generated from the JSDoc types (dist/types/<entry>.d.ts, wired as `types` in package.json exports).
if (!process.argv.includes('--no-esm') && !process.argv.includes('--no-types')) {
  rmSync(join(root, 'dist/types'), { recursive: true, force: true });
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'jsconfig.json'), '--noEmit', 'false', '--declaration', '--emitDeclarationOnly',
    '--rootDir', join(root, 'src'), '--outDir', join(root, 'dist/types')], { stdio: 'inherit' });
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
