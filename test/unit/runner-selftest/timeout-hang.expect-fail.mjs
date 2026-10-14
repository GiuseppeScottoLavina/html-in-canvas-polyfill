import { test } from '/test/unit/lib/t.js';
test('never-resolving test hits its timeout', () => new Promise(() => {}), { timeout: 300 });
