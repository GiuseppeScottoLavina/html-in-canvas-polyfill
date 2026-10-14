# Unit tests

Pure logic: `test/unit/<module>/*.test.mjs` with `node:test`. Run: `node --test test/unit/<module>`.
DOM logic: `test/unit/<module>/*.browser.test.mjs`, run in Chrome by `test/unit/run.mjs` (headless=new by default).

## Commands
| command | what |
|---|---|
| `npm run test:unit` | all pure tests, then all browser tests |
| `npm run test:unit:browser` | all browser tests |
| `node test/unit/run.mjs --module <name> [--module <name2>]` | only `test/unit/<name>/` |
| `node test/unit/run.mjs --filter <text or /regex/>` | tests whose `"<file> > <test name>"` matches (case-insensitive) |
| `node test/unit/run.mjs path/to/x.browser.test.mjs` | explicit files |
| `--headed` | visible window instead of headless (only for debugging; never for perf claims) |
| `--timeout <ms>` | default per-test timeout (5000); per test: `test(name, fn, { timeout })` |
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
states the expected detection: `fail-`, `timeout-`, `pageerror-`, `loaderror-`. These files are never picked up by the normal run.

Chrome: own PID only, throwaway profile under `.profiles/`, removed on exit, unique debugging port, server on 127.0.0.1 with an ephemeral port.
