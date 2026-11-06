import { test } from '/test/unit/lib/t.js';
// the body passes and leaves a task queued before the runner's task after the test: that task blocks the main thread for 7 s, in the phase after the
// test, which is never reported as a pass
test('a body that passes and queues a task that blocks the main thread for 7 s', () => { setTimeout(() => { const end = performance.now() + 7000; while (performance.now() < end) { /* busy */ } }, 0); });
