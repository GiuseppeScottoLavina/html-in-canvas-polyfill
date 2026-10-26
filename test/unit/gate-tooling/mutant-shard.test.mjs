// The split of the mutant suite into CI shards (test/gates/mutants/shard.mjs): every mutant in exactly one shard, balanced, deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MUTANTS } from '../../gates/mutants/mutants.mjs';
import { parseShard, planShards } from '../../gates/mutants/shard.mjs';

test('every mutant of the suite lands in exactly one shard, for 1 to 8 shards', () => {
  for (let n = 1; n <= 8; n++) {
    const names = planShards(MUTANTS, n).flatMap((s) => s.mutants.map((m) => m.name));
    assert.equal(names.length, MUTANTS.length, `${n} shards`);
    assert.deepEqual([...names].sort(), MUTANTS.map((m) => m.name).sort(), `${n} shards`);
  }
});

test('the split is deterministic, keeps the suite order inside a shard, and is balanced', () => {
  const a = planShards(MUTANTS, 4), b = planShards(MUTANTS, 4);
  assert.deepEqual(a.map((s) => s.mutants.map((m) => m.name)), b.map((s) => s.mutants.map((m) => m.name)));
  for (const s of a) assert.deepEqual(s.mutants, [...s.mutants].sort((x, y) => MUTANTS.indexOf(x) - MUTANTS.indexOf(y)));
  const mins = a.map((s) => s.minutes);
  assert.ok(Math.max(...mins) <= 1.5 * Math.min(...mins) + 4, `shard estimates ${mins.join(', ')}`);
});

test('a shard counts one baseline per distinct gate', () => {
  const [one] = planShards([{ name: 'a', gates: ['g-x'] }, { name: 'b', gates: ['g-x'] }, { name: 'c', gates: ['g-x', 'g-y'] }], 1);
  assert.equal(one.minutes, 4 + 2, 'four gate runs and the baselines of g-x and g-y (1 min each by default)');
});

test('--shard is k/n with 1 <= k <= n', () => {
  assert.equal(parseShard(undefined), null);
  assert.deepEqual(parseShard('2/5'), { index: 2, count: 5 });
  for (const bad of ['0/3', '4/3', '1', 'a/b', '1/0']) assert.throws(() => parseShard(bad), /--shard must be k\/n/);
});
