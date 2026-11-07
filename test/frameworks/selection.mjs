// The framework selection of test/frameworks/run.mjs (--only): every name must be a framework of the suite, so that a misspelt --only= is refused before anything
// is built instead of running nothing and printing PASS (it did until 1.0.0-rc.1).
export const ALL_FRAMEWORKS = ['react', 'vue', 'svelte', 'lit'];

/** @param {string|undefined} only the value of --only, undefined without the option @returns {{frameworks: string[], error?: undefined} | {error: string}} */
export function selectFrameworks(only) {
  if (only === undefined) return { frameworks: [...ALL_FRAMEWORKS] };
  const names = only.split(',');
  const unknown = names.filter((n) => !ALL_FRAMEWORKS.includes(n));
  if (unknown.length) return { error: `--only=${only}: ${unknown.map((n) => JSON.stringify(n)).join(', ')} is not a framework of the suite (${ALL_FRAMEWORKS.join(', ')})` };
  return { frameworks: ALL_FRAMEWORKS.filter((f) => names.includes(f)) };
}
