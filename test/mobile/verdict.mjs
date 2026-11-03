// The mobile gate's per-scenario verdicts (test/mobile/run.mjs): a real run and its positive control merged into one verdict per scenario. Pure, so it is unit tested
// (test/unit/gate-tooling/mobile-verdict.test.mjs) without a device.

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
    // a scenario that only reported a documented skip (class n/a) has nothing to control
    const want = row.checks.every((c) => c.cls === 'n/a') ? [] : (controlClasses[row.scenario] ?? []);
    let ctl = noControl ? 'skipped' : 'n/a';
    if (!noControl && want.length) {
      const cr = control?.rows.find((r) => r.scenario === row.scenario);
      const red = new Set((cr?.checks ?? []).filter((c) => !c.ok).map((c) => c.cls));
      const missing = cr?.threw ? want : want.filter((c) => !red.has(c));
      ctl = missing.length ? `DID NOT FAIL: ${missing.join(',')}${cr?.threw ? ' (control threw: ' + cr.threw.slice(0, 120) + ')' : ''}` : `red [${want.join(',')}]`;
    }
    out[row.scenario] = { pass: ok && (noControl || !want.length || ctl.startsWith('red')), control: ctl, failed: row.checks.filter((c) => !c.ok).map((c) => c.label), threw: row.threw, ms: row.ms };
  }
  return out;
}

/** the table's verdict of a scenario */
export const verdictLabel = (r) => (r.pass ? 'PASS' : 'FAIL');
