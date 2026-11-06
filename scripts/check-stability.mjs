// G-stability: docs/STABILITY.md names every public surface with a status, the type declarations agree with it, and no other document calls an
// experimental surface stable. Pure: stabilityProblems() reads only the inputs it is given (the Node test feeds it altered copies as positive controls);
// readStabilityInputs() reads them from the repository. scripts/check-repo.mjs runs it.
//
// What it checks (docs/STABILITY.md section 1):
//   - every row has one status of stable / experimental / unqualified, and no surface appears in rows of two statuses;
//   - every key of package.json `exports`, every classic bundle it maps, every export of the entries that have declarations (src/<entry>.js, read
//     from source: CI runs this before the build) and every built plugin entry has a row;
//   - every member of HicOptions, HicInstalled, LoadOptions and LoadResult has a row, and its description starts with `@experimental` exactly
//     when the row is experimental; every exported declaration of an experimental row carries @experimental in its JSDoc, and no stable one does;
//   - every subsection of API-CONTRACT section 7 has an experimental row, the decided surfaces have their decided status, and every row about the
//     iPhone is unqualified;
//   - in README, API-CONTRACT, SUPPORT-MATRIX, FAQ and GETTING-STARTED no table row that names an experimental surface gives "stable" as a status, a table row
//     about the iPhone says "unqualified" (or "refused"), and the extensions are called experimental where those documents describe them.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { posix } from 'node:path';

export const STATUSES = ['stable', 'experimental', 'unqualified'];
export const DOCS = ['README.md', 'docs/API-CONTRACT.md', 'docs/SUPPORT-MATRIX.md', 'docs/guides/FAQ.md', 'docs/guides/GETTING-STARTED.md'];
/** The typedefs whose members are rows of their own: [typedef, file]. */
export const MEMBER_TYPES = [['HicOptions', 'src/contracts/types.js'], ['HicInstalled', 'src/contracts/types.js'], ['LoadOptions', 'src/api/loader.js'], ['LoadResult', 'src/api/loader.js']];
/** The owner's decisions (2026-11-06): these surfaces are experimental whatever else changes. */
export const DECIDED_EXPERIMENTAL = ['framecap', 'frameCap', 'HTMLInCanvasEffects', './effects', 'hic-live-effects.iife.js', '__HIC__', 'hicunsupported', 'effectframe', 'effecterror'];
const HEADER = /^\|\s*area\s*\|\s*surface\s*\|\s*promise\s*\|\s*status\s*\|\s*evidence\s*\|\s*$/;

/**
 * @typedef {{stability: string, docs: Record<string, string>, pkg: any, sources: Record<string, string>, plugins: string[]}} StabilityInputs
 *   `sources`: repository-relative path -> text, for every file of src/ and every plugin entry the checks may read
 * @typedef {{area: string, surface: string, status: string, text: string, tokens: string[], qualifiers: string[]}} StabilityRow
 */

/** @param {string} line @returns {string[]} the cells of a markdown table row (an escaped `\|` stays inside its cell) */
export function cells(line) {
  const out = [];
  let cur = '';
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && body[i + 1] === '|') { cur += '|'; i++; } else if (body[i] === '|') { out.push(cur.trim()); cur = ''; } else cur += body[i];
  }
  out.push(cur.trim());
  return out;
}

