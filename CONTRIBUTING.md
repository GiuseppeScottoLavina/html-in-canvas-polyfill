# Contributing

Thank you for taking a look. Bug reports with a minimal page, fixes and new tests are all welcome. Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md); security problems go through [SECURITY.md](SECURITY.md), not the issue tracker.

## Setup

Node.js 22 or newer and desktop Chrome.

```sh
npm ci
npm run build            # dist/: classic bundles and the ES module build
npm test                 # repo checks, type check, unit tests (Node and headless Chrome), bundle check
npm run test:examples    # every example and the code printed in the docs, then every plugin's gallery e2e, in headless Chrome
npm run test:plugins     # only the plugin gallery e2e tests (plugins/*/test/*.e2e.mjs), one headless Chrome at a time
npm run test:native-effects  # the effects over Chrome Canary's own HTML-in-Canvas (headed gates, gallery, example); skipped loudly without Canary
npm run test:pages       # the GitHub Pages site under /html-in-canvas-polyfill/: every page, the gallery with each plugin
npm run test:field       # the field test page end to end with a tab capture, and its positive controls
npm run demo             # http://127.0.0.1:8765/examples/
```

`npm test` and `npm run test:examples` must pass before a pull request. CI runs `npm test`, the build, the bundle check, the platform probe (`node test/platform/run.mjs`: fonts, form controls, scrollbars, DPR 1.25 and 1.5 and the text selection against native pixels) and the package contents on Linux (Ubuntu 24.04) and on Windows (Windows Server 2025), in headless Chrome without a GPU (the WebGPU tests report `SKIPPED: no WebGPU` there). The browser suites run on GitHub-hosted macOS runners (`.github/workflows/ci-macos.yml`, see "Where the suites run" below).

The harness finds Chrome (stable or Canary) where the platform installs it (macOS, Windows, Linux); `--chrome=<path>` or the environment variable `HIC_CHROME_PATH` points it at another executable. What CI does not cover on Windows: the headed browser gates (they run on macOS), a GPU, ClearType (LCD) text in the canvas comparisons, a real display scale, Edge, and Windows 10.

## Asking someone to test on their machine

Problems that depend on the platform (Windows text rendering and selection colours, classic scrollbars, a GPU, a fractional zoom) are best seen on that platform. The [field test](docs/guides/FIELD-TEST.md) is a page of the live demo that anyone can run in about five minutes, with no technical knowledge: send them the link and the short message in that guide, and read the report file they send back with `node scripts/field-report.mjs <file> --crops=<dir>`. `npm run test:field` checks the page end to end in headless Chrome, with a deliberately broken canvas as the positive control.

## Browser gates

Changes that can affect what is drawn, when, or where input lands also need the browser gates. They drive real, headed browsers, take the screen focus, move the mouse pointer out of the browser window and need an unlocked screen with a logged-in desktop: most of them run in CI on GitHub-hosted macOS runners, the rest locally on macOS (next section). Leave the mouse and keyboard alone while they run on your machine: the harness parks the OS pointer outside the browser window before each run (pointer input the gates did not send makes a Chrome gate run NOT USABLE: run it again; another application brought to the front, or a pointer moved, during a cross-browser scenario makes it run again, up to three attempts, after which it fails marked ENVIRONMENT rather than as a product failure; a failure in an undisturbed attempt is never retried):

```sh
npm run test:gates       # browser gates in headed Chrome, each with its positive control
npm run test:mutants     # every seeded bug must be caught by a gate
npm run test:wpt         # the official WPT HTML-in-Canvas tests; Chrome Canary is the native oracle
npm run test:gates:all   # lint, types, unit tests, the gates, the WPT gate, test:native-effects and the mutants, in one table
npm run test:xbrowser    # Firefox and Safari through WebDriver (quit Safari first)
npm run test:mobile      # the iOS Simulator and the Android Emulator (Xcode and the Android SDK; docs/guides/MOBILE.md)
npm run test:frameworks  # React, Vue, Svelte and Lit apps in headless Chrome (run `npm install` in test/frameworks once)
npm run test:stress      # repeated loads of the basic example with typing, bounded against hangs (headless)
npm run bench:compare    # the performance comparison (docs/PERFORMANCE-COMPARISON.md, about 45 minutes)
```

