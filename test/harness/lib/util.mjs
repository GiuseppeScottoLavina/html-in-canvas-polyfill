// Shared constants and small pure helpers (no I/O besides path resolution).
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
/** test/harness */
export const HARNESS_DIR = resolve(here, '..');
/** Repository root (two levels above test/harness). */
export const PROJECT_ROOT = resolve(HARNESS_DIR, '../..');
/** The ONLY place throwaway Chrome profiles may live. */
export const PROFILES_DIR = resolve(PROJECT_ROOT, '.profiles');
/** Git-ignored scratch area for traces, screenshots, diff PNGs. */
export const SCRATCH_DIR = resolve(PROJECT_ROOT, '.scratch');

export const FRAME_120 = 1000 / 120; // 8.333 ms
export const FRAME_60 = 1000 / 60;   // 16.667 ms

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Order statistics of a numeric sample. Quantiles use the nearest-rank method.
 * @param {number[]} values
 * @returns {{n:number,min?:number,p50?:number,p90?:number,p95?:number,p99?:number,max?:number,mean?:number}}
 */
export function stats(values) {
  const v = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  const n = v.length;
  if (!n) return { n: 0 };
  const q = p => v[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))];
  return { n, min: v[0], p50: q(0.5), p90: q(0.9), p95: q(0.95), p99: q(0.99), max: v[n - 1], mean: v.reduce((a, b) => a + b, 0) / n };
}

/** Nearest-rank quantile (0 for an empty array). */
export function quantile(values, p) {
  const v = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))] : 0;
}

/**
 * Run `fn(i)` `count` times at a fixed period using sleep+spin for precision. `intervalMs = 0` means back-to-back.
 * `fn` is NOT awaited between sends (pipelined) so the injector cadence is independent of CDP ack latency; the acks are
 * collected separately. The result always carries the cadence that was really achieved, because an injector that is
 * quietly slower than requested invalidates a latency/jank measurement.
 *
 * @template T
 * @param {number} count
 * @param {number} intervalMs requested send-to-send period
 * @param {(i:number)=>Promise<T>|T} fn
 * @returns {Promise<PacedReport>}
 *
 * @typedef {object} PacedReport
 * @property {number} count
 * @property {number} requestedMs
 * @property {ReturnType<typeof stats>} actual send-to-send gaps (ms)
 * @property {ReturnType<typeof stats>} ackMs per-call CDP round trip (ms)
 * @property {number|null} effectiveHz 1000 / median achieved gap
 * @property {boolean} cadenceOk median within 15 % (min 1 ms) of requested and p95 within 1.5x + 2 ms; always true for 0
 * @property {number} totalMs
 */
export async function paced(count, intervalMs, fn, { spinMs = 1.5 } = {}) {
  const t0 = performance.now(); const sent = []; const acks = []; const inflight = [];
  for (let i = 0; i < count; i++) {
    if (intervalMs > 0) {
      const target = t0 + i * intervalMs; const wait = target - performance.now();
      if (wait > spinMs + 1) await sleep(wait - spinMs - 1);
      while (performance.now() < target) { /* spin to hit the target precisely */ }
    }
    const s = performance.now(); sent.push(s);
    inflight.push(Promise.resolve(fn(i)).then(() => acks.push(performance.now() - s)));
  }
  await Promise.all(inflight);
  const gaps = []; for (let i = 1; i < sent.length; i++) gaps.push(sent[i] - sent[i - 1]);
  const actual = stats(gaps);
  const cadenceOk = intervalMs <= 0 || count < 3 ? true
    : Math.abs(actual.p50 - intervalMs) <= Math.max(1, 0.15 * intervalMs) && actual.p95 <= intervalMs * 1.5 + 2;
  return { count, requestedMs: intervalMs, actual, ackMs: stats(acks), effectiveHz: actual.p50 ? 1000 / actual.p50 : null, cadenceOk, totalMs: performance.now() - t0 };
}

/** Throw with a readable message unless `cond`. */
export function assert(cond, msg) { if (!cond) throw new Error(msg); }
