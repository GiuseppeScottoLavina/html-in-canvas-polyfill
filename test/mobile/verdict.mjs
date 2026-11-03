// The mobile gate's per-scenario verdicts (test/mobile/run.mjs): a real run and its positive control merged into one verdict per scenario. Pure, so it is unit tested
// (test/unit/gate-tooling/mobile-verdict.test.mjs) without a device.
//   PASS  every check passed and the control turned each declared class red
//   SKIP  the scenario reported only documented skips (class n/a: not drivable on this device, not applicable to this browser): nothing was verified, so it is not
//         counted as a pass, and it does not fail the gate
//   FAIL  anything else (a failed check, a throw, no check at all, a control that did not turn red)

/**
 * Merge a real and a control run into per-scenario verdicts.
 * @param {{rows: Array<{scenario: string, checks: Array<{label: string, ok: boolean, cls?: string}>, threw: string|null, ms: number}>}} real
 * @param {{rows: Array<{scenario: string, checks: Array<{label: string, ok: boolean, cls?: string}>, threw: string|null}>}|null} control
 * @param {{noControl?: boolean, controlClasses: Record<string, string[]>}} opts
 */
export function verdicts(real, control, { noControl = false, controlClasses }) {
  const out = {};
  for (const row of real.rows) {
    const ok = !row.threw && row.checks.length > 0 && row.checks.every((c) => c.ok);
    // a scenario that only reported a documented skip (class n/a) has nothing to control, and verified nothing
    const skip = ok && row.checks.every((c) => c.cls === 'n/a');
    const want = skip ? [] : (controlClasses[row.scenario] ?? []);
    let ctl = noControl ? 'skipped' : 'n/a';
    if (!noControl && want.length) {
      const cr = control?.rows.find((r) => r.scenario === row.scenario);
      const red = new Set((cr?.checks ?? []).filter((c) => !c.ok).map((c) => c.cls));
      const missing = cr?.threw ? want : want.filter((c) => !red.has(c));
      ctl = missing.length ? `DID NOT FAIL: ${missing.join(',')}${cr?.threw ? ' (control threw: ' + cr.threw.slice(0, 120) + ')' : ''}` : `red [${want.join(',')}]`;
    }
    out[row.scenario] = { pass: !skip && ok && (noControl || !want.length || ctl.startsWith('red')), skip, ...(skip ? { reason: row.checks[0].label } : {}), control: ctl, failed: row.checks.filter((c) => !c.ok).map((c) => c.label), threw: row.threw, ms: row.ms };
  }
  return out;
}

/** the table's verdict of a scenario */
export const verdictLabel = (r) => (r.skip ? 'SKIP' : r.pass ? 'PASS' : 'FAIL');

/** whether these verdicts fail the gate */
export const gateFailed = (v) => Object.values(v).some((r) => verdictLabel(r) === 'FAIL');

/** the count of each verdict label */
export const tally = (v) => {
  const n = { PASS: 0, SKIP: 0, FAIL: 0 };
  for (const r of Object.values(v)) n[verdictLabel(r)]++;
  return n;
};
