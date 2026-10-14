import { test, assert } from '/test/unit/lib/t.js';
test('deliberately failing assertion', () => { assert.equal(1, 2); });
test('async throw', async () => { await null; throw new Error('deliberate async failure'); });