If you cannot run them, say so in the pull request. The harness launches its own browsers with throwaway profiles under `.profiles/` (under the OS temp directory on Windows) and writes results to `.scratch/` (both git-ignored); it never touches a browser it did not start.

## Where the suites run

The `CI macOS` workflow runs on GitHub's hosted `macos-15` runner: an Apple M1 virtual machine (3 vCPU) with a logged-in desktop, a 60 Hz virtual display (switched from 1024 x 768 to 1600 x 1200 at the start of each job), no HiDPI mode and a virtual GPU ("Apple Paravirtual device": WebGL and a WebGPU adapter). It installs the Google-signed Chrome stable and Canary (Chrome for Testing builds get no renderer there), records the display, GPU and session of every job (`test/ci/macos-env.mjs`, in the job's artifact), turns Spotlight indexing off and runs the gates without a DPR of their own at DPR 2 (`HIC_GATE_DPR=2`), the ratio of the Retina screens their thresholds were set on. Each job uploads its verdict files; a failing job also uploads the failing images, the logs and a screenshot of the desktop.

| suite | where | why |
| --- | --- | --- |
| 11 of the 16 Chrome gates (`npm run test:gates`: all but the five below), real + control | CI macOS, every push | pixels, hit testing, typing, resize, DOM identity and listeners do not depend on the refresh rate |
| mutation suite, the 32 mutants whose gates all run in CI | CI macOS: one mutant per gate on pull requests, all 32 nightly and on release tags (4 machines) | |
| `test:examples` without WebGPU (basic, form, scroll-and-resize, webgl-texture and the documentation smoke pages but wobble-plugin), `test:pages`, `test:frameworks`, `test:stress`, the platform probe | CI macOS, every push | headless Chrome with macOS fonts, controls and a GPU |
| `test:xbrowser` on Firefox, all scenarios but scroll | CI macOS, every push | the runner image's Firefox and geckodriver, with WebGL forced on (`HIC_FIREFOX_PREFS`) |
| the scroll scenario of `test:xbrowser` on Firefox | local | at the runner's DPR 1 the scrolled list differs from its twin on 6.6-6.8 % of the pixels (bound 5 %), the text antialiasing of a 1x macOS display; Firefox cannot be given a real DPR 2 there |
| G-scroll-cadence and its 8 mutants | local | thresholds from a 120 Hz display; at 60 Hz the live list moved in 61-74 % of the frames (70 % / 82 % required) |
| G-scroll-inner and the mutants that target it | local | its page-scroll step ended with unequal page offsets on the runner (polyfill 200 px, plain DOM 300 px after a 3-tick wheel stream, both settled): not yet explained; every other step passed |
| G-regress-paint-rate and its mutant (superseded-whole-tile-dropped) | local | the paint rate checks of M5 and M6 (>= 75 % of a tabular reference's paint rate) sit on the edge on the 3 vCPU runner: M6 measured 34.3-44.8 paints/s against a floor of 33.5-34.2 and failed 1 of 7 runs; as a gate of its own it failed 3 of 10 runs (35.9-41.8 paints/s against 40.7-43.3). The correctness checks of the same findings are G-regress-paint, which runs in CI with its 6 mutants |
| G-f1-form-effect, G-interposer-strong (and 2 mutants), `test:plugins`, the WebGPU examples (effect-plugin, plugins, the wobble-plugin smoke page), `test:native-effects` | local | continuous WebGPU effects present no frames on the virtual GPU (a transition effect does, and plain WebGPU presents at 60 fps): not yet explained; and the virtual GPU lost its WebGPU device in 1 of 10 runs (Metal command buffer timeout) |
| `test:field` | local | the tab capture is not reliable on the runner: 2 of 12 runs got no usable captured frame |
| `test:wpt` | local | 3 of the then 237 files were unstable between repetitions on the runner (measured before 0.1.0-preview.7); a run takes about 18 minutes there, and its oracle, Canary, changes daily |
| `test:xbrowser` on Safari and Safari Technology Preview, `test:mobile`, `bench:compare` | local | the runner images ship Safari 26, which the polyfill refuses (27 is the minimum), and no Technology Preview; simulators and emulators; performance numbers come from the 120 Hz machine |

The list lives in `test/ci/macos-plan.mjs`; anything not listed there runs in CI, and every CI run prints the list as warnings. To run the local-only rest unattended on a Mac with a 120 Hz display, a GPU and Chrome Canary:

```sh
npm run build
caffeinate -dimsu npm run test:local            # add -- --skip=mobile without the simulators
```

Leave the Mac alone while it runs. The harness moves the OS pointer outside the browser windows, records every pointer movement and application activation it did not cause, and reports such a run as NOT USABLE (Chrome gates, mutants) or runs the scenario again and marks it ENVIRONMENT after three disturbed attempts (cross-browser); a disturbed run is never counted as a product result.

To check on the runner that a gate or mutant is stable, start the workflow by hand from your branch (`gh workflow run ci-macos.yml --ref <branch> -f gates=g-regress-paint -f mutant_names=hit-last-only -f repeat=5 -f machines=2`, or Actions > CI macOS > Run workflow): `gates` and `mutant_names` pick what runs instead of the whole plan, `repeat` runs each selected gate (real + control) and mutant that many times on every machine, and `machines` runs the gates on up to five runners at once. One failed run fails the job, as on any other run.

## Rules the codebase keeps

- A gate that cannot fail is worth nothing: every gate has a positive control, a deliberately broken variant that must turn it red. Never weaken a gate to get green (no raised threshold, widened band, dropped check or swallowed error).
- Assert a non-blank surface before looking at a number, and measure main-thread cost from traces (`RunTask` against 8.33 ms), not the Long Tasks API.
- Label every number with machine, browser version, DPR, refresh rate and headed or headless. A number taken with machine load above threshold is reported, never used as a threshold.
- Effect plugins are not part of the polyfill: each lives in its own `plugins/<name>/` folder, imports nothing outside it except `plugins/_lib/` (code that several plugins share) and `src/effects/no-target.js`, and follows the contract of [plugins/README.md](plugins/README.md) (start from `plugins/_template/`; the build and `npm run lint` check it). Nothing in `src/` imports a plugin.
- `src/` modules import each other only through `src/contracts/`; at most 1000 code lines per file; no runtime dependency; no network request on load; never `blob:` URLs (`npm run lint` checks these).
- Unsupported content fails loudly: a placeholder, one console message and a `report()` entry. Content the browser itself leaves out of a canvas (cross-origin frames, images, mask images, `<use>` documents and videos) is drawn as the browser draws it instead of a placeholder.
- The feature tables of `docs/SUPPORT-MATRIX.md` are generated from `src/contracts/features.js` (`npm run docs:sync`).
- Every claim in the docs is backed by a test, a gate or a file, or marked unverified. No marketing superlatives.

## Pull requests

Describe what the change proves and what it does not, list the commands you ran and the ones you could not, and add a `CHANGELOG.md` entry under `[Unreleased]`. The pull request template has the checklist.

## Releases

Releases are made by the maintainer. A release is one commit that sets `version` in `package.json` and `src/version.js` (the build checks they are equal) and turns `[Unreleased]` in `CHANGELOG.md` into a dated `[x.y.z] - YYYY-MM-DD` section, tagged `vx.y.z`. Pushing the tag runs `.github/workflows/release.yml`: it checks that the tag names the package version and that the changelog section is dated, repeats the CI checks, publishes to npm with provenance (dist-tag from `publishConfig.tag`: `next` while the versions are previews) and creates the GitHub release with that changelog section as its notes.

npm authentication, in this order of preference:

- Trusted publishing (no secret): on npmjs.com, package settings > Trusted publisher > GitHub Actions, with owner `GiuseppeScottoLavina`, repository `html-in-canvas-polyfill`, workflow `release.yml` and environment `npm`. npm offers this setting once the package exists, so the first version is published with a token or from the maintainer's machine.
- A granular npm access token with publish rights on the package, stored as the repository (or `npm` environment) secret `NPM_TOKEN`. Remove it once trusted publishing is configured.
