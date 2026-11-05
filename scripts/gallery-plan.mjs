// What a G-gallery invocation runs (scripts/check-gallery.mjs), and its verdict. Pure, tested in test/unit/gate-tooling/gallery-plan.test.mjs.
// A selection that checks nothing is refused before any browser starts, and a run that checked nothing is never a pass: an empty green would read as
// "every plugin passed".

const FLAGS = new Set(['--no-control', '--controls-only']);
const VALUED = ['--only=', '--views='];

/**
 * @param {string[]} argv the arguments after the script name
 * @param {{plugins: string[], views: string[]}} known the plugin names (manifest plus template) and the view names
 * @returns {{error: string} | {error: null, plugins: string[], views: string[], off: boolean, controls: boolean}}
 */
export function galleryPlan(argv, known) {
  const bad = argv.filter((a) => !FLAGS.has(a) && !VALUED.some((p) => a.startsWith(p)));
  if (bad.length) return { error: `unknown argument ${bad.map((a) => JSON.stringify(a)).join(', ')} (accepted: --only=a,b --views=phone,ipad --no-control --controls-only)` };
  const list = (/** @type {string} */ p) => { const a = argv.filter((x) => x.startsWith(p)).at(-1); return a === undefined ? null : a.slice(p.length).split(',').map((s) => s.trim()); };
  const only = list('--only='), views = list('--views=');
  const unknownPlugins = only?.filter((n) => n !== 'off' && !known.plugins.includes(n)) ?? [];
  if (unknownPlugins.length) return { error: `--only names no such plugin: ${unknownPlugins.map((n) => JSON.stringify(n)).join(', ')} (known: ${[...known.plugins, 'off'].join(', ')})` };
  const unknownViews = views?.filter((n) => !known.views.includes(n)) ?? [];
  if (unknownViews.length) return { error: `--views names no such view: ${unknownViews.map((n) => JSON.stringify(n)).join(', ')} (known: ${known.views.join(', ')})` };
  const controlsOnly = argv.includes('--controls-only'), controls = !argv.includes('--no-control');
  if (controlsOnly && !controls) return { error: '--controls-only with --no-control checks nothing' };
  const plugins = controlsOnly ? [] : known.plugins.filter((n) => !only || only.includes(n));
  const off = !controlsOnly && (!only || only.includes('off'));
  if (!plugins.length && !off && !controls) return { error: 'the selection checks nothing' };
  return { error: null, plugins, views: views ?? known.views, off, controls };
}

/**
 * PASS only when nothing failed and something was checked.
 * @param {{failed: number, checks: number, controls: number}} n
 * @returns {{pass: boolean, line: string}}
 */
export function galleryVerdict({ failed, checks, controls }) {
  if (failed) return { pass: false, line: `G-gallery: FAILED (${failed} checks)` };
  if (checks + controls === 0) return { pass: false, line: 'G-gallery: FAILED (nothing was checked: 0 checks, 0 controls)' };
  return { pass: true, line: `G-gallery: OK (${checks} checks, ${controls} controls red)` };
}
