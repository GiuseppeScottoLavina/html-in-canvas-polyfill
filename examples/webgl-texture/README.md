# webgl-texture

A spinning WebGL2 cube textured with a live HTML form. The form is a `drawable` child of a `<canvas id="gl" content="drawable">` whose context is WebGL2 (not 2D), so the picture of the form does not come from `drawElementImage` but from one call per `paint` event: `gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, card)`. The same texture is also drawn flat in the top-left corner (a small quad), and the real form sits exactly under that quad.

Run: `npm run build && npm run demo`, then open `http://127.0.0.1:8765/examples/webgl-texture/` in desktop Chrome (WebGL2 is required; the page prints a message instead of failing silently when it is missing).

What to look at:
- Click the flat copy, type in "Your name" and drag the slider: the real inputs receive the input, and the text on the cube changes with the next upload (the status line counts `uploads`).
- On one face the form can look upside down: each cube face maps the texture 0..1 along its own axes (`buildCube()` in `index.html`). This is believed to be the example's cube geometry, not a polyfill defect; it was not investigated further.

What the page demonstrates about the API:
- `texElementSubImage2D` needs storage that already exists, like `texSubImage2D`: the example reads the size with `canvas.getElementImageDefaultSize(card)` (`ceil(width)` x `ceil(height)` in canvas bitmap pixels), allocates with `texImage2D(..., null)` when the size changed, then uploads. Before the first snapshot exists `getElementImageDefaultSize` throws `InvalidStateError`, so the upload runs from the `paint` event.
- A 3D context draws nothing through `drawElementImage`, so the page calls `canvas.updateElementGeometry(card)` once to make the live form hit-testable where the flat copy is drawn (identity transform = the canvas top-left).
- The drawing buffer follows the device pixel size through a `ResizeObserver` on `devicePixelContentBoxSize`, as in the other examples.

Checked by `npm run test:examples`: no console or page error, the canvas is not blank, two frames 500 ms apart differ (the cube spins), and typing into the form changes the input, the text node, the upload counter and the pixels of the flat copy. There is no pixel oracle against a plain-DOM twin for this example (`docs/SUPPORT-MATRIX.md`: texture upload is unit-tested, not pixel-gated).
