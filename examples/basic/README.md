# basic

The WICG HTML-in-Canvas explainer "Basic Example" (a `<canvas content="drawable">` with a `<form drawable>` child, drawn from `onpaint`), unchanged, plus one status line below it that prints the polyfill mode.

Run: `npm run build && npm run demo`, then open `http://127.0.0.1:8765/examples/basic/` in desktop Chrome, Firefox 155+ or Safari 27+.

What to look at: click the drawn field and type. The text you type goes into the real `<input>` (it is live, focusable, at `opacity:0` over the canvas); the canvas shows a fresh snapshot of the form.

Checked by `npm run test:examples`: no console or page error, the canvas is not blank, and typing changes both `input.value` and the canvas pixels. The same markup and script run as the repository fixture `test/fixtures/explainer/index.html`, which the pixel-gated G-explainer compares with a plain-DOM twin (`docs/TEST-PLAN.md`).
