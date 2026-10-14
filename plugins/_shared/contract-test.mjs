// Node test of a plugin folder against the folder contract (plugins/README.md): `contractTest(import.meta.url)` in plugins/<name>/test/*.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { checkPluginFolder } from './contract.mjs';

/** @param {string} testUrl  import.meta.url of a test file in plugins/<name>/test/ */
export function contractTest(testUrl) {
  test('the folder satisfies the plugin contract (plugins/README.md)', async () => {
    assert.deepEqual(await checkPluginFolder(fileURLToPath(new URL('..', testUrl)).replace(/\/$/, '')), []);
  });
}
