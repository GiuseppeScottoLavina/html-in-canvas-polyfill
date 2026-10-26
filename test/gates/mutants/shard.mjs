// Splitting the mutant suite into shards that run on separate machines (the macOS CI job runs one shard per runner, .github/workflows/ci-macos.yml).
//
// Every shard runs the clean baseline of each gate it uses once, so a shard costs the gate runs of its mutants plus one baseline per distinct gate. The split
// is greedy (pure, deterministic, unit-tested): mutants in decreasing cost, each to the shard whose total grows least, ties to the lower shard index. Every
// mutant lands in exactly one shard, and the union of the shards is the whole suite.

/** Minutes per run of a gate WITHOUT its control, where they differ enough to matter; a gate not listed counts as DEFAULT_MINUTES (equal weights: the four
 *  nightly shards of the 40 CI mutants took 10 to 20 min each on the hosted macOS runner, 2026-10-26). */
export const GATE_MINUTES = {};
export const DEFAULT_MINUTES = 1;
const cost = (/** @type {string} */ gate) => GATE_MINUTES[/** @type {keyof typeof GATE_MINUTES} */ (gate)] ?? DEFAULT_MINUTES;

/** Parse `--shard=k/n` (1-based); null when absent. Throws on a malformed value. @param {string | undefined} v */
export function parseShard(v) {
  if (v === undefined) return null;
  const m = /^(\d+)\/(\d+)$/.exec(v);
  if (!m || +m[1] < 1 || +m[2] < 1 || +m[1] > +m[2]) throw new Error(`--shard must be k/n with 1 <= k <= n, got ${v}`);
  return { index: +m[1], count: +m[2] };
}

/**
 * The mutants of each shard and its estimated minutes.
 * @template {{name: string, gates: string[]}} M @param {M[]} mutants @param {number} count
 * @returns {{mutants: M[], minutes: number, gates: Set<string>}[]}
 */
export function planShards(mutants, count) {
  const shards = Array.from({ length: count }, () => ({ mutants: /** @type {M[]} */ ([]), minutes: 0, gates: new Set() }));
  const runs = (/** @type {M} */ m) => m.gates.reduce((s, g) => s + cost(g), 0);
  const order = mutants.map((m, i) => ({ m, i })).sort((a, b) => runs(b.m) - runs(a.m) || a.i - b.i);
  for (const { m } of order) {
    let best = 0, bestTotal = Infinity;
    shards.forEach((s, k) => {
      const total = s.minutes + runs(m) + m.gates.filter((g) => !s.gates.has(g)).reduce((t, g) => t + cost(g), 0);
      if (total < bestTotal) { best = k; bestTotal = total; }
    });
    const s = shards[best];
    s.minutes = bestTotal;
    for (const g of m.gates) s.gates.add(g);
    s.mutants.push(m);
  }
  // each shard keeps the suite's own order
  for (const s of shards) s.mutants.sort((a, b) => mutants.indexOf(a) - mutants.indexOf(b));
  return shards;
}
