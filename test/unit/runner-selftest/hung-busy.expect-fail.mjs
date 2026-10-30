import { test } from '/test/unit/lib/t.js';
// blocks the main thread for good: the in-page timeout cannot fire, the runner must report the page as hung
test('a test that never yields the main thread', () => { for (;;) { /* busy */ } });
