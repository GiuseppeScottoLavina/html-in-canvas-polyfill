import { test, assert } from '/test/unit/lib/t.js';
test('passes itself but the page later throws', () => { assert.ok(true); setTimeout(() => { throw new Error('deliberate uncaught page error'); }, 20); });
test('keeps running afterwards', async () => { await new Promise(r => setTimeout(r, 60)); });
