## What this changes and why

<!-- One paragraph. Link the issue. Say what the change proves and what it does not. -->

## Evidence

<!-- Commands you ran and their result; numbers labelled with machine, browser version, DPR, refresh rate, headed or headless. Say what you could NOT run. -->

## Checklist (CONTRIBUTING.md)

- [ ] `npm run build && npm test` exits 0
- [ ] `npm run test:examples` exits 0 (if examples, bundles or the API changed)
- [ ] Browser gates run locally where the change can affect them (`npm run test:gates:all`, `npm run test:wpt`, `npm run test:xbrowser`, `npm run test:frameworks`; headed, macOS), or stated as not run
- [ ] New behaviour has a test or a gate, and every new gate has a positive control that turns it red
- [ ] No gate was weakened: no threshold raised, band widened, check dropped or error swallowed to get green
- [ ] Module rules kept: at most 1000 code lines per file, imports between `src/` modules only through `src/contracts/`, no runtime dependency, no network request on load
- [ ] Docs updated where behaviour changed (`npm run docs:sync` for `src/contracts/features.js`); every claim is backed by a doc, a gate or a file, or marked unverified
- [ ] `CHANGELOG.md` entry under `[Unreleased]`
