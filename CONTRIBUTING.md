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
npm run test:pages       # the GitHub Pages site under /html-in-canvas-polyfill/: every page, the gallery with each plugin
npm run test:field       # the field test page end to end with a tab capture, and its positive control
npm run demo             # http://127.0.0.1:8765/examples/
```

`npm test` and `npm run test:examples` must pass before a pull request. CI runs `npm test`, the build, the bundle check, the platform probe (`node test/platform/run.mjs`: fonts, form controls, scrollbars, DPR 1.25 and 1.5 and the text selection against native pixels) and the package contents on Linux (Ubuntu 24.04) and on Windows (Windows Server 2025), in headless Chrome without a GPU (the WebGPU tests report `SKIPPED: no WebGPU` there); `test:examples`, `test:plugins` and `test:pages` need WebGPU in headless Chrome for the effect checks and run locally.

The harness finds Chrome (stable or Canary) where the platform installs it (macOS, Windows, Linux); `--chrome=<path>` or the environment variable `HIC_CHROME_PATH` points it at another executable. What CI does not cover on Windows: the headed browser gates, a GPU, ClearType (LCD) text in the canvas comparisons, a real display scale, Edge, and Windows 10.

## Asking someone to test on their machine

Problems that depend on the platform (Windows text rendering and selection colours, classic scrollbars, a GPU, a fractional zoom) are best seen on that platform. The [field test](docs/guides/FIELD-TEST.md) is a page of the live demo that anyone can run in about five minutes, with no technical knowledge: send them the link and the short message in that guide, and read the report file they send back with `node scripts/field-report.mjs <file> --crops=<dir>`. `npm run test:field` checks the page end to end in headless Chrome, with a deliberately broken canvas as the positive control.

## Browser gates

Changes that can affect what is drawn, when, or where input lands also need the browser gates. They drive real, headed browsers, take the screen focus and need an unlocked screen, so they run locally on macOS and not in CI:

```sh
npm run test:gates       # browser gates in headed Chrome, each with its positive control
npm run test:mutants     # every seeded bug must be caught by a gate
npm run test:wpt         # the official WPT HTML-in-Canvas tests; Chrome Canary is the native oracle
npm run test:xbrowser    # Firefox and Safari through WebDriver (quit Safari first)
npm run test:frameworks  # React, Vue, Svelte and Lit apps (run `npm install` in test/frameworks once)
```

If you cannot run them, say so in the pull request. The harness launches its own browsers with throwaway profiles under `.profiles/` (under the OS temp directory on Windows) and writes results to `.scratch/` (both git-ignored); it never touches a browser it did not start.

## Rules the codebase keeps

- A gate that cannot fail is worth nothing: every gate has a positive control, a deliberately broken variant that must turn it red. Never weaken a gate to get green (no raised threshold, widened band, dropped check or swallowed error).
- Assert a non-blank surface before looking at a number, and measure main-thread cost from traces (`RunTask` against 8.33 ms), not the Long Tasks API.
- Label every number with machine, browser version, DPR, refresh rate and headed or headless. A number taken with machine load above threshold is reported, never used as a threshold.
- Effect plugins are not part of the polyfill: each lives in its own `plugins/<name>/` folder, imports nothing outside it except `plugins/_lib/` (code that several plugins share) and `src/effects/no-target.js`, and follows the contract of [plugins/README.md](plugins/README.md) (start from `plugins/_template/`; the build and `npm run lint` check it). Nothing in `src/` imports a plugin.
- `src/` modules import each other only through `src/contracts/`; at most 1000 code lines per file; no runtime dependency; no network request on load; never `blob:` URLs (`npm run lint` checks these).
- Unsupported content fails loudly: a placeholder, one console message and a `report()` entry.
- The feature tables of `docs/SUPPORT-MATRIX.md` are generated from `src/contracts/features.js` (`npm run docs:sync`).
- Every claim in the docs is backed by a test, a gate or a file, or marked unverified. No marketing superlatives.

## Pull requests

Describe what the change proves and what it does not, list the commands you ran and the ones you could not, and add a `CHANGELOG.md` entry under `[Unreleased]`. The pull request template has the checklist.

## Releases

Releases are made by the maintainer. A release is one commit that sets `version` in `package.json` and `src/version.js` (the build checks they are equal) and turns `[Unreleased]` in `CHANGELOG.md` into a dated `[x.y.z] - YYYY-MM-DD` section, tagged `vx.y.z`. Pushing the tag runs `.github/workflows/release.yml`: it checks that the tag names the package version and that the changelog section is dated, repeats the CI checks, publishes to npm with provenance (dist-tag from `publishConfig.tag`: `next` while the versions are previews) and creates the GitHub release with that changelog section as its notes.

npm authentication, in this order of preference:

- Trusted publishing (no secret): on npmjs.com, package settings > Trusted publisher > GitHub Actions, with owner `GiuseppeScottoLavina`, repository `html-in-canvas-polyfill`, workflow `release.yml` and environment `npm`. npm offers this setting once the package exists, so the first version is published with a token or from the maintainer's machine.
- A granular npm access token with publish rights on the package, stored as the repository (or `npm` environment) secret `NPM_TOKEN`. Remove it once trusted publishing is configured.
