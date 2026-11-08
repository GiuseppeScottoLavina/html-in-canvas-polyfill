// The mutant runner's decisions (test/gates/mutants/verdict.mjs): the selection is refused when it names no mutant, a clean run that is not usable leaves no
// mutant judged on that gate, and a mutant that only turns checks red that a clean run also turned red is UNCERTAIN, never CAUGHT.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { selectMutants, baselineOf, gateVerdict, mutantStatus, asGateRun } from '../../gates/mutants/verdict.mjs';
import { gateRunOutcome } from '../../gates/lib/gate.mjs';
import { MUTANTS } from '../../gates/mutants/mutants.mjs';

const RUN = fileURLToPath(new URL('../../gates/mutants/run.mjs', import.meta.url));
const run = (/** @type {string[]} */ failed, usable = true) => ({ usable, failed: new Set(failed) });

test('selection: an unknown name, a mix of a valid and an unknown name, an empty --only and a gate no mutant runs are refused; a valid selection is kept', () => {
  const m = [{ name: 'a', gates: ['g-x'] }, { name: 'b', gates: ['g-y'] }];
  for (const sel of [{ only: ['typo'] }, { only: ['a', 'typo'] }, { only: [''] }, { gate: 'g-none' }, { only: ['a'], gate: 'g-y' }]) assert.equal(typeof selectMutants(m, sel).error, 'string', JSON.stringify(sel));
  assert.deepEqual(selectMutants(m, { only: ['b'] }).selected?.map((x) => x.name), ['b']);
  assert.deepEqual(selectMutants(m, { gate: 'g-x' }).selected?.map((x) => x.name), ['a']);
  assert.equal(selectMutants(m, {}).selected?.length, 2);
  assert.equal(selectMutants(MUTANTS, { only: [MUTANTS[0].name] }).selected?.length, 1, 'the real catalogue');
});

test('the runner exits 2 on --only=typo and on --gate=g-none before it reads the bundles, and prints no OK', () => {
  for (const args of [['--only=typo'], ['--only=' + MUTANTS[0].name + ',typo'], ['--gate=g-none']]) {
    const r = spawnSync(process.execPath, [RUN, ...args], { encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 2, args + ': ' + r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /OK:/);
  }
});

test('a clean baseline: checks red on both runs are left out, a check red on one run only is flaky; a clean run that did not run or is not usable makes it unusable', () => {
  const b = baselineOf([run(['p', 'q']), run(['q', 'r'])]);
  assert.deepEqual([...b.failed], ['q']);
  assert.deepEqual([...b.flaky].sort(), ['p', 'r']);
  assert.equal(b.usable, true);
  assert.equal(baselineOf([run([])]).usable, true);
  assert.equal(baselineOf([run(['p'], false), run(['p'])]).usable, false);
  assert.equal(baselineOf([{ notRun: 'no browser', usable: false, failed: new Set() }]).usable, false);
});

test('a mutant run: CAUGHT only by a check green on every clean run; UNCERTAIN when its only new reds were red on a clean run; NOT USABLE when the clean side or its own run is', () => {
  const base = baselineOf([run(['flaky']), run([])]);
  assert.equal(mutantStatus([gateVerdict(base, run(['solid']))], {}), 'CAUGHT');
  assert.equal(mutantStatus([gateVerdict(base, run(['flaky']))], {}), 'UNCERTAIN', 'red only where a clean run was red');
  assert.equal(mutantStatus([gateVerdict(base, run(['flaky', 'solid']))], {}), 'CAUGHT');
  assert.equal(mutantStatus([gateVerdict(base, run([]))], {}), 'MISSED');
  assert.equal(mutantStatus([gateVerdict(base, run([]))], { pendingFix: 'x' }), 'PENDING');
  const unusable = baselineOf([{ notRun: 'no browser', usable: false, failed: new Set() }]);
  assert.equal(mutantStatus([gateVerdict(unusable, run(['solid']))], {}), 'NOT USABLE', 'a red mutant against a clean run that never ran proves nothing');
  assert.equal(mutantStatus([gateVerdict(baselineOf([run([], false)]), run(['solid']))], {}), 'NOT USABLE');
  assert.equal(mutantStatus([gateVerdict(base, run(['solid'], false))], {}), 'NOT USABLE');
  assert.equal(mutantStatus([gateVerdict(base, run(['solid'])), gateVerdict(base, run([]))], { expect: 'all' }), 'MISSED');
  assert.equal(mutantStatus([], {}), 'NOT USABLE');
  // paint-nothing, 2026-11-07: caught by G-f1-form while its G-explainer run was dropped (the OS pointer moved): one usable catch proves it, unless every gate must catch
  const dropped = gateVerdict(base, run(['solid'], false));
  assert.equal(mutantStatus([dropped, gateVerdict(base, run(['solid']))], {}), 'CAUGHT');
  assert.equal(mutantStatus([dropped, gateVerdict(base, run([]))], {}), 'NOT USABLE', 'a dropped run and a green one prove nothing');
  assert.equal(mutantStatus([dropped, gateVerdict(base, run(['solid']))], { expect: 'all' }), 'NOT USABLE');
  assert.equal(mutantStatus([gateVerdict(base, run(['solid'])), gateVerdict(base, run(['solid']))], { expect: 'all' }), 'CAUGHT');
});

test('a gate process that printed PASS and then exited 1 or was killed is not usable, so it cannot be a clean baseline; an ordinary FAIL with exit 1 is usable', () => {
  const line = (/** @type {string} */ verdict, /** @type {any[]} */ assertions) => JSON.stringify({ gate: 'G-x', verdict, pass: verdict === 'PASS', usable: true, assertions, failed: [] });
  const pass = [{ name: 'p', ok: true }];
  const crashed = asGateRun(gateRunOutcome({ stdout: line('PASS', pass) + '\n', status: 1 }));
  assert.equal(crashed.usable, false, 'PASS then exit 1');
  assert.equal(asGateRun(gateRunOutcome({ stdout: line('PASS', pass), status: null, signal: 'SIGKILL' })).usable, false, 'PASS then killed');
  assert.equal(baselineOf([crashed]).usable, false, 'no baseline from it');
  const fail = asGateRun(gateRunOutcome({ stdout: line('FAIL', [{ name: 'p', ok: false }]), status: 1 }));
  assert.deepEqual([fail.usable, [...fail.failed]], [true, ['p']], 'a red check and exit 1: an ordinary, usable FAIL');
  const ok = asGateRun(gateRunOutcome({ stdout: line('PASS', pass), status: 0 }));
  assert.deepEqual([ok.usable, ok.failed.size], [true, 0]);
  assert.equal(asGateRun(gateRunOutcome({ stdout: '', status: 1 })).usable, false, 'no result line: not run');
});
