# Unit tests

Pure logic: `test/unit/<module>/*.test.mjs` with `node:test` (`test/unit/lib/run-node-tests.mjs` runs them all, with the plugins' `plugins/*/test/*.test.mjs`). One module: `node --test 'test/unit/<module>/!(*.browser).test.mjs'` (the quotes let Node expand the pattern, which leaves out the browser tests).
DOM logic: `test/unit/<module>/*.browser.test.mjs` (and `plugins/**/*.browser.test.mjs`), run in Chrome by `test/unit/run.mjs` (headless=new by default).

## Commands
| command | what |
|---|---|
| `npm run test:unit` | all pure tests, then all browser tests |
| `npm run test:unit:browser` | all browser tests |
| `node test/unit/run.mjs --module <name> [--module <name2>]` | only `test/unit/<name>/` (`--module plugins`: only `plugins/`) |
| `node test/unit/run.mjs --filter <text or /regex/>` | tests whose `"<file> > <test name>"` matches (case-insensitive) |
| `node test/unit/run.mjs path/to/x.browser.test.mjs` | explicit files |
| `--headed` | visible window instead of headless (only for debugging; never for perf claims) |
| `--timeout <ms>` | default per-test timeout (5000); per test: `test(name, fn, { timeout })`. A page that does not answer the runner for that long is reported as hung; a shorter stall recovers and is printed as a note. A HUNG report names the test and its phase (body, cleanup, the task after it; known from a CDP binding even when the page never answers again), says whether the browser process answered, whether the page answered again within 10 s (a stall) or not (it never yields), and lists the main-thread tasks of a second or more the page reported. A test passes only once its body, its cleanup and the task after it have ended; the test a hang names is printed `HUNG` with its body's result and the phase it had not finished (`HUNG name (its body passed; its cleanup had not ended when the runner gave up on the page)`) and counted as hung, never `ok`, even when the page published a pass after the runner gave up on it, and any other test that had not finished is printed `RUN`. After a hung file Chrome is started again, so no later file shares a stuck renderer |
| `--file-timeout <ms>` | whole-file limit (60000), catches a main thread stuck in a sync loop |
| `--chrome stable\|canary\|<path>`, `--list`, `--quiet` | |
| `npm run test:unit:selftest` | the runner's own tests plus the expect-fail proof |

Exit code is non-zero on any failed/timed-out test, load error, hung page, uncaught page error (even outside a test), or when no test ran.
Uncaught errors/rejections during a test fail that test. `console.error/warn` during a test are printed under it but do not fail it.

## Writing a test
```js
import { test, assert, fixture, frames, microtasks, sleep } from '/test/unit/lib/t.js';
import { something } from '/src/foo/bar.js';        // repo root is served, no build

test('name', async t => {
  const root = fixture('<div id="a" style="width:40px">x</div>');   // removed automatically after the test
  t.cleanup(() => { /* runs after the test, in reverse order */ });
  await frames(2);                                                    // n rendering updates
  assert.equal(root.querySelector('#a').offsetWidth, 40);
});
```
API: `test`, `test.skip`, `assert.{ok,equal,notEqual,deepEqual,fail,throws,rejects}` (`equal` is `Object.is`; `throws/rejects` take a RegExp,
substring or error class), `fixture(html, style?)`, `frames(n)`, `microtasks()`, `sleep(ms)`. Each file runs in a fresh tab (clean globals).

## Expect-fail selftest
`--expect-fail` runs `*.expect-fail.mjs` files instead and exits 0 only if the runner reports each as a problem. The file-name prefix
states the expected detection: `fail-`, `timeout-`, `pageerror-`, `loaderror-`, `hung-` (hung, the test named, the page never answering again), `stall-` (hung, the test named, the page answering again with the long task of that test), `wait-` (the file past `--file-timeout` while the page kept answering: a promise that never settles). For the three kinds of hang the test must not be reported as passed, and a second word `test`, `cleanup` or `settle` (`stall-cleanup.expect-fail.mjs`, `stall-settle…`) requires the hang in that phase. `npm run test:unit:selftest` runs them with `--file-timeout=15000`. These files are never picked up by the normal run.

Chrome: found per platform (`--chrome` or `HIC_CHROME_PATH` for another executable), own PID only, throwaway profile under `.profiles/` (the OS temp directory on Windows), removed on exit, unique debugging port, server on 127.0.0.1 with an ephemeral port.
