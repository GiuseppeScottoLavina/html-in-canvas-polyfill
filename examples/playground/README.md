# playground

Edit the WICG explainer example and run it in the browser. [Try it](https://giuseppescottolavina.github.io/html-in-canvas-polyfill/examples/playground/).

Needs: core and engines (`dist/hic-live-polyfill.iife.min.js`, `dist/hic-live-engines.iife.min.js`). The effects and the plugins are not loaded; the [plugin gallery](../plugins/) shows them.

Run locally: `npm run build && npm run demo`, then open `http://127.0.0.1:8765/examples/playground/` in desktop Chrome, Firefox 155+ or Safari 27+.

## What it does

- Left, the code: a plain `<textarea>` with the explainer's "Basic Example" (the same markup and script as [basic](../basic/)). It becomes the body of the preview page. Tab indents by two spaces; Esc then Tab, or Shift+Tab, moves the focus on; Ctrl+Enter or Cmd+Enter runs.
- Right, the preview: a new frame for each run, with the core and engines bundles of this site, then the code. The status line above it says what ran: `polyfill <version> installed (mode polyfill)`, `native API, the polyfill stepped aside (mode native)`, the polyfill's refusal, or a bundle that did not load. The console panel below it shows the preview's uncaught errors, unhandled rejections and `console.error`, `console.warn` and `console.log`.
- Run builds the preview again; Reset restores the explainer example and runs it; Share puts the code in the link (`#code=` followed by the base64url of its UTF-8 bytes), copies the link and says so. Opening such a link fills the editor with that code and runs it. A link is limited to 16,000 encoded characters (about 12 KB of code); a longer code, or a damaged link, is refused with a message and the original example is shown.

## The sandbox

The preview is `<iframe sandbox="allow-scripts">` without `allow-same-origin`, its document built with `srcdoc`. Its origin is opaque, so code from a shared link never runs in the site's origin: it cannot read the site's cookies or storage or reach the page, and it cannot open windows, show dialogs (`alert()` is reported in the console instead) or submit forms. The bundles are loaded by absolute URL from the page's own location.

The polyfill needs nothing more from the origin: it makes no request of its own, uses no worker and no storage, and installs, paints and takes typing in the opaque origin as on a page. One difference: images, fonts and style sheets that the drawn HTML references are read with a CORS request (their origin differs from the opaque one), so their server must allow cross-origin reads. GitHub Pages does.

The frame reports to the page with `postMessage`. The page accepts a message only from the current preview frame and with that run's token, and shows its strings as text, never as HTML.

## A preview that stops responding

The page sends the frame a ping every second; a frame that leaves one unanswered for 3 seconds is reported as not responding. What happens then depends on the browser:

- Chrome runs the sandboxed frame in a process of its own: the editor keeps working. A new frame of the same page lands in that busy process, so Run and Reset reload the page with the code in the editor (kept in the page's session storage across the reload).
- Firefox and Safari run the frame in the page's process: an endless loop freezes the page too, until the browser offers to stop the script. After that, edit the code and run it again.

## Checked by `npm run test:examples`

Headless Chrome: the status line reports the install; an element screenshot of the frame, cropped to the canvas, is not blank; the default code is examples/basic's explainer block character for character and runs with no console message; the frame is sandboxed with `allow-scripts` only, has an opaque origin and cannot reach the page's document; a trusted click on the drawn field focuses the live input and typing changes `input.value` and the preview pixels; a message from another window that carries the run's token is ignored; an error, an unhandled rejection and an HTML string passed to `console.error` reach the console panel as text (Ctrl+Enter runs); Tab and Esc then Tab; a code too long for a link and three damaged links; Share then reload restores code with non-ASCII text; Reset; five runs leave one frame; an endless loop is reported and Reset recovers. Its controls: with a broken `dist/` path the page fails, and four variants of the page (a sandbox with `allow-same-origin`, console text set as HTML, messages heard from any window, the previous frame kept) each turn their check red. `npm run test:pages` checks it on the assembled site.
