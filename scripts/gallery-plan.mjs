// What a G-gallery invocation runs (scripts/check-gallery.mjs), and its verdict. Pure, tested in test/unit/gate-tooling/gallery-plan.test.mjs.
// A selection that checks nothing is refused before any browser starts, and a run that checked nothing is never a pass: an empty green would read as
// "every plugin passed". A selection that leaves anything out (a plugin, a view, "off", the controls) is a diagnostic run: it can pass, but it is never
// green and never reads as the gate. The scenes (other content beside the form, examples/plugins/ `?scene=`) are one more item of a selection, named `scenes` in --only as "off" is.

const FLAGS = new Set(['--no-control', '--controls-only']);
const VALUED = ['--only=', '--views='];

/**
 * @param {string[]} argv the arguments after the script name
 * @param {{plugins: string[], views: string[]}} known the plugin names (manifest plus template) and the view names
 * @returns {{error: string} | {error: null, plugins: string[], views: string[], off: boolean, scenes: boolean, controls: boolean, scope: 'full' | 'diagnostic', skipped: string[]}}
 *   `scope` is 'full' only when every plugin, every view, "off", the scenes and the controls run; `skipped` names what a diagnostic run leaves out
 */
export function galleryPlan(argv, known) {
  const bad = argv.filter((a) => !FLAGS.has(a) && !VALUED.some((p) => a.startsWith(p)));
  if (bad.length) return { error: `unknown argument ${bad.map((a) => JSON.stringify(a)).join(', ')} (accepted: --only=a,b --views=phone,ipad --no-control --controls-only)` };
  const list = (/** @type {string} */ p) => { const a = argv.filter((x) => x.startsWith(p)).at(-1); return a === undefined ? null : a.slice(p.length).split(',').map((s) => s.trim()); };
  const only = list('--only='), views = list('--views=');
  const unknownPlugins = only?.filter((n) => n !== 'off' && n !== 'scenes' && !known.plugins.includes(n)) ?? [];
  if (unknownPlugins.length) return { error: `--only names no such plugin: ${unknownPlugins.map((n) => JSON.stringify(n)).join(', ')} (known: ${[...known.plugins, 'off', 'scenes'].join(', ')})` };
  const unknownViews = views?.filter((n) => !known.views.includes(n)) ?? [];
  if (unknownViews.length) return { error: `--views names no such view: ${unknownViews.map((n) => JSON.stringify(n)).join(', ')} (known: ${known.views.join(', ')})` };
  const controlsOnly = argv.includes('--controls-only'), controls = !argv.includes('--no-control');
  if (controlsOnly && !controls) return { error: '--controls-only with --no-control checks nothing' };
  const plugins = controlsOnly ? [] : known.plugins.filter((n) => !only || only.includes(n));
  const off = !controlsOnly && (!only || only.includes('off'));
  const scenes = !controlsOnly && (!only || only.includes('scenes'));
  if (!plugins.length && !off && !scenes && !controls) return { error: 'the selection checks nothing' };
  const ranViews = views ?? known.views;
  const skipped = [
    ...(known.plugins.some((n) => !plugins.includes(n)) ? [`plugins ${known.plugins.filter((n) => !plugins.includes(n)).join(', ')}`] : []),
    ...(off ? [] : ['off']),
    ...(scenes ? [] : ['the scenes']),
    ...(known.views.some((n) => !ranViews.includes(n)) ? [`views ${known.views.filter((n) => !ranViews.includes(n)).join(', ')}`] : []),
    ...(controls ? [] : ['the controls (--no-control)']),
  ];
  return { error: null, plugins, views: ranViews, off, scenes, controls, scope: skipped.length ? 'diagnostic' : 'full', skipped };
}

/**
 * PASS only when nothing failed and something was checked; GREEN (the gate) only for a pass of the full selection. A diagnostic pass says what it left out.
 * @param {{failed: number, checks: number, controls: number, scope?: 'full' | 'diagnostic', skipped?: string[]}} n
 * @returns {{pass: boolean, green: boolean, line: string}}
 */
export function galleryVerdict({ failed, checks, controls, scope = 'full', skipped = [] }) {
  if (failed) return { pass: false, green: false, line: `G-gallery: FAILED (${failed} checks)` };
  if (checks + controls === 0) return { pass: false, green: false, line: 'G-gallery: FAILED (nothing was checked: 0 checks, 0 controls)' };
  if (scope !== 'full') return { pass: true, green: false, line: `G-gallery: DIAGNOSTIC PASS, not the gate (${checks} checks, ${controls} controls red; not run: ${skipped.join('; ') || 'unknown'})` };
  return { pass: true, green: true, line: `G-gallery: OK (${checks} checks, ${controls} controls red)` };
}
