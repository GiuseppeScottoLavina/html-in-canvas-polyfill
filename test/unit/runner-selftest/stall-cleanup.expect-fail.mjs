import { test } from '/test/unit/lib/t.js';
// the body passes, then its cleanup blocks the main thread longer than a test may run and returns: a stall in the cleanup, and the test is never reported
// as a pass (it used to be printed `ok` and counted, its pass published before the cleanup ran)
test('a body that passes, then a cleanup that blocks the main thread for 7 s', (t) => { t.cleanup(() => { const end = performance.now() + 7000; while (performance.now() < end) { /* busy */ } }); });
