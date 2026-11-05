import { test } from '/test/unit/lib/t.js';
// blocks the main thread longer than a test may run, then returns: the runner must report the page as hung, and diagnose a stall (the page answers again and
// reports the long task of this test), not a page that never yields
test('a test that blocks the main thread for 7 s, then returns', () => { const end = performance.now() + 7000; while (performance.now() < end) { /* busy */ } });
