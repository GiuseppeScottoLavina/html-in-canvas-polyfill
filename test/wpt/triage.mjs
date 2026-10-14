// Compare the three configurations of a WPT run and sort every difference into a category with a written reason.
//   A oracle (Chrome Canary, native), B subject (Chrome stable + polyfill), C control (stable alone).
// Categories of a subtest where the oracle passes and the subject does not (expectations.json carries the reason):
//   bug          polyfill defect (id in `reason`), must be fixed, tracked until then
//   deviation    documented in docs/SUPPORT-MATRIX.md / API-CONTRACT.md (feature id in `reason`)
//   impossible   cannot be done by a userland polyfill (the reason says why)
//   flaky        the subject result changes between repetitions
// Not a polyfill difference: `native-issue` (the oracle fails the subtest too, or it needs the real top layer / fullscreen).
import { readFileSync, existsSync } from 'node:fs';
import { featureById } from '../../src/contracts/features.js';

export const CATEGORIES = ['bug', 'deviation', 'impossible', 'flaky'];

/** Subtest key: name plus its occurrence number (a file may repeat a name). @param {{name:string}[]} subtests */
function keyed(subtests) {
  const seen = new Map(); const out = new Map();
  for (const s of subtests) { const n = seen.get(s.name) ?? 0; seen.set(s.name, n + 1); out.set(n ? `${s.name} #${n + 1}` : s.name, s); }
  return out;
}

const passed = s => s?.status === 'PASS';

/** The expectation that covers subtest `name` of test `exp`: the longest matching `subtests` prefix, else the test-level entry. */
export function expectationFor(exp, name) {
  if (!exp) return null;
  const subs = Object.entries(exp.subtests ?? {}).filter(([prefix]) => name.startsWith(prefix)).sort((a, b) => b[0].length - a[0].length);
  return subs.length ? subs[0][1] : (exp.category ? exp : null);
}

/**
 * @param {{A:object,B:object,C?:object}} docs  result documents of run.mjs
 * @param {object} expectations  test/wpt/expectations.json
 * @param {object|null} [baseline]  test/wpt/oracle-baseline.json: when the oracle run is NOT the build that matches the pinned WPT revision (Canary auto-updated past it),
 *   a subtest that passed at the pinned build counts as a native pass (oracle drift), so a polyfill failure there still needs a written reason.
 */
export function triage({ A, B, C }, expectations, baseline = null) {
  const rows = []; const counts = { files: { A: 0, B: 0, C: 0, P: 0, total: 0 }, subtests: { A: 0, B: 0, C: 0, P: 0, total: 0 } };
  const drift = !!baseline && A.config.version !== baseline.build;
  const driftList = [];
  const cat = { 'pass-both': 0, 'native-issue': 0, 'subject-only': 0, bug: 0, deviation: 0, impossible: 0, flaky: 0, unexplained: 0 };
  const catFiles = { 'pass-both': 0, 'native-issue': 0, 'subject-only': 0, bug: 0, deviation: 0, impossible: 0, flaky: 0, unexplained: 0 };
  const problems = []; const nativePassOursFail = [];
  const tests = expectations?.tests ?? {};
  for (const id of Object.keys(A.tests)) {
    const a = A.tests[id]; const b = B.tests[id]; const c = C?.tests[id];
    const ak = keyed(a.result.subtests); const bk = keyed(b?.result.subtests ?? []); const ck = keyed(c?.result.subtests ?? []);
    const exp = tests[id];
    const row = { id, type: a.type, A: summary(a), B: summary(b), C: summary(c), subs: [], category: null, reason: null };
    counts.files.total++; counts.subtests.total += Math.max(ak.size, 1);
    if (a.pass) counts.files.A++; if (b?.pass) counts.files.B++; if (c?.pass) counts.files.C++;
    const names = new Set([...ak.keys(), ...bk.keys()]);
    let worst = null; let pinnedFilePass = drift ? a.result.status === 'OK' || a.pass : a.pass;
    for (const name of names) {
      const sb = bk.get(name); const sc = ck.get(name);
      let sa = ak.get(name);
      if (passed(sa)) counts.subtests.A++; if (passed(sb)) counts.subtests.B++; if (passed(sc)) counts.subtests.C++;
      if (drift && !passed(sa) && baseline.pass?.[id]?.includes(name)) { driftList.push({ id, name, now: sa?.status ?? 'MISSING' }); sa = { name, status: 'PASS' }; }
      if (drift && !passed(sa)) pinnedFilePass = false;
      if (passed(sa)) counts.subtests.P++;
      let kind;
      if (passed(sa) && passed(sb)) kind = 'pass-both';
      else if (!passed(sa) && passed(sb)) kind = 'subject-only';
      else if (!passed(sa)) kind = 'native-issue';
      else {
        const e = expectationFor(exp, name);
        const unstable = b && !b.stable;
        kind = e?.category && CATEGORIES.includes(e.category) ? e.category : unstable ? 'flaky' : 'unexplained';
        row.subs.push({ name, A: sa?.status, B: sb?.status ?? 'MISSING', category: kind, reason: e?.reason ?? (unstable ? 'unstable between repetitions' : null), message: sb?.message });
        nativePassOursFail.push({ id, name });
        if (kind === 'unexplained') problems.push(`native passes and the polyfill fails, no entry in expectations.json: ${id} :: ${name}`);
        if (e && !e.reason) problems.push(`expectation without a written reason: ${id} :: ${name}`);
      }
      cat[kind]++;
      if (kind !== 'pass-both' && kind !== 'native-issue' && kind !== 'subject-only') worst = worst ?? kind;
    }
    const aPass = drift ? pinnedFilePass && ak.size > 0 : a.pass;
    if (aPass) counts.files.P++;
    row.category = worst ?? (aPass ? (b?.pass ? 'pass-both' : 'native-issue') : 'native-issue');
    if (worst) row.reason = row.subs[0]?.reason ?? null;
    catFiles[row.category === 'pass-both' && !b?.pass ? 'native-issue' : row.category]++;
    rows.push(row);
  }
  return { rows, counts, cat, catFiles, problems, nativePassOursFail, drift: drift ? { build: baseline.build, oracle: A.config.version, subtests: driftList } : null };
}

