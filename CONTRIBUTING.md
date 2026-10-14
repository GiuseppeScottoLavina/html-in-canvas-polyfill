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
npm run demo             # http://127.0.0.1:8765/examples/
```

`npm test` and `npm run test:examples` must pass before a pull request. CI runs `npm test`, the build, the bundle check and the package contents on Linux; `test:examples`, `test:plugins` and `test:pages` need WebGPU in headless Chrome for the effect checks and run locally.

## Browser gates

Changes that can affect what is drawn, when, or where input lands also need the browser gates. They drive real, headed browsers, take the screen focus and need an unlocked screen, so they run locally on macOS and not in CI:

```sh
npm run test:gates       # browser gates in headed Chrome, each with its positive control
npm run test:mutants     # every seeded bug must be caught by a gate
npm run test:wpt         # the official WPT HTML-in-Canvas tests; Chrome Canary is the native oracle
npm run test:xbrowser    # Firefox and Safari through WebDriver (quit Safari first)
npm run test:frameworks  # React, Vue, Svelte and Lit apps (run `npm install` in test/frameworks once)
```

If you cannot run them, say so in the pull request. The harness launches its own browsers with throwaway profiles under `.profiles/` and writes results to `.scratch/` (both git-ignored); it never touches a browser it did not start.

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

Describe what the change proves and what it does not, list the commands you ran and the ones you could not, and add a `CHANGELOG.md` entry under the unreleased version. The pull request template has the checklist. Releases (npm, tags) are made by the maintainer.
