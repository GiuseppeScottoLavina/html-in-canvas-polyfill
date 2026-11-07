// The decisions of the mutant runner (run.mjs), on plain data so that node tests can hold them (test/unit/gate-tooling/mutant-verdict.test.mjs):
// which mutants a command line selects, what the clean bundle's runs of a gate leave as a baseline, and what a mutant's run of that gate proves.

/**
 * The mutants of `--only` and `--gate`. A name that is not a mutant, a gate that no mutant runs, or an empty selection is an error: the runner refuses it before
 * any build or browser (`--only=typo` used to print "OK: 0 mutants" and exit 0).
 * @template {{name: string, gates: string[]}} M
 * @param {M[]} mutants @param {{only?: string[], gate?: string}} sel
 * @returns {{selected: M[], error?: undefined} | {error: string}}
 */
export function selectMutants(mutants, { only, gate }) {
  const unknown = (only ?? []).filter((n) => !mutants.some((m) => m.name === n));
  if (unknown.length) return { error: `--only: ${unknown.map((n) => JSON.stringify(n)).join(', ')} is not a mutant (node test/gates/mutants/run.mjs --list)` };
  if (gate !== undefined && !mutants.some((m) => m.gates.includes(gate))) return { error: `--gate=${gate}: no mutant runs that gate` };
  const selected = mutants.filter((m) => (!only || only.includes(m.name)) && (gate === undefined || m.gates.includes(gate)));
  if (!selected.length) return { error: 'the selection names no mutant' };
  return { selected };
}

/**
 * @typedef {{notRun?: string, usable: boolean, failed: Set<string>}} GateRun  one run of a gate: the names of its red checks
 * @typedef {{usable: boolean, failed: Set<string>, flaky: Set<string>, runs: number, notRun?: string}} Baseline
 */

/**
 * The clean bundle's baseline of a gate from its runs (one, or two when the first had red checks). A check red on every run is left out of the comparison
 * (`failed`); one red on some runs only is `flaky`: a mutant that turns only such checks red proves nothing. A run that did not run or is not usable makes the
 * baseline unusable, and no mutant can then be judged on that gate.
 * @param {GateRun[]} runs @returns {Baseline}
 */
export function baselineOf(runs) {
  const notRun = runs.find((r) => r.notRun)?.notRun;
  const usable = !notRun && runs.every((r) => r.usable);
  const sets = runs.filter((r) => !r.notRun).map((r) => r.failed);
  const union = new Set(sets.flatMap((s) => [...s]));
  const failed = new Set([...union].filter((n) => sets.every((s) => s.has(n))));
  const flaky = new Set([...union].filter((n) => !failed.has(n)));
  return { usable, failed, flaky, runs: runs.length, ...(notRun ? { notRun } : {}) };
}

/**
 * What a mutant's run of a gate proves against the clean baseline: caught by a check that is red now and green on every clean run; uncertain when the only new
 * reds are checks that also went red on a clean run; not usable when either side has no usable run.
 * @param {Baseline} base @param {GateRun} res
 * @returns {{usable: boolean, caught: boolean, uncertain: boolean, newlyRed: string[], flakyRed: string[], detail?: string}}
 */
export function gateVerdict(base, res) {
  if (res.notRun || !res.usable || !base.usable) return { usable: false, caught: false, uncertain: false, newlyRed: [], flakyRed: [], detail: res.notRun ?? base.notRun ?? (!res.usable ? 'the mutant run is not usable' : 'the clean baseline is not usable') };
  const newly = [...res.failed].filter((n) => !base.failed.has(n));
  const newlyRed = newly.filter((n) => !base.flaky.has(n));
  const flakyRed = newly.filter((n) => base.flaky.has(n));
  return { usable: true, caught: newlyRed.length > 0, uncertain: !newlyRed.length && flakyRed.length > 0, newlyRed, flakyRed };
}

/**
 * The status of a mutant from its gates. UNCERTAIN, like MISSED and NOT USABLE, fails the suite: rerun it.
 * @param {Array<{usable: boolean, caught: boolean, uncertain: boolean}>} gates @param {{expect?: 'all'|'any', pendingFix?: string}} m
 * @returns {'CAUGHT'|'MISSED'|'PENDING'|'NOT USABLE'|'UNCERTAIN'}
 */
export function mutantStatus(gates, m) {
  if (!gates.length || gates.some((g) => !g.usable)) return 'NOT USABLE';
  const caught = m.expect === 'all' ? gates.every((g) => g.caught) : gates.some((g) => g.caught);
  if (caught) return 'CAUGHT';
  if (gates.some((g) => g.uncertain)) return 'UNCERTAIN';
  return m.pendingFix ? 'PENDING' : 'MISSED';
}
