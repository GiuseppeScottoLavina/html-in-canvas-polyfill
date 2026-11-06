// G-gallery's selection and verdict (scripts/gallery-plan.mjs): a selection that checks nothing is refused before a browser starts, and a run that
// checked nothing is never a pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { galleryPlan, galleryVerdict } from '../../../scripts/gallery-plan.mjs';

const known = { plugins: ['water', 'crt', 'template'], views: ['phone', 'ipad'] };

test('--controls-only with --no-control is refused: it used to exit 0 with 0 checks (control: either flag alone runs something)', () => {
  assert.match(galleryPlan(['--controls-only', '--no-control'], known).error ?? '', /checks nothing/);
  assert.match(galleryPlan(['--no-control', '--controls-only'], known).error ?? '', /checks nothing/);
  assert.deepEqual(galleryPlan(['--controls-only'], known), { error: null, plugins: [], views: ['phone', 'ipad'], off: false, controls: true, scope: 'diagnostic', skipped: ['plugins water, crt, template', 'off'] });
  assert.deepEqual(galleryPlan(['--no-control'], known), { error: null, plugins: ['water', 'crt', 'template'], views: ['phone', 'ipad'], off: true, controls: false, scope: 'diagnostic', skipped: ['the controls (--no-control)'] });
});

test('an unknown plugin, view or argument is refused, never skipped silently', () => {
  assert.match(galleryPlan(['--only=watr', '--no-control'], known).error ?? '', /no such plugin: "watr"/);
  assert.match(galleryPlan(['--only=water,watr'], known).error ?? '', /no such plugin: "watr"/, 'one unknown name among known ones');
  assert.match(galleryPlan(['--only='], known).error ?? '', /no such plugin: ""/);
  assert.match(galleryPlan(['--views=desktop'], known).error ?? '', /no such view: "desktop"/);
  assert.match(galleryPlan(['--views='], known).error ?? '', /no such view/);
  assert.match(galleryPlan(['--only', 'water'], known).error ?? '', /unknown argument "--only", "water"/, 'the space form would have run every plugin');
  assert.match(galleryPlan(['--control-only'], known).error ?? '', /unknown argument/);
});

test('a valid selection runs what it names: the plugins, "off", the views', () => {
  assert.deepEqual(galleryPlan(['--only=crt,off', '--views=phone'], known), { error: null, plugins: ['crt'], views: ['phone'], off: true, controls: true, scope: 'diagnostic', skipped: ['plugins water, template', 'views ipad'] });
  assert.deepEqual(galleryPlan(['--only=off', '--no-control'], known), { error: null, plugins: [], views: ['phone', 'ipad'], off: true, controls: false, scope: 'diagnostic', skipped: ['plugins water, crt, template', 'the controls (--no-control)'] });
  assert.deepEqual(galleryPlan([], known), { error: null, plugins: ['water', 'crt', 'template'], views: ['phone', 'ipad'], off: true, controls: true, scope: 'full', skipped: [] });
});

test('the verdict: a failure fails, zero checks and zero controls fail, anything checked without a failure passes', () => {
  assert.deepEqual(galleryVerdict({ failed: 0, checks: 0, controls: 0 }), { pass: false, green: false, line: 'G-gallery: FAILED (nothing was checked: 0 checks, 0 controls)' });
  assert.equal(galleryVerdict({ failed: 2, checks: 40, controls: 8 }).pass, false);
  assert.deepEqual(galleryVerdict({ failed: 0, checks: 40, controls: 8, scope: 'full' }), { pass: true, green: true, line: 'G-gallery: OK (40 checks, 8 controls red)' });
  assert.equal(galleryVerdict({ failed: 0, checks: 0, controls: 8 }).pass, true, 'controls alone are a check');
});

test('a diagnostic selection (--no-control, controls only, some plugins or views) can pass but is never green and never reads as the gate (preview.25: `OK`, pass: true)', () => {
  // what the auditor ran: one plugin, one view, no controls; and the controls alone
  for (const argv of [['--only=water', '--views=phone', '--no-control'], ['--controls-only'], ['--no-control'], ['--only=water,crt,template'], ['--views=ipad']]) {
    const plan = galleryPlan(argv, known);
    assert.equal(plan.error, null);
    if (plan.error !== null) continue;
    assert.equal(plan.scope, 'diagnostic', argv.join(' '));
    assert.ok(plan.skipped.length > 0, argv.join(' '));
    const v = galleryVerdict({ failed: 0, checks: 1, controls: plan.controls ? 8 : 0, scope: plan.scope, skipped: plan.skipped });
    assert.equal(v.pass, true, 'nothing failed');
    assert.equal(v.green, false, argv.join(' '));
    assert.match(v.line, /^G-gallery: DIAGNOSTIC PASS, not the gate \(/);
    assert.doesNotMatch(v.line, /: OK /);
  }
  assert.equal(galleryVerdict({ failed: 0, checks: 1, controls: 0, scope: 'diagnostic', skipped: ['the controls (--no-control)'] }).line,
    'G-gallery: DIAGNOSTIC PASS, not the gate (1 checks, 0 controls red; not run: the controls (--no-control))');
  // a diagnostic run that failed is a failure, as a full one
  assert.deepEqual(galleryVerdict({ failed: 1, checks: 3, controls: 0, scope: 'diagnostic', skipped: ['off'] }), { pass: false, green: false, line: 'G-gallery: FAILED (1 checks)' });
  // control: the full selection, also when --only names every plugin and "off", is the gate
  for (const argv of [[], ['--only=water,crt,template,off', '--views=phone,ipad']]) {
    const plan = galleryPlan(argv, known);
    assert.equal(plan.error === null && plan.scope, 'full', argv.join(' '));
    assert.equal(galleryVerdict({ failed: 0, checks: 40, controls: 8, scope: 'full', skipped: [] }).green, true);
  }
});
