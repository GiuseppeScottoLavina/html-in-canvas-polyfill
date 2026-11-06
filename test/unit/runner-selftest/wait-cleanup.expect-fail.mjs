import { test } from '/test/unit/lib/t.js';
// the body passes, then its cleanup waits on a promise that never settles: the page keeps answering, the file runs past --file-timeout, and the test is
// never reported as a pass (it used to be printed `ok ... (0 ms)` and counted)
test('a body that passes, then a cleanup that never ends', (t) => { t.cleanup(() => new Promise(() => {})); });
