# form

A realistic contact form (two text fields, a textarea, a checkbox, a submit button with validation) that lives inside `<canvas content="drawable">` and is drawn with `ctx.drawElementImage(form, 0, 0)` from the `paint` event.

Run: `npm run build && npm run demo`, then open `http://127.0.0.1:8765/examples/form/` in desktop Chrome.

What to look at:
- The form is real DOM: Tab moves focus, typing goes into the real inputs, the caret and selection are drawn into the canvas, the submit handler is an ordinary `submit` listener.
- The `ResizeObserver` sets `canvas.width/height` to the device-pixel content box (the standard pattern). Resize the window: the form re-flows and the canvas follows.
- Only HTML that stays inside the canvas is drawn. Fonts are the system stack (a web font would have to be same-origin or CORS-enabled; see `docs/guides/TROUBLESHOOTING.md`).

Checked by `npm run test:examples`: no console or page error, the canvas is not blank, and a trusted click on the drawn name field plus typing changes `input.value` and the canvas pixels.
