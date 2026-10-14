// The contract every plugin folder satisfies (plugins/README.md), checked by the build (scripts/build.mjs), by `npm run lint`
// (scripts/check-repo.mjs) and by each plugin's own Node test. Node only.
//
//   discoverPlugins(root)       the folders the build turns into bundles: plugins/<name>/ with an index.js, <name> not starting with '_' or '.'
//   checkPluginFolder(dir)      string[] of problems for one folder (empty = the folder satisfies the contract)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PLUGINS_DIR = 'plugins';
/** a plugin name is also a file name, an exports subpath and a key of window.HicLivePlugins */
export const NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * @param {string} root  repository root
 * @returns {{name: string, dir: string, wgsl: string[]}[]}  sorted by name
 */
export function discoverPlugins(root) {
  const base = join(root, PLUGINS_DIR);
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((n) => !n.startsWith('_') && !n.startsWith('.') && statSync(join(base, n)).isDirectory() && existsSync(join(base, n, 'index.js')))
    .sort()
    .map((name) => ({ name, dir: join(base, name), wgsl: wgslFiles(join(base, name)) }));
}

/** @param {string} dir */
export function wgslFiles(dir) {
  return readdirSync(dir).filter((f) => f.endsWith('.wgsl')).sort();
}

/** Source files of a plugin (tests excluded), relative to the folder. @param {string} dir */
function sourceFiles(dir) {
  /** @type {string[]} */ const out = [];
  const walk = (/** @type {string} */ d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) { if (n !== 'test' && !n.startsWith('.')) walk(p); } else if (/\.m?js$/.test(n)) out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * @param {string} dir  absolute path of plugins/<folder>
 * @returns {Promise<string[]>}
 */
export async function checkPluginFolder(dir) {
  const folder = basename(dir);
  const template = folder.startsWith('_');
  const problems = [];
  const at = (/** @type {string} */ msg) => problems.push(`plugins/${folder}: ${msg}`);
  if (!template && !NAME_RE.test(folder)) at(`the folder name must match ${NAME_RE} (it becomes a file name and an exports subpath)`);
  for (const f of ['index.js', 'README.md']) if (!existsSync(join(dir, f))) at(`${f} is missing`);
  const testDir = join(dir, 'test');
  if (!existsSync(testDir) || !readdirSync(testDir).some((f) => f.endsWith('.test.mjs'))) at('test/ has no *.test.mjs file');
  const shaders = wgslFiles(dir);
  if (shaders.length && !existsSync(join(dir, 'wgsl.js'))) at('ships .wgsl files but no wgsl.js loader (copy it from plugins/_template)');

  // self-contained: static imports stay inside the folder; no blob: URLs (they taint canvases on Chrome and Safari)
  for (const rel of sourceFiles(dir)) {
    const text = readFileSync(join(dir, rel), 'utf8');
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const m of code.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const target = resolve(dir, rel, '..', m[1]);
      if (!m[1].startsWith('.') || !target.startsWith(dir + sep)) at(`${rel} imports "${m[1]}": a plugin imports only files of its own folder`);
    }
    if (/URL\.createObjectURL|['"`]blob:/.test(code)) at(`${rel} uses blob: URLs`);
  }
  if (!existsSync(join(dir, 'index.js'))) return problems;

  /** @type {any} */ let mod;
  try { mod = await import(pathToFileURL(join(dir, 'index.js')).href); } catch (error) { at(`index.js does not load in Node: ${/** @type {Error} */ (error).message}`); return problems; }
  const { meta, plugin } = mod;
  if (!meta || typeof meta !== 'object') at('index.js must export `meta`');
  else {
    if (typeof meta.name !== 'string' || !NAME_RE.test(meta.name)) at(`meta.name must match ${NAME_RE}`);
    else if (!template && meta.name !== folder) at(`meta.name "${meta.name}" must equal the folder name "${folder}"`);
    if (typeof meta.title !== 'string' || !meta.title.trim() || meta.title.length > 40) at('meta.title must be a short non-empty string (<= 40 characters)');
    if (typeof meta.description !== 'string' || !meta.description.trim() || meta.description.length > 160) at('meta.description must be one line (<= 160 characters)');
    if (meta.defaults !== undefined && (meta.defaults === null || typeof meta.defaults !== 'object')) at('meta.defaults must be an object when present');
    if (!Object.isFrozen(meta)) at('meta must be frozen');
  }
  if (!plugin || typeof plugin !== 'object') { at('index.js must export `plugin` (the effect plugin definition)'); return problems; }
  if (meta && plugin.type !== meta.name) at(`plugin.type "${plugin.type}" must equal meta.name "${meta?.name}"`);
  if (plugin.apiVersion !== 2) at('plugin.apiVersion must be 2');
  if (!Object.isFrozen(plugin)) at('plugin must be frozen');
  try {
    const { definePlugin } = await import(pathToFileURL(resolve(dir, '../../src/effects/plugin-abi.js')).href);
    definePlugin(plugin);
  } catch (error) { at(`the effects host would refuse the definition: ${/** @type {Error} */ (error).message}`); }
  return problems;
}
