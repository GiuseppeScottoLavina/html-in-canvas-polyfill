# scroll-and-resize

One canvas holding a scrolling inbox (60 rows, sticky header, `:hover` colours, checkboxes) next to a responsive panel (flex-wrap cards, a text field). A media query at 760 px switches the panel to one column.

Run: `npm run build && npm run demo`, then open `http://127.0.0.1:8765/examples/scroll-and-resize/` in desktop Chrome, Firefox 155+ or Safari 27+.

What to look at:
- Scroll the list with the mouse wheel, a trackpad or the keyboard: the scrolling is the browser's own on the live list, the canvas shows the result. In Chrome and Safari (also on iOS) each scroll step is drawn from cached pages of the list and the exact picture follows when the scroll stops; Firefox rebuilds this list at every step (it composes only at a device pixel ratio of 1, only a scroller with square corners and only content without rounded corners or form controls; this list is rounded and its rows hold checkboxes).
- Drag the window narrower than 760 px and back. The readout under the canvas prints the window width, the canvas bitmap size and the list `scrollTop`.
- The `ResizeObserver` writes `canvas.width/height` on every size change; the polyfill repaints in the same frame (`docs/API-CONTRACT.md` section 8). A real-window-drag gate (G-resize-drag, F3 fixture) checks for 0 blank frames after the first paint, and a scroll gate (G-scroll-inner, F2 fixture) checks inner scrolling (`docs/TEST-PLAN.md`).

Limits shown here, stated in `docs/SUPPORT-MATRIX.md`: during a drag the canvas shows pixels from 1 to 3 frames earlier stretched into the new box, so a click can land on the new layout while the pixels still show the old one (API-CONTRACT section 8). Classic scrollbars are painted by the polyfill in the platform's look, without their hover and pressed states (row `classic-scrollbars`).

Checked by `npm run test:examples`: no console or page error, the canvas is not blank, a trusted wheel gesture over the list scrolls it and changes the canvas pixels, and after a viewport resize across 760 px the canvas is not blank and shows the other layout.