/** @param {string} text @returns {{rows: StabilityRow[], problems: string[]}} the rows of the one table of STABILITY.md */
export function parseStability(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => HEADER.test(l));
  /** @type {string[]} */ const problems = [];
  /** @type {StabilityRow[]} */ const rows = [];
  if (start < 0) return { rows, problems: ['G-stability: docs/STABILITY.md has no table with the columns area | surface | promise | status | evidence'] };
  for (let i = start + 2; i < lines.length && lines[i].startsWith('|'); i++) {
    const c = cells(lines[i]);
    if (c.length !== 5) { problems.push(`G-stability: docs/STABILITY.md row ${i + 1} has ${c.length} cells, not 5`); continue; }
    const [area, surface, , status] = c;
    // "`Type`: `a`, `b`" names the members Type.a and Type.b
    const q = /^`([\w.$]+)`:\s*/.exec(surface);
    const names = [...(q ? surface.slice(q[0].length) : surface).matchAll(/`([^`]+)`/g)].map((m) => m[1].replace(/\(\)$/, ''));
    rows.push({ area, surface, status, text: lines[i], tokens: q ? names.map((n) => `${q[1]}.${n}`) : names, qualifiers: q ? [q[1]] : [] });
    if (!STATUSES.includes(status)) problems.push(`G-stability: docs/STABILITY.md row "${surface}" has the status "${status}" (not ${STATUSES.join(', ')})`);
  }
  if (!rows.length) problems.push('G-stability: docs/STABILITY.md has an empty table');
  return { rows, problems };
}

/** @param {string} text @param {number} at index of an opening brace @returns {number} the index after its matching closing brace */
function closeBrace(text, at) {
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i + 1;
  }
  return text.length;
}

/** @param {string} text @returns {string[]} the names a module exports (types of its @typedef tags included, as its declaration file exports them) */
export function moduleExports(text) {
  const names = new Set();
  const code = text.replace(/\/\*[\s\S]*?\*\//g, (c) => (c.startsWith('/**') ? c : '')).replace(/^\s*\/\/.*$/gm, '');
  for (const m of code.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',').map((s) => s.trim()).filter(Boolean)) names.add(part.split(/\s+as\s+/).pop());
  }
  for (const m of code.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([\w$]+)/gm)) names.add(m[1]);
  if (/^export\s+default\b/m.test(code)) names.add('default');
  if (/^export\s+\*/m.test(code)) names.add('*');
  for (const m of code.matchAll(/@typedef\s+(?=\{)/g)) {
    const end = closeBrace(code, m.index + m[0].length);
    const n = /^\s*([\w$]+)/.exec(code.slice(end));
    if (n) names.add(n[1]);
  }
  return [...names].sort();
}

/** @param {string} text a declaration file @returns {string[]} its exported names */
export function declarationExports(text) {
  const names = new Set();
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of code.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',').map((s) => s.trim()).filter(Boolean)) names.add(part.split(/\s+as\s+/).pop());
  }
  for (const m of code.matchAll(/^export\s+(?:declare\s+)?(?:function|const|let|var|class|type|interface)\s+([\w$]+)/gm)) names.add(m[1]);
  return [...names].sort();
}

/**
 * The JSDoc right above the declaration of `name` exported by `file`, following re-exports. null when no declaration is found.
 * @param {Record<string, string>} sources @param {string} file @param {string} name @param {number} [depth] @returns {string|null}
 */
export function declarationDoc(sources, file, name, depth = 0) {
  const text = sources[file];
  if (text === undefined || depth > 8) return null;
  const decl = new RegExp(`^export\\s+(?:async\\s+)?(?:function\\*?|const|let|class)\\s+${name.replace(/\$/g, '\\$')}\\b`, 'm').exec(text);
  if (decl) {
    const before = text.slice(0, decl.index).trimEnd();
    if (!before.endsWith('*/')) return '';
    const open = before.lastIndexOf('/**');
    return open < 0 ? '' : before.slice(open);
  }
  /** @param {string} list @returns {string|null} the local name that `name` is exported or imported as, in a brace list */
  const local = (list) => {
    for (const part of list.split(',').map((s) => s.trim())) {
      const [a, b = a] = part.split(/\s+as\s+/);
      if (b === name) return a;
    }
    return null;
  };
  const rel = (/** @type {string} */ spec) => posix.normalize(posix.join(posix.dirname(file), spec));
  for (const m of text.matchAll(/^export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gm)) {
    const a = local(m[1]);
    if (a) return declarationDoc(sources, rel(m[2]), a, depth + 1);
  }
  for (const m of text.matchAll(/^export\s*\{([^}]*)\}\s*;?\s*$/gm)) {
    const a = local(m[1]);
    if (!a) continue;
    for (const im of text.matchAll(/^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gm)) {
      const found = im[1].split(',').map((p) => p.trim()).find((p) => (p.split(/\s+as\s+/)[1] ?? p) === a);
      if (found) return declarationDoc(sources, rel(im[2]), found.split(/\s+as\s+/)[0], depth + 1);
    }
  }
  return null;
}

/**
 * The @property members of one @typedef {Object} block: name -> description (continuation lines joined).
 * @param {string} text @param {string} typedef @returns {Map<string, string>|null}
 */
export function typedefMembers(text, typedef) {
  const head = new RegExp(`^ \\* @typedef \\{Object\\} ${typedef}\\b`, 'm').exec(text);
  if (!head) return null;
  const block = text.slice(head.index, text.indexOf('*/', head.index));
  const members = new Map();
  /** @type {string|null} */ let last = null;
  for (const line of block.split('\n').slice(1)) {
    const l = line.replace(/^\s*\*\s?/, '');
    if (l.startsWith('@property')) {
      const open = l.indexOf('{');
      const after = l.slice(closeBrace(l, open)).trim();
      const m = /^\[?([\w$]+)(?:=[^\]]*)?\]?\s*(.*)$/.exec(after);
      if (!m) continue;
      last = m[1];
      members.set(last, m[2]);
    } else if (l.startsWith('@')) last = null;
    else if (last) members.set(last, `${members.get(last)} ${l.trim()}`.trim());
  }
  return members;
}

const MARK = '`@experimental`';
/** A table cell that gives "stable" as a status: it begins with the word, or says "**stable**", "(stable)", "is stable" or "are stable" (not a mention such as
 * WebKit's "stable features"). @param {string} cell */
export const callsStable = (cell) => /^(\*\*)?stable\b/i.test(cell) || /\*\*stable\*\*|\(stable\)|\b(is|are) stable\b/i.test(cell);

/** @param {StabilityInputs} inputs @returns {string[]} */
export function stabilityProblems(inputs) {
  const { rows, problems } = parseStability(inputs.stability);
  const P = (/** @type {string} */ m) => problems.push(`G-stability: ${m}`);
  /** @type {Map<string, Set<string>>} */ const statusOf = new Map();
  const qualifiers = new Set();
  const members = new Set();
  for (const r of rows) {
    for (const t of r.tokens) (statusOf.get(t) ?? statusOf.set(t, new Set()).get(t))?.add(r.status);
    for (const q of r.qualifiers) qualifiers.add(q);
    if (r.qualifiers.length) for (const t of r.tokens) members.add(t);
  }
  for (const [t, s] of statusOf) if (s.size > 1) P(`\`${t}\` is in rows of different statuses (${[...s].sort().join(', ')}) in docs/STABILITY.md`);
  const status = (/** @type {string} */ t) => (statusOf.get(t)?.size === 1 ? [...(statusOf.get(t) ?? [])][0] : undefined);
  const need = (/** @type {string} */ t, /** @type {string} */ what) => { if (!statusOf.has(t) && !qualifiers.has(t)) P(`${what} \`${t}\` has no row in docs/STABILITY.md`); };

  // ---- the package's surface: exports keys, classic bundles, entry exports, plugin entries
  const exportsMap = inputs.pkg?.exports ?? {};
  for (const key of Object.keys(exportsMap)) need(key, 'the package.json export');
  const bundles = new Set();
  for (const v of Object.values(exportsMap)) {
    const m = typeof v === 'string' ? /^\.\/dist\/(hic-live-[\w-]+\.iife)\.js$/.exec(v) : null;
    if (m) bundles.add(`${m[1]}.js`);
  }
  for (const b of bundles) need(b, 'the classic bundle');
  /** @type {Array<[string, string]>} */ const entries = [];
  for (const v of Object.values(exportsMap)) {
    const types = typeof v === 'object' ? v.types : undefined;
    const m = typeof types === 'string' ? /^\.\/dist\/types\/([\w-]+)\.d\.ts$/.exec(types) : null;
    if (m) entries.push([`src/${m[1]}.js`, m[1]]);
  }
  for (const [file] of entries) {
    if (inputs.sources[file] === undefined) { P(`the entry ${file} named by package.json exports does not exist`); continue; }
    for (const name of moduleExports(inputs.sources[file])) {
      if (name === '*' || name === 'default') { P(`${file} uses \`export ${name === '*' ? '*' : 'default'}\`: name each export so that docs/STABILITY.md can give it a status`); continue; }
      need(name, `the export of ${file}`);
      const s = status(name);
      if (!s) continue;
      const doc = declarationDoc(inputs.sources, file, name);
      if (doc === null) continue; // a re-exported typedef: its members are checked below
      const tagged = /@experimental\b/.test(doc);
      if (s === 'experimental' && !tagged) P(`\`${name}\` (${file}) is experimental in docs/STABILITY.md but its declaration has no @experimental tag`);
      if (s === 'stable' && tagged) P(`\`${name}\` (${file}) is stable in docs/STABILITY.md but its declaration is tagged @experimental`);
    }
  }
  for (const n of inputs.plugins) {
    const t = `plugins/${n}`;
    need(t, 'the plugin entry');
    if (statusOf.has(t) && status(t) !== 'experimental') P(`\`${t}\` must be experimental (an example plugin of the effects extension)`);
    for (const name of ['plugin', 'meta']) {
      const doc = declarationDoc(inputs.sources, `plugins/${n}/index.js`, name);
      if (doc === null) P(`plugins/${n}/index.js exports no \`${name}\``);
      else if (!/@experimental\b/.test(doc)) P(`\`${name}\` of plugins/${n}/index.js has no @experimental tag`);
    }
  }

  // ---- the members of the typedefs that stable entry points return or take
  for (const [type, file] of MEMBER_TYPES) {
    const own = typedefMembers(inputs.sources[file] ?? '', type);
    if (!own) { P(`no @typedef {Object} ${type} in ${file}`); continue; }
    for (const [m, desc] of own) {
      const t = `${type}.${m}`;
      need(t, 'the member');
      const s = status(t);
      const marked = desc.startsWith(MARK);
      if (s === 'experimental' && !marked) P(`\`${t}\` is experimental in docs/STABILITY.md but its description in ${file} does not start with ${MARK}`);
      if (s === 'stable' && marked) P(`\`${t}\` is stable in docs/STABILITY.md but its description in ${file} starts with ${MARK}`);
    }
    for (const t of statusOf.keys()) if (t.startsWith(`${type}.`) && !own.has(t.slice(type.length + 1))) P(`docs/STABILITY.md names \`${t}\`, which ${type} does not have`);
  }

  // ---- decisions: section 7 of API-CONTRACT, the decided surfaces, the iPhone
  const contract = inputs.docs['docs/API-CONTRACT.md'] ?? '';
  const sections = [...contract.matchAll(/^#{3,4} (7\.\d+(?:\.\d+)?) /gm)].map((m) => m[1]);
  if (!sections.length) P('docs/API-CONTRACT.md has no subsection of section 7');
  for (const n of sections) {
    const cite = new RegExp(`API-CONTRACT ${n.replace(/\./g, '\\.')}(?![.\\d])`);
    const citing = rows.filter((r) => cite.test(r.text));
    if (!citing.some((r) => r.status === 'experimental')) P(`API-CONTRACT ${n} (an extension) has no experimental row in docs/STABILITY.md that cites it`);
    for (const r of citing) if (r.status === 'stable') P(`the row "${r.surface}" cites API-CONTRACT ${n} (an extension) but is stable`);
  }
  for (const t of DECIDED_EXPERIMENTAL) {
    if (!statusOf.has(t)) P(`the decided surface \`${t}\` has no row in docs/STABILITY.md`);
    else if (status(t) !== 'experimental') P(`\`${t}\` must be experimental (decision of 2026-11-06)`);
  }
  for (const t of statusOf.keys()) if (t.startsWith('LoadOptions.') && status(t) !== 'experimental') P(`\`${t}\` must be experimental: the loader's options are (decision of 2026-11-06)`);
  const iphone = rows.filter((r) => /iPhone/.test(r.surface));
  if (!iphone.length) P('docs/STABILITY.md has no row for the iPhone');
  for (const r of iphone) if (r.status !== 'unqualified') P(`the row "${r.surface}" must be unqualified until a physical iPhone has run the suites (decision of 2026-11-06)`);

  // ---- the other documents
  const experimental = [...statusOf.keys()].filter((t) => status(t) === 'experimental' && !members.has(t));
  for (const [path, text] of Object.entries(inputs.docs)) {
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (!line.startsWith('|')) return;
      if (cells(line).some(callsStable)) {
        const named = experimental.filter((t) => line.includes(`\`${t}\``));
        if (named.length) P(`${path}:${i + 1}: a table row names the experimental ${named.map((t) => `\`${t}\``).join(', ')} and says "stable"`);
      }
      const first = cells(line)[0] ?? '';
      if (/iPhone/.test(first) && !/\b(unqualified|refused)\b/i.test(line)) P(`${path}:${i + 1}: a table row about the iPhone does not say "unqualified"`);
    });
  }
  const between = (/** @type {string} */ text, /** @type {RegExp} */ from, /** @type {RegExp} */ to) => {
    const a = from.exec(text);
    if (!a) return null;
    const rest = text.slice(a.index + a[0].length);
    const b = to.exec(rest);
    return rest.slice(0, b ? b.index : rest.length);
  };
  const s7 = between(contract, /^## 7\. /m, /^## /m);
  if (s7 === null || !/\bexperimental\b/i.test(s7)) P('docs/API-CONTRACT.md section 7 does not say that the extensions are experimental');
  const ext = between(inputs.docs['README.md'] ?? '', /^## Two extensions\b/m, /^## /m);
  if (ext === null || !/\bexperimental\b/i.test(ext)) P('README.md "Two extensions" does not say that they are experimental');
  const matrix = inputs.docs['docs/SUPPORT-MATRIX.md'] ?? '';
  for (const id of ['frame-cap', 'effect-plugins']) {
    const row = matrix.split('\n').find((l) => l.startsWith(`| \`${id}\` |`));
    if (!row || !/\bexperimental\b/i.test(row)) P(`docs/SUPPORT-MATRIX.md row \`${id}\` does not say "experimental" (src/contracts/features.js)`);
  }
  return problems;
}

/** @param {string} root @returns {StabilityInputs} */
export async function readStabilityInputs(root) {
  const read = (/** @type {string} */ p) => { try { return readFileSync(join(root, p), 'utf8'); } catch { return ''; } };
  /** @type {Record<string, string>} */ const sources = {};
  const walk = (/** @type {string} */ rel) => {
    for (const n of readdirSync(join(root, rel))) {
      const p = `${rel}/${n}`;
      if (statSync(join(root, p)).isDirectory()) walk(p); else if (n.endsWith('.js')) sources[p] = read(p);
    }
  };
  walk('src');
  const { discoverPlugins } = await import(new URL('../plugins/_shared/contract.mjs', import.meta.url).href);
  const plugins = discoverPlugins(root).map((/** @type {{name: string}} */ p) => p.name);
  for (const n of plugins) sources[`plugins/${n}/index.js`] = read(`plugins/${n}/index.js`);
  return {
    stability: read('docs/STABILITY.md'),
    docs: Object.fromEntries(DOCS.map((p) => [p, read(p)])),
    pkg: JSON.parse(read('package.json') || '{}'),
    sources,
    plugins,
  };
}
