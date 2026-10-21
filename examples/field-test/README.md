# field-test

Not an example of the API: a guided page that a tester runs on their own machine for about five minutes, ending with one JSON report to send back. Box A of each pair is HTML drawn into a canvas with `drawElementImage` from `onpaint` (the standard pattern of [form](../form/)); box B is the same HTML as a plain page. Where the browser can capture just the current tab (Chrome and Edge on desktop), the two boxes are compared as the screen shows them.

- `index.html`: the steps card, the test boxes, a small script before the polyfill that records the native API and the console messages.
- `field-test.js`: the environment, the steps, the tab capture and its calibration, the pixel comparison, the report and its validator, the self-check.

What it measures, the report schema, the limits per browser and how to ask someone to run it: [docs/guides/FIELD-TEST.md](../../docs/guides/FIELD-TEST.md). End-to-end test: `npm run test:field`.
