// The framework selection of test/frameworks/run.mjs: a misspelt or empty --only is refused (exit 2, before any build or browser) instead of running nothing
// and printing PASS; a valid partial selection keeps working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ALL_FRAMEWORKS, selectFrameworks } from '../../frameworks/selection.mjs';

const RUN = fileURLToPath(new URL('../../frameworks/run.mjs', import.meta.url));

test('without --only every framework runs; a valid selection keeps the suite order', () => {
  assert.deepEqual(selectFrameworks(undefined), { frameworks: ALL_FRAMEWORKS });
  assert.deepEqual(selectFrameworks('lit,react'), { frameworks: ['react', 'lit'] });
  assert.deepEqual(selectFrameworks('vue'), { frameworks: ['vue'] });
});

test('an unknown name, an empty selection and a stray comma are refused with the names of the suite', () => {
  for (const only of ['typo', '', 'react,typo', 'react,', 'React']) {
    const r = selectFrameworks(only);
    assert.equal(typeof r.error, 'string', only);
    assert.ok(r.error.includes('react, vue, svelte, lit'), r.error);
  }
});

test('the runner exits 2 on --only=typo before it builds or launches anything, and prints no PASS', () => {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [RUN, '--only=typo', '--no-control'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /--only=typo: "typo" is not a framework of the suite/);
  assert.doesNotMatch(r.stdout, /PASS|scenario runs/);
  assert.ok(Date.now() - t0 < 15000, 'refused at once');
});
