# Frequently asked questions

Short answers to the questions people ask first, with links to the evidence. Where something was not measured, this page says so. Figures describe the current code (`1.0.0`) unless dated.

## What is this?

[HTML-in-Canvas](https://github.com/WICG/html-in-canvas) is a WICG proposal, with a draft pull request to the HTML Standard ([whatwg/html#11588](https://github.com/whatwg/html/pull/11588)), that lets a `<canvas>` draw its own live HTML children: you mark the canvas `content="drawable"`, mark children `drawable`, and draw them with `ctx.drawElementImage()` in a `paint` event (or upload them as WebGL / WebGPU textures). The elements stay real DOM, so they keep focus, typing, hit testing and accessibility. Chrome 157 ships the API enabled by default, and Chrome Canary exposes it too; the proposal is still changing.

This package implements that API in JavaScript for browsers that do not have it yet: Chrome 130 to 156 on desktop and Android, Firefox 155+ and Safari 27+, and Safari on iPadOS 26+ (Safari on the iPhone, iOS 26+, is admitted but unqualified: no physical iPhone has run the suites). Where the browser implements the API itself, the package steps aside. It also ships two extensions that are not part of the proposal: a frame cap and a WebGPU effect host for plugins.

## How does it work?

1. The children of the canvas move into an invisible layer (`<hic-layer>`, `opacity: 0`) placed over the canvas. The browser lays out, focuses, scrolls, hit-tests and edits them as usual.
2. When something changes, the polyfill clones the changed part with its live state (values, checked states, scroll offsets, focus and hover), inlines the CSS and resources it needs, and wraps it in an SVG `foreignObject` image as a `data:` URL.
3. The browser decodes that image. The result goes into a retained 2D surface per drawable, and `drawElementImage` draws from that surface.

The browser itself paints the HTML; the polyfill only takes pictures of it. Details: [DESIGN-DECISIONS.md](../DESIGN-DECISIONS.md) and [ARCHITECTURE.md](../ARCHITECTURE.md).

## Why is the drawn picture sometimes a frame behind the live DOM?

A picture has to be cloned, serialised, parsed, laid out and decoded by the browser (`Image.decode()` is asynchronous) before it can be drawn. A native implementation paints inside the browser's own rendering step, and page script cannot run there.

What that means, measured on Chromium ([API-CONTRACT.md, section 8](../API-CONTRACT.md#8-timing-model-summary-full-detail-in-architecture-adr-c)):

- A change that needs no font or image to load is usually painted one frame later; one that does needs two frames or more.
- Two shortcuts bring the common cases close to native: text typed in a single-line field is drawn into the surface at once (in Chrome; in Firefox and Safari each keystroke waits for a snapshot), and inner scrolling is composed from cached pages of the scroller.
- During a window resize drag, the canvas shows pixels from 1 to 3 frames earlier, stretched into the new box. No frame is blank, but the picture is not current, and a click can land on the new layout while the pixels still show the old one.

## Does it change my DOM?

Yes, and this is the main structural difference from native. The children of the canvas are moved into the layer, a sibling of the canvas. `children`, `parentNode`, `firstChild` and similar properties answer as if nothing had moved, and `canvas.querySelector()` and similar queries search the layer. CSS `:last-child`, `:nth-child`, the `+` combinator, live collections and `MutationObserver`s on the canvas can still see the layer. The polyfill also writes `data-hic-canvas` on the canvas, a merged `aria-owns`, and an `id` on a top-level drawable that has none. See [Known limitations](../../README.md#known-limitations) and [FRAMEWORKS.md, section 2](FRAMEWORKS.md#2-what-a-framework-sees).

## Why is the core about 376 KB minified (128 KB gzipped)?

In the current build, 375,522 bytes minified and 128,154 gzipped ([BUNDLES.md](../BUNDLES.md)). That is large for a polyfill. The other package on npm (`html-in-canvas-polyfill`) is about 30 KB minified and passes fewer of the WPT tests (66 of 230 files, at an older revision; [COMPARISON.md](../COMPARISON.md)).

Where the bytes go: the bytes esbuild attributes to each source module of the minified core (`node scripts/build.mjs --analyze`), grouped by function. The shares were measured on 0.1.0-preview.15 (341,671 bytes); the kilobytes apply each share to the current 375 KB, so they are approximate.

| part | share | about |
|---|---|---|
| snapshot capture: the clone with its live state, CSS collection and rewriting, resource inlining, SVG building | 22.6 % | 85 KB |
| API surface: the canvas, 2D, OffscreenCanvas and worker patches, argument checks, `ElementImage`, the `paint` event, options, `report()` | 16.8 % | 63 KB |
| live layer: relocation, DOM facades, geometry and hit testing, event bridging, the accessibility link | 13.4 % | 50 KB |
| scrolling: scroll offsets and classic scrollbars in snapshots, the scroll compositor and its planner | 12.7 % | 48 KB |
| change detection: mutation, input, style sheet, animation, image and video observers | 11.3 % | 42 KB |
| snapshot store: retained surfaces, versions, damage, the decode pump, the runaway guard | 9.8 % | 37 KB |
| caret, text selection and typed text | 5.4 % | 20 KB |
| scheduler and frame cap | 3.5 % | 13 KB |
| native detection | 2.4 % | 9 KB |
| utilities | 2.1 % | 8 KB |

**Why it cannot simply be lazy-loaded.** `install()` is synchronous by contract, so the API exists before any page script reads it, and the core must paint the first frame correctly on any page. Function coverage on an earlier build (0.1.0-preview.4, nine pages loaded and then used): 62 % of the code ran before the first paint, 14 % only on interaction, 24 % never on those pages. With the unit tests counted too, about 22 KB of source never ran, mostly the classic-scrollbar painter that Windows and Linux need. Code that usually runs on interaction can also be needed in a first frame: an autofocused field shows a caret, a scripted selection is painted, a scroller can start at any offset. Moving the scroll and typing fast paths to a lazily fetched chunk was measured: about 6 KB gzipped saved, a runtime request from the library's own directory added, a cold first paint about 2 ms faster. It was not adopted ([BUNDLES.md, "Why the core has its size"](../BUNDLES.md#why-the-core-has-its-size)).

**What is already split out.** The effect host, the example plugins, the native bridge for older Chrome drafts, the Firefox / Safari form-control painters, the WebGL / WebGPU texture methods and the worker side are separate bundles that a page loads only if it needs them.

**On a browser with the native API** the core patches nothing, but a page that lists its tag still downloads and parses it, since the core makes that decision itself. The loader avoids that download ([Does Chrome 157 download the polyfill?](#does-chrome-157-download-the-polyfill)).

## Is it accessible?

Partly, and less verified than the rest.

- The live elements stay in the document and in the accessibility tree: the layer is invisible (`opacity: 0`), not hidden from assistive technology. Focus, the tab order, keyboard input and IME work on the real elements.
- Natively, the children of the canvas are its accessibility children. To keep that structure after the move, the layer has `role="presentation"` and the canvas `aria-owns` its top-level children ([ARCHITECTURE.md, ADR-M](../ARCHITECTURE.md#adr-m-accessibility-link)).
- The gate G-a11y reads Chrome's real accessibility tree ([TEST-PLAN.md](../TEST-PLAN.md), section 2.8). On a list canvas and a form canvas, and on the water-form page, the subtree of the canvas node equals the one Chrome builds for the same HTML as a plain page, line by line: roles, names, values and order. Tab reaches every control in DOM order and the focused node is under the canvas; typed text, a slider key and a script text change show in the tree; a polite live region keeps its text and politeness; and the tree is the same after `uninstall()` and a new `install()`. Its control drops the `aria-owns` link and must fail. On the same fixture, Chrome's native implementation (Canary 159) builds the same tree.
- One real screen reader was run: VoiceOver in Safari 27.0.1 on macOS 27.0.1, by hand, on the fixture of G-a11y (2026-11-06; repeated on the candidates of 1.0.0-rc.2 to rc.7, and on 2026-11-13 and 2026-11-14, in Safari 27.2 on macOS 27.2.1, on the code of 1.0.0-rc.10 and of 1.0.0-rc.11). The page was read in order, the rotor listed the same headings and controls, Tab reached the seven controls in order, typing, a checkbox, a slider, a button's status message and a live update were announced, and after `uninstall()` and a new `install()` the page read the same: all 13 steps sounded as on the same HTML as a plain page ([TEST-PLAN.md](../TEST-PLAN.md), section 2.8).
- Not verified: NVDA, JAWS, TalkBack, VoiceOver on iOS and iPadOS, and the accessibility trees of Firefox and Safari. An accessibility tree is what a screen reader reads; the gate does not show what one announces, and one manual session covers one browser and one fixture.
- A drawable that is never drawn still exposes its layout position to assistive technology, where native exposes no geometry until it is drawn (deviation `a11y-geometry`). Mark unused views `aria-hidden`.

## What happens in a browser with the native API (Chrome 157)?

The polyfill steps aside. `install()` detects the API by behaviour, not by browser version: if the core of the API is there (`content="drawable"` or the earlier `layoutsubtree`, `onpaint`, and a 2D `drawElementImage` that behaves like a platform method), it patches nothing of the standard surface, and it never throws because a native build lacks, renames or adds a secondary member ([API-CONTRACT.md, section 2](../API-CONTRACT.md#2-feature-detection-and-the-native-first-policy)). Chrome 157 ships the API enabled by default, and there the polyfill steps aside (mode `native`, kind `complete`, measured on 157.0.8103.39 on 2026-11-04). It was also checked on Chrome Canary 157, 158 and 159, on Chromium 158 and 160 builds for Android, and on Chrome 157 for Android (a physical Pixel 7 Pro, 2026-11-13). Safari, Firefox and Chrome before 157 use the polyfill's own path.

Two caveats:

- The proposal still changes (on 2026-10-08, `ElementImage.width/height` became `getElementImageDefaultSize()`). The polyfill follows the WPT tests and can lag behind a change.
- Native implementations do not provide the two extensions. This library runs them over a native implementation too, with differences: there the frame cap bounds only effect frames, not the browser's own `paint` events ([EFFECTS-PLUGINS.md](EFFECTS-PLUGINS.md#on-a-native-implementation), [API-CONTRACT.md, section 7.6](../API-CONTRACT.md#76-over-a-native-implementation)). Code that relies on them depends on this library, not on the standard.

## Does Chrome 157 download the polyfill?

With the core's script tag, yes: 375,522 bytes (128,154 gzipped), and then the core steps aside. With the loader, no: `hic-live-loader.iife.min.js` (17,454 bytes, 6,320 gzipped) makes the same decision as `install()` and, on Chrome 157, settles `status: 'native'` without requesting the core, the engines bundle or the bridge (measured on Chrome 157.0.8103.39, `test/native-effects/g-native-loader.mjs`). Where the polyfill runs, the loader then fetches the core, which costs one extra request before it (+10 ms to the first paint from a local server, +45 ms with 40 ms of latency per request, measured headless). The page's own code waits for `await HicLiveLoader.load()` (or `load()` from `.../loader` with a bundler). On Chrome 157 there is no `HicInstalled`, so `whenPainted` is not available: draw from the `paint` event of the browser's own API ([GETTING-STARTED](GETTING-STARTED.md#loading-the-polyfill-only-where-it-runs), [API-CONTRACT section 2.4](../API-CONTRACT.md#24-the-loader-loadoptions---promiseloadresult)).

## Which browsers and devices are verified, and how?

"Verified" below means an automated suite ran there with positive controls: deliberately broken variants that must make the checks fail. Most suites compare the canvas with the same HTML rendered as a plain page in the same browser.

- **Desktop:** Chrome 154 and 155 on macOS (headed browser gates), Chrome 156 and 157 (its native feature switched off) in CI (headless on Linux and Windows, headed on macOS). Firefox 155 and 157 and Safari 27.0.1 on macOS, and Firefox 159 in CI on macOS, through WebDriver. Chrome 157 (Chrome for Testing 157.0.8103.39) and Chrome Canary 157 to 159 for the native path.
- **Physical devices, 2026-10-30:** a Pixel 7 Pro (Android 17, Chrome 156), a Huawei Mate 10 Pro (Android 10, Chrome 156) and an iPad Pro 11-inch (iPadOS 27.2). On 2026-11-13 the Pixel again, with Chrome 157: the polyfill steps aside for its native API. An iPhone XR on iOS 18.7 checked that unsupported versions are refused cleanly.
- **Simulators:** the iOS Simulator (iPhone 17 and iPad Air, iOS 26.4) and the Android Emulator (Chromium 158).
- **Not verified:** a physical iPhone on iOS 26 or later (Safari on the iPhone is unqualified); a physical Windows or Linux machine (CI only, headless, no GPU); Edge, Opera, Brave and other Chromium browsers; memory and canvas limits pushed to their edge on a phone (the phone budgets come from WebKit's limits, not from a measurement); frame timing on a phone GPU; battery use; WebGPU effects under a real finger (the plugins' touch rules are checked with emulated touch in headless Chrome, `npm run test:gallery`).

Row-by-row evidence: [SUPPORT-MATRIX.md](../SUPPORT-MATRIX.md) and [MOBILE.md](MOBILE.md#what-is-not-verified).

## How close is it to native?

On the official web-platform-tests for HTML-in-Canvas (248 files at the WPT commit of 2026-10-28), the polyfill passes 221 files and 340 of 381 subtests. Chrome Canary 159 passes 236 files and 369 subtests. Without the polyfill, 11 files pass, all of them vacuously. Every difference is triaged with a written reason, and no polyfill bug is open ([CONFORMANCE.md](../CONFORMANCE.md#triage-of-every-subtest)).

What cannot be done in userland, by the tests' own categories:

- **Paint timing** (20 subtests in 11 files): native fires `paint` inside the rendering step. The polyfill fires it at the end of its own frame and draws a snapshot that lags the DOM.
- **Single cases:** wide-gamut colour (snapshots are sRGB), the layout of `display: contents` children of the canvas, the geometry of inline drawables, DOM writes inside a `paint` handler, and drawing a nested canvas from its current bitmap.

Some deviations, such as the moved children, are not covered by WPT at all: see [SUPPORT-MATRIX.md](../SUPPORT-MATRIX.md).

## How fast is it?

See [PERFORMANCE-COMPARISON.md](../PERFORMANCE-COMPARISON.md) for numbers measured against native Chrome and the other package on the same pages, and [PERFORMANCE.md](PERFORMANCE.md) for how to read them. The short version: each update is done twice (the browser lays out and paints the live DOM, then the polyfill photographs it), so main-thread cost grows with the size of the drawable that changes. Keep frequently updated drawables well under about 1000 elements. First paint and memory are also worse than native.

Inner scrolling is drawn from cached pages of the scroller in each step's frame, and the exact snapshot replaces it when scrolling settles. Known cases where that compositor does not apply and each step is rebuilt as a snapshot:

- rows whose `:hover` style changes as they pass under a still mouse pointer (each hovered row is a change);
- horizontal scrolling (the compositor handles vertical scrollers only);
- Firefox at a device pixel ratio other than 1, and in Firefox any scroller with rounded corners or with form controls, images, SVG or transforms inside ([PERFORMANCE.md](PERFORMANCE.md#1-summary));
- Safari and Firefox at a raster scale that is not a whole number, such as a `maxDpr` of 1.5 or 2.5 ([PERFORMANCE.md](PERFORMANCE.md#5-tips));
- a scroller that holds the focus or a selection, once the pages planned before are dropped (no new plan is made while either is inside it, and a plan still being made ends when either comes inside);
- a scroller over whose port something else paints: an element outside it (also one with `pointer-events: none`, or its shadow, outline or generated box), or a background that is not one colour showing through a scroller without its own (`refusedBy.cover`); a sticky header that is not an opaque rectangle, also when it stops being one after the plan was made (`stats.snapshot.scroll.stale`), or that something else of the list paints over: a positioned row, or a flex or grid item, whose z-index is not below the header's (a header without a z-index counts as 0), and, under a header without a z-index (or of z-index 0), a row with a stacking context of its own such as `opacity` below 1 or a `transform` (`refusedBy.sticky`; a plain header with an opaque background needs no z-index);
- a scroller whose content keeps changing while its plan is made: a change between two of the plan's steps that an installed plan would not survive makes the plan again once (`stats.snapshot.scroll.stale` counts these), and a second one refuses the scroller until it is planned again (after a newer change, at most once a second).

The report counts each refusal by reason (`stats.snapshot.scroll.refusedBy`, [TROUBLESHOOTING.md](TROUBLESHOOTING.md#6-symptoms-without-an-error)).

## Is it safe? What about privacy?

The polyfill follows the read-back rules of the proposal, so the canvas stays origin-clean ([ARCHITECTURE.md, ADR-I](../ARCHITECTURE.md#adr-i-privacy-security-refusals-error-model)):

- Cross-origin images, fonts and CSS without CORS are not drawn, and neither are cross-origin or sandboxed iframes, `<object>` and `<embed>`: the element's box is drawn without its content, as natively, and one console message reports it. Same-origin iframes are drawn.
- `:visited` styles are dropped, and system colours resolve to defaults.
- Of the 104 WPT privacy tests, the polyfill passes 101 and native Chrome 103. By the triage, none of the other three fails by drawing excluded content: two because a selection decoration ends at a slightly different pixel, and one fails natively too.
- Snapshots are `data:` URLs, never `blob:`, so a strict CSP must allow `img-src data:`. The bundles make no network request when they load; snapshots fetch only same-origin or CORS resources the page could fetch itself, to inline them.
- The online playground runs your code in a sandboxed iframe with an opaque origin (`sandbox="allow-scripts"`).

Security reports: [SECURITY.md](../../SECURITY.md).

## Does it work with React, Vue, Svelte and Lit?

Yes, for what was tested. A real app in each of React 19, Vue 3, Svelte 5 and Lit 3 (in a shadow root) runs typing, clicks on drawn elements, keyed lists, conditional drawables, timers, remounts and uninstall against a plain-page twin, with positive controls. React 19 hydration works with `suppressHydrationWarning` on the canvas. These runs used headless Chrome at a device pixel ratio of 1, with development builds and, in a local run of 2026-11-06, with production builds of the same apps. Not verified: other frameworks, server rendering outside React, and performance. See [FRAMEWORKS.md](FRAMEWORKS.md) and its [list of what was not verified](FRAMEWORKS.md#6-not-verified).

## Is it production-ready?

It is a stable release of a polyfill for a proposed standard (`1.0.0` on npm; a new release goes to the `next` tag first and to `latest` once checked). The API it implements may still change: its stable rows follow Semantic Versioning, so a change of the standard that a page can observe comes in a major version, and the two extensions are experimental. What 1.0.0 promises, row by row, and the versioning policy: [STABILITY.md](../STABILITY.md). Use it where a wrong frame or a missing feature is acceptable, and test your own pages on your own target devices.

What is tested:

- 868 unit tests in Node and 1,302 in headless Chrome, with type, module-boundary and bundle-size checks;
- 17 browser gates in headed Chrome that compare the canvas with the plain page or with native Chrome (pixels, hit testing, typing, resizing, scrolling and its cadence, the accessibility tree), each with a positive control;
- a gate that runs mode `native-bridged` end to end over the earlier draft of Chrome 154 and 155 (G-bridged-translation);
- a mutation suite of 94 seeded bugs, every one of which must be caught;
- the official WPT tests, the four framework apps, and Firefox and Safari through WebDriver.

CI runs the unit tests on Linux and Windows, G-bridged-translation on Linux, and 12 of the 18 gates, 35 of the 94 mutants, the framework apps and Firefox on macOS. What needs a 120 Hz display, a fast machine, continuous WebGPU frames, Safari 27, Chrome Canary (the WPT oracle) or the phone simulators runs on the maintainer's machine ([CONTRIBUTING.md](../../CONTRIBUTING.md#where-the-suites-run), [TEST-PLAN.md](../TEST-PLAN.md)).

## How was it developed?

With an AI coding assistant. The code, tests and documentation were written with Claude (Anthropic's model, used through Claude Code), directed by the maintainer, who set the goals, made the design decisions, reviewed the changes and ran the tests on physical devices. Every commit written this way says so in its history (`Co-Authored-By: Claude`); at the time of writing, every commit except the pull-request merges and three automated dependency updates carries it.

Who or what wrote a line says nothing about whether it is correct, so the project relies on checks that do not depend on it:

- changes reach `main` through pull requests (every change since 2026-10-22, except one changelog edit that morning), which CI checks on Linux and Windows (unit tests, type, module-boundary and bundle checks) and, since 2026-10-26, on macOS (now 12 of the 18 browser gates, with their controls; G-bridged-translation runs in the Linux job); the other five gates, the WPT run and the phone suites run on the maintainer's Mac;
- every gate has a positive control (a deliberately broken renderer that must make it fail), and a mutation suite of 94 seeded bugs checks that the gates catch them, so a check that passes vacuously is itself caught;
- fidelity is judged against the plain page and against Chrome's native implementation, and conformance against the official WPT tests;
- the numbers in these docs are measured and dated, including the ones that got worse, and the limits are listed;
- the behaviour was checked on physical devices, not only in simulators.

Defects found this way, by the tests and by people using the polyfill on their own devices, are listed in the CHANGELOG with their fixes. If you find one, please open an issue: a page that reproduces it is the most useful report.

## How can I help or report a bug?

- **Run the field test** on a machine or phone we do not have. It is one page of the demo, takes about six minutes, sends nothing anywhere, and ends with one report file to attach to an issue ([FIELD-TEST.md](FIELD-TEST.md)). Windows PCs and physical iPhones on iOS 26 or later are the most useful.
- **Report a bug** in the [issue tracker](https://github.com/GiuseppeScottoLavina/html-in-canvas-polyfill/issues) with a minimal page, the browser and version, and the output of `JSON.stringify(__HIC__.installed.report(), null, 1)` ([TROUBLESHOOTING.md](TROUBLESHOOTING.md)).
- **Contribute** fixes or tests: see [CONTRIBUTING.md](../../CONTRIBUTING.md).
- **Discuss the API itself** (not this polyfill) in the [WICG proposal repository](https://github.com/WICG/html-in-canvas).
