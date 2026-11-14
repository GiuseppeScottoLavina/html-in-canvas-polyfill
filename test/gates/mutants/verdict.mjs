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
 * @typedef {{notRun?: string, usable: boolean, failed: Set<string>, applicable?: Set<string>, notApplicable?: Set<string>}} GateRun  one run of a gate: the names of
 *   its red checks, and of the checks that ran and those that recorded their case as not applicable (a G-xbrowser check of class n/a, `na` on the result line)
 * @typedef {{usable: boolean, failed: Set<string>, flaky: Set<string>, runs: number, notRun?: string}} Baseline
 */

/**
 * A gate's outcome (lib/gate.mjs gateRunOutcome) as a run: the names of its red checks. A process that printed a PASS result line and then exited non-zero or was
 * killed is not usable: its result line cannot be trusted, and as a clean run it would be a baseline with no red check. An ordinary FAIL (a red check, exit 1) is.
 * @param {any} res @returns {GateRun & {verdict?: string}}
 */
export function asGateRun(res) {
  if (res.notRun) return { notRun: res.notRun, usable: false, failed: new Set(), applicable: new Set(), notApplicable: new Set() };
  const failed = new Set(res.assertions.filter((/** @type {any} */ a) => !a.ok).map((/** @type {any} */ a) => a.name).concat(res.failed.filter((/** @type {string} */ f) => /^gate (ran|made|did not finish)/.test(f))));
  const brokenProcess = res.failed.some((/** @type {string} */ f) => /^gate process /.test(f));
  const applicable = new Set(res.assertions.filter((/** @type {any} */ a) => !a.na).map((/** @type {any} */ a) => a.name));
  const notApplicable = new Set(res.assertions.filter((/** @type {any} */ a) => a.na).map((/** @type {any} */ a) => a.name));
  return { usable: !!res.usable && !brokenProcess, failed, applicable, notApplicable, verdict: res.verdict };
}

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

/** The case of a check: its name without the engine G-xbrowser puts first (`[safari] scrollCompose system bars: ...` is `scrollCompose system bars: ...`). */
const caseOf = (/** @type {string} */ name) => name.replace(/^\[[^\]]+\] /, '');

/**
 * What a mutant's run of a gate proves against the clean baseline: caught by a check that is red now and green on every clean run; uncertain when the only new
 * reds are checks that also went red on a clean run; not usable when either side has no usable run. `needs` is the start of the names of the checks the mutant
 * is for (the mutant's `needs`): when none of them ran in the mutant's run (each recorded its case as not applicable, as G-xbrowser scrollCompose does for
 * Safari's system bars while macOS shows overlay bars), the run is `notApplicable`: green there proves nothing (webkit-system-knob-round was reported MISSED on
 * 2026-11-14 for that reason alone).
 * @param {Baseline} base @param {GateRun} res @param {string} [needs]
 * @returns {{usable: boolean, caught: boolean, uncertain: boolean, notApplicable: boolean, newlyRed: string[], flakyRed: string[], detail?: string}}
 */
export function gateVerdict(base, res, needs) {
  if (res.notRun || !res.usable || !base.usable) return { usable: false, caught: false, uncertain: false, notApplicable: false, newlyRed: [], flakyRed: [], detail: res.notRun ?? base.notRun ?? (!res.usable ? 'the mutant run is not usable' : 'the clean baseline is not usable') };
  const newly = [...res.failed].filter((n) => !base.failed.has(n));
  const newlyRed = newly.filter((n) => !base.flaky.has(n));
  const flakyRed = newly.filter((n) => base.flaky.has(n));
  const ran = needs === undefined || [...(res.applicable ?? [])].some((n) => caseOf(n).startsWith(needs));
  const why = ran ? undefined : [...(res.notApplicable ?? [])].find((n) => caseOf(n).startsWith(needs ?? '')) ?? `no check of "${needs}" ran`;
  return { usable: true, caught: newlyRed.length > 0, uncertain: !newlyRed.length && flakyRed.length > 0, notApplicable: !ran, newlyRed, flakyRed, ...(why ? { detail: why } : {}) };
}

/**
 * The status of a mutant from its gates. UNCERTAIN, like MISSED, NOT USABLE and NOT APPLICABLE, fails the suite: rerun it. A mutant that any of its gates may
 * catch (the default) is CAUGHT by one usable gate that caught it, whatever happened to the others; one that every gate must catch (`expect: 'all'`) needs every
 * gate usable. NOT APPLICABLE: a gate that did not catch it ran none of the checks the mutant is for (gateVerdict `needs`); set up the case and rerun.
 * @param {Array<{usable: boolean, caught: boolean, uncertain: boolean, notApplicable?: boolean}>} gates @param {{expect?: 'all'|'any', pendingFix?: string}} m
 * @returns {'CAUGHT'|'MISSED'|'PENDING'|'NOT USABLE'|'NOT APPLICABLE'|'UNCERTAIN'}
 */
export function mutantStatus(gates, m) {
  if (m.expect !== 'all' && gates.some((g) => g.usable && g.caught)) return 'CAUGHT';
  if (!gates.length || gates.some((g) => !g.usable)) return 'NOT USABLE';
  if (m.expect === 'all' && gates.every((g) => g.caught)) return 'CAUGHT';
  if (gates.some((g) => g.notApplicable && !g.caught)) return 'NOT APPLICABLE';
  if (gates.some((g) => g.uncertain)) return 'UNCERTAIN';
  return m.pendingFix ? 'PENDING' : 'MISSED';
}
