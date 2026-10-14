/** console.error/warn at most once per key. */

/** @param {Console} [con] @returns {{once: (key: string, level: 'error'|'warn', ...args: unknown[]) => boolean}} */
export function createOnceLog(con = globalThis.console) {
  const seen = new Set();
  return {
    once(key, level, ...args) {
      if (seen.has(key)) return false;
      seen.add(key);
      try { con[level](...args); } catch { /* console may be absent */ }
      return true;
    },
  };
}
