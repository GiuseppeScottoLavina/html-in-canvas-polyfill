// Application activations that are not the browser under test (test/harness/lib/os-activation.mjs foreignActivations): the xbrowser runner reruns a scenario
// during which another application came to the front, and fails it as an environment problem when that never stops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foreignActivations } from '../../harness/lib/os-activation.mjs';

test('activations of the browser\'s own processes are not foreign; any other application is', () => {
  const acts = [{ pid: 10, at: 1, name: 'Safari' }, { pid: 77, at: 2, name: 'Mail' }, { pid: 10, at: 3, name: 'Safari' }];
  assert.deepEqual(foreignActivations(acts, [10, 11]).map((a) => a.name), ['Mail']);
  assert.deepEqual(foreignActivations(acts.filter((a) => a.pid === 10), [10]), []);
  assert.deepEqual(foreignActivations([], [10]), []);
});
