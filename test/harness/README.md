# Test harness

Zero-dependency (Node >= 22, system Chrome) harness for measuring the polyfill in a REAL, headed, foreground Chrome over raw CDP.
Everything is imported from `test/harness/index.mjs`. The harness needs no polyfill build: `node test/harness/selftest.mjs`
exercises every helper against tiny built-in fixtures and proves the positive controls fire.

```js
import * as H from '/abs/path/test/harness/index.mjs';
const srv = await H.startServer();                       // static server rooted at the repo (COOP/COEP, no-store, /__hic/hash)
// startServer({ files: { '/dist/x.js': '/abs/anywhere/mutant.js' } }) serves an absolute file (even under .scratch/) at a URL path: used by the gates' --bundle-file, mutants and sabotaged control bundles.
// screenshotElement(page, sel, { beyondViewport }) / page.screenshot({ beyondViewport }) pass captureBeyondViewport (it re-lays the page out: avoid it when comparing layouts).
const browser = await H.launchChrome({ name: 'myrun' }); // headed, throwaway profile under .profiles/ (anything else is refused)
const page = await browser.newPage();
await page.requireForeground('start');                   // throws loudly unless hasFocus && visible
const { surfacePage, refPage } = await H.openPair(browser, srv, 'f1', { mode: 'poly', bundle: '/dist/hic.iife.js' });
const d = H.compareImages(H.compositeOver(await H.readCanvas(surfacePage), [255, 255, 255]), (await H.screenshotElement(refPage)).img); // d.fraction, d.countOver16 ...
await browser.close();                                   // terminates ONLY our PID (+ stragglers carrying our unique profile path)
await srv.close();
```

## Rules baked in
- Profiles: `launchChrome` refuses any `userDataDir` outside `PROFILES_DIR`: `<repo>/.profiles/`, or `hic-live-polyfill-profiles` under the OS temp directory on Windows. It only ever signals the PID it spawned (on Windows, `taskkill /T` on that PID: its renderers are its children) and stragglers whose command line carries the unique profile path (`ps`; on Windows a CIM query through PowerShell).
- Chrome: `chrome: 'stable' | 'canary'` is looked up where the platform installs it (`resolveChrome`: the application bundles on macOS; Program Files, Program Files (x86) and the per-user install on Windows; `/opt/google/chrome` and `/usr/bin/google-chrome*` on Linux); `HIC_CHROME_PATH` overrides `stable`, and any other value is an executable path.
- Measure jank from traces (`RunTask` on `CrRendererMain` vs 8.33 / 16.7 ms), not the Long Tasks API (50 ms threshold).
- A gate needs a non-blank test (`pixelStats(img).nonBlank`) and a positive control.
- `--force-color-profile=srgb` is on by default: without it compositor screenshots differ from canvas readback on every pixel.
- Machine load: call `loadSnapshot()` / `waitForQuiet()` before a measured run and store the result with the numbers. Any
  process the run did not start above 15 % CPU marks the run `highLoad` (machine load above threshold). The selftest does this and records `loadBefore/loadAfter/highLoad`.

