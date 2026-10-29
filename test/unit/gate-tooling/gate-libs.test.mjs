// Pure pieces of the gate tooling: edge click points, control bundle text, identity diff, mutant building and definitions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { edgePoints } from '../../gates/lib/hit.mjs';
import { controlBundleText } from '../../gates/lib/sabotage.mjs';
import { diffIdentity } from '../../gates/lib/identity.mjs';
import { buildMutant } from '../../gates/mutants/build.mjs';
import { MUTANTS } from '../../gates/mutants/mutants.mjs';
import { SCENARIOS } from '../../xbrowser/scenarios.mjs';

test('edgePoints: 4 points 2 px inside and 4 points 3 px outside the middle of each side', () => {
  const p = edgePoints({ x: 100, y: 50, width: 80, height: 30 });
  assert.equal(p.length, 8);
  assert.deepEqual(p.filter((q) => q.kind === 'inside').map((q) => [q.side, q.x, q.y]), [['left', 102, 65], ['right', 178, 65], ['top', 140, 52], ['bottom', 140, 78]]);
  assert.deepEqual(p.filter((q) => q.kind === 'outside').map((q) => [q.side, q.x, q.y]), [['left', 97, 65], ['right', 183, 65], ['top', 140, 47], ['bottom', 140, 83]]);
  const thin = edgePoints({ x: 0, y: 0, width: 3, height: 3 });
  assert.ok(thin.filter((q) => q.kind === 'inside').every((q) => q.x >= 0 && q.x <= 3 && q.y >= 0 && q.y <= 3));
});

test('controlBundleText appends every requested sabotage after the bundle and rejects unknown kinds', () => {
  const t = controlBundleText('/*bundle*/', ['blank', 'nogeom', 'nowheel', 'freezelayer']);
  assert.ok(t.startsWith('/*bundle*/'));
  for (const k of ['drawElementImage', 'updateElementGeometry', "'wheel'", 'hic-layer']) assert.ok(t.includes(k), k);
  assert.throws(() => controlBundleText('x', ['nope']), /unknown sabotage/);
});

test('diffIdentity reports changed, added and removed descriptors and the first differing html position', () => {
  const a = { html: '<p>a</p>', table: { 'X.prototype': { m: '1|u|u|true|false|true', n: '2' } } };
  const b = { html: '<p>b</p>', table: { 'X.prototype': { m: '3|u|u|true|false|true', o: '4' } } };
  const d = diffIdentity(a, b);
  assert.deepEqual(d.map((x) => x.where).sort(), ['X.prototype.m', 'X.prototype.n', 'X.prototype.o', 'outerHTML']);
  assert.deepEqual(diffIdentity(a, a), []);
});

test('buildMutant applies an edit once, reports anchor drift for 0 or 2 matches, and EMPTY builds a no-op bundle', () => {
  assert.equal(buildMutant('a b c', { edits: [['b', 'X']] }).text, 'a X c');
  assert.match(buildMutant('a b c', { edits: [['z', 'X']] }).drift, /0 times/);
  assert.match(buildMutant('b b', { edits: [['b', 'X']] }).drift, /2 times/);
  assert.ok(buildMutant('anything', { edits: 'EMPTY' }).text.length > 100);
});

test('mutant definitions: unique names, edit pairs, existing gate files, no duplicate-anchor trouble inside one mutant', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const names = new Set();
  for (const m of MUTANTS) {
    assert.ok(!names.has(m.name), 'duplicate ' + m.name); names.add(m.name);
    assert.ok(m.proves.length > 10 && m.gates.length > 0, m.name);
    for (const g of m.gates) assert.ok(g.startsWith('xbrowser-') ? g.slice(9) in SCENARIOS : existsSync(resolve(here, '../../gates', g + '.mjs')), `${m.name}: gate ${g} does not exist`);
    if (m.edits !== 'EMPTY') for (const e of m.edits) assert.ok(Array.isArray(e) && e.length === 2 && e[0].length > 5, m.name);
  }
  assert.ok(MUTANTS.length >= 30);
});
