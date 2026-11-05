// G-gallery's selection and verdict (scripts/gallery-plan.mjs): a selection that checks nothing is refused before a browser starts, and a run that
// checked nothing is never a pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { galleryPlan, galleryVerdict } from '../../../scripts/gallery-plan.mjs';

const known = { plugins: ['water', 'crt', 'template'], views: ['phone', 'ipad'] };

test('--controls-only with --no-control is refused: it used to exit 0 with 0 checks (control: either flag alone runs something)', () => {
  assert.match(galleryPlan(['--controls-only', '--no-control'], known).error ?? '', /checks nothing/);
  assert.match(galleryPlan(['--no-control', '--controls-only'], known).error ?? '', /checks nothing/);
  assert.deepEqual(galleryPlan(['--controls-only'], known), { error: null, plugins: [], views: ['phone', 'ipad'], off: false, controls: true });
  assert.deepEqual(galleryPlan(['--no-control'], known), { error: null, plugins: ['water', 'crt', 'template'], views: ['phone', 'ipad'], off: true, controls: false });
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
  assert.deepEqual(galleryPlan(['--only=crt,off', '--views=phone'], known), { error: null, plugins: ['crt'], views: ['phone'], off: true, controls: true });
  assert.deepEqual(galleryPlan(['--only=off', '--no-control'], known), { error: null, plugins: [], views: ['phone', 'ipad'], off: true, controls: false });
  assert.deepEqual(galleryPlan([], known), { error: null, plugins: ['water', 'crt', 'template'], views: ['phone', 'ipad'], off: true, controls: true });
});

test('the verdict: a failure fails, zero checks and zero controls fail, anything checked without a failure passes', () => {
  assert.deepEqual(galleryVerdict({ failed: 0, checks: 0, controls: 0 }), { pass: false, line: 'G-gallery: FAILED (nothing was checked: 0 checks, 0 controls)' });
  assert.equal(galleryVerdict({ failed: 2, checks: 40, controls: 8 }).pass, false);
  assert.deepEqual(galleryVerdict({ failed: 0, checks: 40, controls: 8 }), { pass: true, line: 'G-gallery: OK (40 checks, 8 controls red)' });
  assert.equal(galleryVerdict({ failed: 0, checks: 0, controls: 8 }).pass, true, 'controls alone are a check');
});
