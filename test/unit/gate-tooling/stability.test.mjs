// G-stability (scripts/check-stability.mjs): the repository passes, and each kind of drift between docs/STABILITY.md, the type declarations and the other
// documents is caught (positive controls on altered copies of the real inputs). With a built dist/types, the export lists read from source equal the
// declaration files' and the build turned every member marker into a real @experimental tag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStabilityInputs, stabilityProblems, moduleExports, declarationExports, typedefMembers, MEMBER_TYPES } from '../../../scripts/check-stability.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const real = await readStabilityInputs(root);

/** @param {(i: any) => void} alter @returns {string[]} the problems of an altered deep copy of the real inputs */
const altered = (alter) => {
  const copy = structuredClone(real);
  alter(copy);
  return stabilityProblems(copy);
};
/** @param {string} text @param {string} from @param {string} to */
const swap = (text, from, to) => {
  assert.ok(text.includes(from), `control anchor missing: ${from}`);
  return text.replace(from, to);
};
/** the STABILITY.md row whose surface cell begins with `start` */
const rowOf = (/** @type {string} */ start) => {
  const line = real.stability.split('\n').find((l) => l.startsWith(`| ${start.split(' | ')[0]} | ${start.split(' | ')[1]}`));
  assert.ok(line, `row missing: ${start}`);
  return /** @type {string} */ (line);
};

test('the repository passes G-stability', () => {
  assert.deepEqual(stabilityProblems(real), []);
});

test('a public export without a row is caught', () => {
  const p = altered((i) => { i.stability = swap(i.stability, '`FEATURES`, `featureById`', '`FEATURES`'); });
  assert.ok(p.some((m) => /export of src\/index\.js `featureById` has no row/.test(m)), p.join('\n'));
  const q = altered((i) => { i.sources['src/index.js'] += '\nexport const extra = 1;\n'; });
  assert.ok(q.some((m) => /`extra` has no row/.test(m)), q.join('\n'));
});

test('a new package.json export, classic bundle or plugin without a row is caught', () => {
  const p = altered((i) => { i.pkg.exports['./iife/new'] = './dist/hic-live-new.iife.js'; });
  assert.ok(p.some((m) => /export `\.\/iife\/new` has no row/.test(m)), p.join('\n'));
  assert.ok(p.some((m) => /bundle `hic-live-new\.iife\.js` has no row/.test(m)), p.join('\n'));
  const q = altered((i) => { i.plugins.push('ripple'); i.sources['plugins/ripple/index.js'] = 'export const meta = {};\n/** @experimental x */\nexport const plugin = {};\n'; });
  assert.ok(q.some((m) => /plugin entry `plugins\/ripple` has no row/.test(m)), q.join('\n'));
  assert.ok(q.some((m) => /`meta` of plugins\/ripple\/index\.js has no @experimental/.test(m)), q.join('\n'));
});

test('an experimental row called stable is caught, in STABILITY.md and in the other documents', () => {
  const cap = rowOf('extension | `framecap`');
  const p = altered((i) => { i.stability = swap(i.stability, cap, cap.replace('| experimental |', '| stable |')); });
  assert.ok(p.some((m) => /`frameCap` must be experimental/.test(m)), p.join('\n'));
  assert.ok(p.some((m) => /cites API-CONTRACT 7\.1 \(an extension\) but is stable/.test(m)), p.join('\n'));
  const q = altered((i) => { i.docs['README.md'] += '\n| surface | status |\n|---|---|\n| `frameCap` | stable |\n'; });
  assert.ok(q.some((m) => /README\.md:\d+: a table row names the experimental `frameCap`/.test(m)), q.join('\n'));
  // a mention of the word that is not a status is not a claim
  assert.deepEqual(altered((i) => { i.docs['README.md'] += '\n| x | `frameCap` over the stable channel of Chrome |\n'; }), []);
});

test('a surface in rows of two statuses, or a row without a valid status, is caught', () => {
  const ext = rowOf('extension | `createHost`');
  const p = altered((i) => { i.stability = swap(i.stability, ext, `${ext}\n| export | \`createHost\` | x | stable | y |`); });
  assert.ok(p.some((m) => /`createHost` is in rows of different statuses/.test(m)), p.join('\n'));
  const q = altered((i) => { i.stability = swap(i.stability, ext, ext.replace('| experimental |', '| beta |')); });
  assert.ok(q.some((m) => /has the status "beta"/.test(m)), q.join('\n'));
});

test('a new subsection of API-CONTRACT section 7 without an experimental row is caught', () => {
  const p = altered((i) => { i.docs['docs/API-CONTRACT.md'] = swap(i.docs['docs/API-CONTRACT.md'], '## 8. Timing model', '### 7.7 Something new\nText.\n\n## 8. Timing model'); });
  assert.ok(p.some((m) => /API-CONTRACT 7\.7 \(an extension\) has no experimental row/.test(m)), p.join('\n'));
  const q = altered((i) => { i.docs['docs/API-CONTRACT.md'] = i.docs['docs/API-CONTRACT.md'].replaceAll(/experimental/gi, 'optional'); });
  assert.ok(q.some((m) => /section 7 does not say that the extensions are experimental/.test(m)), q.join('\n'));
});

test('the iPhone must be unqualified, in STABILITY.md and in the tables of the other documents', () => {
  const row = rowOf('platform | Safari on the iPhone');
  const p = altered((i) => { i.stability = swap(i.stability, row, row.replace('| unqualified |', '| stable |')); });
  assert.ok(p.some((m) => /must be unqualified until a physical iPhone/.test(m)), p.join('\n'));
  const q = altered((i) => { i.docs['docs/SUPPORT-MATRIX.md'] = swap(i.docs['docs/SUPPORT-MATRIX.md'], '| Safari on iOS >= 26 (iPhone) | **unqualified**: polyfill', '| Safari on iOS >= 26 (iPhone) | polyfill'); });
  assert.ok(q.some((m) => /SUPPORT-MATRIX\.md:\d+: a table row about the iPhone does not say "unqualified"/.test(m)), q.join('\n'));
});

