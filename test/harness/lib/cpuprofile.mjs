// CPU profile (Profiler.stop result) -> per-function self and total (inclusive) time tables.
// Negative sample deltas (seen in Chrome profiles) are clamped to 0: a profile with many of them is not exact attribution evidence.

/**
 * @param {{nodes:object[],samples:number[],timeDeltas:number[]}} profile
 * @returns {{totalMs:number, negativeDeltas:number, bySelf:Row[], byTotal:Row[]}}
 * @typedef {{fn:string,url:string,line:number,selfMs:number,totalMs:number,selfPct:number,totalPct:number}} Row
 */
export function summarizeCpuProfile(profile, { top = 25 } = {}) {
  const byId = new Map(profile.nodes.map(n => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const keyOf = id => { const cf = byId.get(id).callFrame; return `${cf.functionName || '(anonymous)'}|${cf.url}|${cf.lineNumber}`; };
  const self = new Map(), total = new Map(); let sum = 0, negative = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const raw = profile.timeDeltas[i] ?? 0; if (raw < 0) negative++;
    const d = Math.max(0, raw); sum += d;
    const id = profile.samples[i];
    self.set(keyOf(id), (self.get(keyOf(id)) ?? 0) + d);
    const seen = new Set(); // count a function once per stack so recursion does not inflate `total`
    for (let n = id; n !== undefined; n = parent.get(n)) { const k = keyOf(n); if (!seen.has(k)) { seen.add(k); total.set(k, (total.get(k) ?? 0) + d); } }
  }
  const row = k => { const [fn, url, line] = k.split('|'); const s = self.get(k) ?? 0, t = total.get(k) ?? 0;
    return { fn, url, line: Number(line), selfMs: s / 1000, totalMs: t / 1000, selfPct: 100 * s / (sum || 1), totalPct: 100 * t / (sum || 1) }; };
  const rank = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k]) => row(k));
  return { totalMs: sum / 1000, negativeDeltas: negative, bySelf: rank(self), byTotal: rank(total) };
}

/** Plain-text table of a summary, for logs. */
export function formatProfileTable(summary, { by = 'bySelf', rows = 15 } = {}) {
  const lines = [`${by} (total ${summary.totalMs.toFixed(1)} ms)`, 'self ms  total ms  function'];
  for (const r of summary[by].slice(0, rows)) lines.push(`${r.selfMs.toFixed(1).padStart(7)}  ${r.totalMs.toFixed(1).padStart(8)}  ${r.fn} ${r.url.split('/').pop()}:${r.line}`);
  return lines.join('\n');
}