function summary(t) {
  if (!t) return { status: 'MISSING', pass: false, np: 0, n: 0 };
  const np = t.result.subtests.filter(s => s.status === 'PASS').length;
  return { status: t.result.status, pass: t.pass, np, n: t.result.subtests.length, stable: t.stable };
}

/** The three gate conditions (docs/TEST-PLAN.md G-wpt-subset). @returns {string[]} failures */
export function gateFailures({ A, B, C }, expectations, result) {
  const fails = [...result.problems.map(p => `(i) ${p}`)];
  const allowed = expectations?.controlPass ?? {};
  for (const [id, t] of Object.entries(C?.tests ?? {})) {
    if (t.pass && !allowed[id]) fails.push(`(ii) control passes without the polyfill and is not a documented vacuous pass: ${id}`);
  }
  for (const [id, t] of Object.entries(C?.tests ?? {})) if (t.pass && allowed[id] && !B.tests[id]?.pass) fails.push(`(ii) ${id} passes in the control but not in the subject`);
  for (const id of expectations?.pass ?? []) {
    if (!B.tests[id]?.pass) fails.push(`(iii) expected to pass in the subject, does not: ${id} (${summary(B.tests[id]).np}/${summary(B.tests[id]).n} subtests)`);
  }
  for (const [id, min] of Object.entries(expectations?.partial ?? {})) {
    const s = summary(B.tests[id]);
    if (s.np < min) fails.push(`(iii) regression: ${id} passes ${s.np}/${s.n} subtests, expected at least ${min}`);
  }
  for (const id of expectations?.stable ?? []) if (B.tests[id] && !B.tests[id].stable) fails.push(`(iii) unstable between repetitions: ${id}`);
  for (const [id, e] of Object.entries(expectations?.tests ?? {})) {
    if (!A.tests[id]) fails.push(`expectations.json names a test that does not exist: ${id}`);
    for (const x of [e, ...Object.values(e.subtests ?? {})]) {
      if (!x.category) continue;
      if (!CATEGORIES.includes(x.category)) fails.push(`expectation of ${id} has the unknown category ${x.category}`);
      else if (x.category === 'bug' ? !/^WPT-B\d+$/.test(x.reason ?? '') : !featureById(x.reason ?? '')) fails.push(`expectation of ${id}: reason "${x.reason}" is neither a feature id of docs/SUPPORT-MATRIX.md nor a bug id (WPT-Bn)`);
    }
  }
  return fails;
}

export function loadJson(file) { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; }

export function formatTable(result) {
  const pad = (s, n) => String(s).padEnd(n);
  const lines = [pad('test', 70) + pad('oracle A', 10) + pad('subject B', 11) + pad('control C', 10) + 'category'];
  for (const r of result.rows) {
    const f = x => (x.status === 'MISSING' ? '-' : `${x.np}/${x.n}`);
    lines.push(pad(r.id.slice(0, 68), 70) + pad(f(r.A), 10) + pad(f(r.B), 11) + pad(f(r.C), 10) + `${r.category}${r.reason ? ': ' + r.reason : ''}`);
  }
  return lines.join('\n');
}