test('the loader options and the other decided surfaces stay experimental', () => {
  const row = rowOf('option | `LoadOptions`');
  const p = altered((i) => { i.stability = swap(i.stability, row, row.replace('| experimental |', '| stable |')); });
  assert.ok(p.some((m) => /`LoadOptions\.timeout` must be experimental/.test(m)), p.join('\n'));
  assert.ok(p.some((m) => /`LoadOptions\.timeout` is stable in docs\/STABILITY\.md but its description/.test(m)), p.join('\n'));
});

test('the @experimental markers of the declarations and the typedef members follow the table', () => {
  // a member marker removed, and one added to a stable member
  const p = altered((i) => { i.sources['src/contracts/types.js'] = swap(i.sources['src/contracts/types.js'], '[maxDpr]  `@experimental`', '[maxDpr]  '); });
  assert.ok(p.some((m) => /`HicOptions\.maxDpr` is experimental .* does not start with `@experimental`/.test(m)), p.join('\n'));
  const q = altered((i) => { i.sources['src/contracts/types.js'] = swap(i.sources['src/contracts/types.js'], "[mode]  'auto' (default)", "[mode]  `@experimental` (x). 'auto' (default)"); });
  assert.ok(q.some((m) => /`HicOptions\.mode` is stable .* starts with `@experimental`/.test(m)), q.join('\n'));
  // a declaration tag removed (followed through two re-exports), and one added to a stable export
  const r = altered((i) => { i.sources['src/effects/plugin-abi.js'] = swap(i.sources['src/effects/plugin-abi.js'], ' * @experimental the effect plugin ABI', ' * the effect plugin ABI'); });
  assert.ok(r.some((m) => /`definePlugin` \(src\/effects\.js\) is experimental .* no @experimental tag/.test(m)), r.join('\n'));
  const s = altered((i) => { i.sources['src/api/install.js'] = swap(i.sources['src/api/install.js'], ' * @param {HicOptions} [options]\n * @returns {HicInstalled}', ' * @experimental x\n * @param {HicOptions} [options]\n * @returns {HicInstalled}'); });
  assert.ok(s.some((m) => /`install` \(src\/index\.js\) is stable .* tagged @experimental/.test(m)), s.join('\n'));
  // a member the typedef does not have
  const t = altered((i) => { i.stability = swap(i.stability, '`HicInstalled`: `options`,', '`HicInstalled`: `ghost`, `options`,'); });
  assert.ok(t.some((m) => /names `HicInstalled\.ghost`, which HicInstalled does not have/.test(m)), t.join('\n'));
});

test('the parsers read the shapes the sources use', () => {
  assert.deepEqual(moduleExports("export { a, b as c } from './x.js';\nexport { d };\n/** @typedef {{x: {y: number}}} T */\nexport async function e() {}\nexport const f = 1;\n// export const g = 2;\n"), ['T', 'a', 'c', 'd', 'e', 'f']);
  const m = typedefMembers('/**\n * @typedef {Object} X  doc\n * @property {(a: {b: number}) => void} [one]  `@experimental` (why). first\n *   second\n * @property {number} two\n */', 'X');
  assert.deepEqual([...(m ?? new Map())], [['one', '`@experimental` (why). first second'], ['two', '']]);
});

const types = join(root, 'dist/types');
test('with a built dist/types: the declaration files export what the sources do, and every member marker became a real tag', { skip: existsSync(join(types, 'index.d.ts')) ? false : 'no dist/types: run npm run build first' }, () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  let compared = 0;
  for (const v of Object.values(pkg.exports)) {
    const t = /** @type {any} */ (v)?.types;
    if (typeof t !== 'string' || t.includes('*')) continue;
    const name = /dist\/types\/([\w-]+)\.d\.ts$/.exec(t)?.[1];
    assert.deepEqual(moduleExports(real.sources[`src/${name}.js`]), declarationExports(readFileSync(join(root, t), 'utf8')), `exports of ${name}`);
    compared++;
  }
  for (const n of real.plugins) {
    assert.deepEqual(moduleExports(real.sources[`plugins/${n}/index.js`]), declarationExports(readFileSync(join(types, 'plugins', n, 'index.d.ts'), 'utf8')), `exports of plugins/${n}`);
    compared++;
  }
  assert.ok(compared >= 5 + real.plugins.length);
  // every member marked in src carries the real tag in the emitted declarations
  const dts = readdirSync(join(types, 'contracts')).includes('types.d.ts') ? readFileSync(join(types, 'contracts/types.d.ts'), 'utf8') + readFileSync(join(types, 'api/loader.d.ts'), 'utf8') : '';
  for (const [type, file] of MEMBER_TYPES) {
    const at = dts.indexOf(`export type ${type} = {`);
    assert.ok(at >= 0, `no ${type} in dist/types`);
    const block = dts.slice(at, dts.indexOf('\n};', at));
    for (const [member, desc] of typedefMembers(real.sources[file], type) ?? new Map()) {
      const tagged = new RegExp(`\\/\\*\\*\\n\\s*\\* @experimental [^\\n]*\\n(?:\\s*\\*[^\\n]*\\n)*?\\s*\\*\\/\\n\\s*${member}\\??:`).test(block);
      assert.equal(tagged, desc.startsWith('`@experimental`'), `${type}.${member}: the @experimental tag in dist/types does not follow the source`);
    }
  }
});
