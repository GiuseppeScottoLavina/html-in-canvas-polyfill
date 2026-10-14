/**
 * Runaway guard: a snapshot pipeline that keeps committing without anything outside it asking for it is a feedback loop, never a page that is "busy".
 * Module: snapshot-store (src/snapshot/store/*). Pure (time is passed in), so node:test drives it directly.
 */

/** Window and rate that make a loop: this many commits inside the window, none of them preceded by outside damage. 30 commits/s for 3 s; a legitimate animation damages every frame. */
export const RUNAWAY_WINDOW_MS = 3000;
export const RUNAWAY_MIN_COMMITS = 90;

/** Damage that comes from the pipeline itself (re-damage of a dropped tile, a layout re-check, a late resource) and never proves that the page changed. */
const INTERNAL = new Set(['forced', 'geometry', 'resource', 'caret']);

/**
 * @param {{onTrip: (info: {commits: number, windowMs: number}) => void, windowMs?: number, minCommits?: number}} opts
 * @returns {{commit: (now: number) => void, damage: (cause: string, now: number) => void}}
 */
export function createRunawayGuard({ onTrip, windowMs = RUNAWAY_WINDOW_MS, minCommits = RUNAWAY_MIN_COMMITS }) {
  /** @type {number[]} */
  let times = [];
  let outside = -Infinity;
  let tripped = false;
  return {
    /** @param {string} cause @param {number} now */
    damage(cause, now) {
      if (!INTERNAL.has(cause)) { outside = now; times = []; }
    },
    /** One published version. @param {number} now */
    commit(now) {
      if (tripped) return;
      times.push(now);
      while (times.length && times[0] < now - windowMs) times.shift();
      if (times.length >= minCommits && now - times[0] >= windowMs * 0.8 && times[0] > outside) { tripped = true; onTrip({ commits: times.length, windowMs }); }
    },
  };
}