## Modules (`lib/`)
| file | what |
|---|---|
| `chrome.mjs` | `launchChrome({chrome:'stable'\|'canary'\|path, dpr:1\|2, windowSize, nativeDrawElement, scrollbars:'default'\|'hidden'\|'overlay'\|'classic', colorProfile, parkPointer, extraArgs})`, `Browser` (newPage: each of its CDP steps throws a named error after 20 s instead of waiting; `traceStart/traceStop(file)`, `info`, `close`, `kill`), `resolveChrome`, `chromeCandidates`. `nativeDrawElement` adds `--enable-blink-features=CanvasDrawElement` (native baseline). |
| `page.mjs` | `Page`: `evaluate`, `navigate`, foreground (`focusState`, `assertForeground`, `ensureForeground`, `requireForeground`), `setInnerSize`, `screenshot`, `measureRaf`, `sampleHeap`/`perfMetrics`/`domCounters` (heap, DOM nodes, listeners), `cpuProfileStart/Stop`, primitive input, `errors()` (console+exceptions+log), `installPointerGuard` / `flushPointerGuard` / `foreignPointer` (trusted pointer input at a position the harness never sent; every gate page has it and such a run is NOT USABLE). |
| `input.mjs` | Paced input that REPORTS the achieved cadence: `typeKeys`, `pressKeys`, `wheelStream`, `mouseStream`, `mouseDrag`. Each returns `{requestedMs, actual:{p50,p95..}, cadenceOk, effectiveHz, ackMs, pageSaw?}`; `probe:true` also records what the page received. |
| `window.mjs` | `dragResize` (REAL window drag: `Browser.setWindowBounds` in steps at a cadence, reports page-seen sizes), resize recorder. |
| `trace.mjs` | `analyzeTrace(file, {window\|windowMarks, thresholdMs})`: RunTask count over 8.33/16.7/50 ms, p50/p95/p99/max, busy %, `longFrames` with top events. Errors out (never "0 long tasks") if marks or tasks are missing. |
| `cpuprofile.mjs` | `summarizeCpuProfile`, `formatProfileTable`: per-function self/total tables. |
| `pixels.mjs`, `png.mjs` | `pixelStats` (`nonBlank`), `compareImages` (diffPixels, maxDiff, countOver16, fraction, diff image), PNG codec. |
| `oracle-pixel.mjs` | `readCanvas` (canvas backing store read inside a rAF), `screenshotElement` (compositor screenshot of an element's border box). |
| `oracle-blank.mjs` | `startBlankDetector`: samples the canvas after every rendering update (MessageChannel task after the rAF update). `injectBlankFrame()` is its positive control (a one-frame blank that must be caught at the exact frame). Reports blank runs, size-write list, observer cost. An empty canvas yields an INVALID run, never a pass. |
| `oracle-latency.mjs` | `measureLatency`: trusted event -> first rendering update whose canvas region shows the change. `commitMs` is exact up to frame quantisation; `presentedMs` adds one frame period (estimate). Observer cost: one `drawImage+getImageData` of <= 160x96 per frame (~0.2-2 ms), so never mix it with a RunTask-budget run. Timeouts and missing events are counted, not turned into numbers. |
| `env.mjs` | `environmentFacts` (Chrome version, DPR, window, rAF-measured refresh, scrollbar probe, GPU, mac model). |
| `load.mjs` | `loadSnapshot`, `waitForQuiet` (shared-machine high machine load check). |
| `os-activation.mjs` | macOS: `watchActivations()` (every application activation and every OS pointer movement, AppKit observer; `since`, `movesSince`), `frontmostApp`, `activateApp(pids)`, `foreignActivations` (pure). The xbrowser runner reruns a scenario during which another application came to the front (a browser that is not active swallows trusted clicks) or the pointer moved. |
| `os-pointer.mjs` | macOS: `osPointer(pid)` (the OS pointer, the displays, the windows of a process), `parkOsPointer(pid)` (moves a pointer resting over the browser's windows out of them; `launchChrome` does it, `browser.pointerPark` records it), `parkingSpot` (pure). A headed Chrome delivers a resting pointer to the page at every clipped screenshot and tab activation. |
| `fixtures.mjs` | `openFixture`, `openPair`, `fixtureUrl`, `checkBundle`. |
| `webdriver.mjs` | Firefox / Safari over W3C WebDriver (not exported from `index.mjs`): `launchEngine({engine})` -> `WdSession` (navigate, evaluate, screenshot, click, typeText, key, wheel, setWindowSize, close), `probeSafari()`. Used by `test/xbrowser/` (docs/TEST-PLAN.md 2.9). |

## Fixtures (`test/fixtures/`, served by `server.mjs`)
`?mode=ref|poly|native&bundle=<url path|none>` (a comma-separated list loads several classic scripts in order: core, then the optional effects bundles) (plus `nodes=N` for F4, `cap=N`, `legacy=1`, `painter=none`; see `shared/boot.js`).
- `ref` plain DOM (canvas replaced by a div, children moved verbatim): the pixel oracle's reference.
- `poly` canvas `content=drawable` + the polyfill bundle. The bundle is optional at the loader level but REQUIRED for `poly`;
  a missing bundle fails loudly (node side `BUNDLE MISSING`, page side red banner + `__HIC_FIXTURE.fatal`).
- `native` canvas + the browser's implementation (launch with `nativeDrawElement:true`; Chrome 154 only knows `layoutSubtree`, set automatically).
- F1 water form (the frozen demo page of an earlier prototype), F2 scroll (page scroll, sticky header, nested scrollers), F3 resize (flex-wrap, media queries at 800/520), F4 large app (`nodes=200|500|1000|2000`, exact element count of `#root` subtree), F5 classic scrollbars (`::-webkit-scrollbar`, 15 px gutters regardless of the OS setting), F6 form controls, F7 system scrollbars (unstyled scrollers: the platform's own bars; every box edge on whole device pixels at DPR 1, 1.25, 1.5 and 2). F6 and F7 are opened by path (`openFixture(page, srv, '/test/fixtures/f7-system-scrollbars/index.html', ...)`).

## Self-test
`node test/harness/selftest.mjs [--only=env,input,trace,window,pixel,blank,latency,fixtures,pointer] [--skip=...] [--chrome=canary] [--waitquiet=ms] [--keep-profile]`
It opens a REAL, headed Chrome window (and a second tab for the foreground control) for the duration of the run, takes over the screen focus, and needs an unlocked screen; the `LOAD highLoad=true` line it may print means another process was busy at the start (the checks assert correctness, not timing). The server traversal check sends raw requests with `http.request`, because `fetch()` normalises `/../x`.
Writes `.scratch/selftest/<ts>/selftest.json` (environment, load before/after, checks, info, diff PNGs, trace), exits 1 on any failed check.
Positive controls proven: profile guard refuses directories outside .profiles/; `assertForeground` throws on a hidden tab; cadence reporter flags a deliberately
slowed injector; trace parser separates 12 ms from 40 ms tasks and errors on empty windows; two blank images diff to 0 while the non-blank test refuses them;
blank detector catches a width-write blank and refuses a canvas that never had content; latency probe measures a 60 ms delayed app
as >= 60 ms and reports no-event / no-change as such; fixtures fail loudly without a bundle; the pointer guard reports a trusted event the harness did not send and, on macOS,
the real OS pointer placed over the page (a clipped screenshot delivers it), while the parked pointer delivers nothing.

## Known limits (read before trusting a number)
- Scrollbar style follows the macOS setting (it flipped between runs: auto-hide vs 15 px bars, depending on pointing devices). `--disable-features=OverlayScrollbar` is not guaranteed on macOS. Always record `environmentFacts().scrollbar`; use F5 for guaranteed classic bars.
- Pixel readback of a WebGPU-presented canvas is unreliable; use `screenshotElement` for effect-on surfaces.
- Two-tab comparison: the launch tab may carry an infobar (shorter viewport). compare `innerWidth`/`innerHeight`/`devicePixelRatio` of both pages; use `openPair` (fresh tabs) or `setInnerSize`.
- Hidden tabs stall rAF: oracles call `assertForeground` and bring the page to front; only one browser run at a time.
- Window-drag resize and `Input.*` need a real foreground window; `activateProcess()` uses osascript (macOS).
