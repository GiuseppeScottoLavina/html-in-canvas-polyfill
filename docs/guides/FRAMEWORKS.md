# Using it with React, Vue, Svelte and Lit

This page separates what was **run** from what was only **designed**. Verified means: a real app built with that framework, loaded after `dist/hic-live-polyfill.iife.js`, driven with trusted input in headless Chrome 155.0.8059.85 at DPR 1 by `npm run test:frameworks` (`test/frameworks/run.mjs`), with positive controls that turn red. Versions: React 19.3.1, Vue 3.5.44, Svelte 5.57.2, Lit 3.3.3 (the pins of `test/frameworks/package.json`), all as development builds. The last recorded run is named in section 7.

The four apps are in `examples/frameworks/{react,vue,svelte,lit}/`, each with a README. They draw the same picture: a controlled input, a keyed list with Add / Remove first / Reverse buttons and clickable rows, a conditional second drawable (a badge drawn at (340, 300) while it is laid out at the origin), and a component that re-renders every 500 ms.

## 1. What was verified

| scenario (what the check asserts) | React 19 | Vue 3 | Svelte 5 | Lit 3 (shadow DOM) |
|---|---|---|---|---|
| **oracle**: canvas readback vs a plain-DOM twin of the same app, delta > 16 on <= 3 % of pixels, non-blank (measured: 0.027 %, 0 %, 0 %, 0.027 %) | pass | pass | pass | pass |
| **typing**: a click on the drawn input focuses it; trusted keys update the framework state AND the input and echo pixels | pass | pass | pass | pass |
| **list**: a click on a drawn row runs its handler; Reverse / Add / Remove (drawn buttons) update the state, the live DOM order and the row colours in the canvas; a click on a row then hits the item drawn there | pass | pass | pass | pass |
| **conditional**: the badge is clickable where it is DRAWN, not where it is laid out; unmount removes its pixels and its hit area; remount draws a new element that is clickable; 12 fast toggles end drawn | pass | pass | pass | pass |
| **timer**: a child re-renders every 500 ms; the drawn region changes (8 changes in 3.5 s) | pass | pass | pass | pass |
| **reconcile**: 40 random add / remove / reverse / toggle, 20 ms apart: no error; DOM order equals state order; the children really sit in `<hic-layer>` while `canvas.firstElementChild`, `children` and `child.parentNode` answer the logical tree; the canvas shows the final state | pass | pass | pass | pass |
| **remount**: a sibling rendered after the canvas lands after the layer; the WHOLE canvas unmounted (route-change style) takes its layer with it; a remounted NEW canvas is wired, painted, clickable and typeable; 11 fast unmount / remount cycles leave one canvas and one layer | pass | pass | pass | pass |
| **uninstall** while the timer runs: children return to the canvas, no layer is left, the app keeps re-rendering without errors; `install()` again: the canvas shows the CURRENT state and a drawn row is clickable | pass | pass | pass | pass |
| **hydration**: `hydrateRoot` over `react-dom/server` markup keeps the server node, oracle and typing pass, no hydration error | pass, with `suppressHydrationWarning` on the canvas (section 4) | not run | not run | not applicable |
| **doc-snippets**: the code blocks of section 5, extracted from this file and run as written: non-blank canvas, a click focuses the drawn input, typing changes the canvas | pass | pass | pass | pass |
| **no error**: every scenario fails on any console error, exception or failed request (where a `removeChild` / `insertBefore` `NotFoundError`, a Vue patch error, a Svelte anchor error or a Lit part error would appear) | none | none | none | none (only Lit's own "dev mode" warning) |

Positive controls, all red as required: without the polyfill (its URL answers 404) the oracle, the typing, the list hit-test and the doc snippet fail for every framework (C1); a click at the badge's layout position does not reach it (C2); a twin with the list reversed fails the oracle at 8.3 % (C3); the error collector sees a `NotFoundError` thrown by `removeChild` (C4); React markup that does not match the client produces a hydration error (C5).

Framework mechanics these runs exercised: React's keyed reconciliation (`insertBefore` / `removeChild` on the canvas and on the relocated panel) under StrictMode; Vue's `<!--v-if-->` comment anchor as a direct child of the canvas; Svelte 5 comment anchors, snippets and `bind:this`; Lit's ChildPart marker comments and `repeat()` inside a canvas that lives in an open shadow root.

## 2. What a framework sees

The browser does not lay out the children of a `<canvas>`, so the polyfill moves them into a live layer, an element `<hic-layer>` that is the next sibling of the canvas, at `opacity:0` (ARCHITECTURE ADR-A, `docs/API-CONTRACT.md` section 3). Facades keep the DOM looking unchanged (removed again on unmount or uninstall):

- On the canvas: `childNodes`, `children`, `firstChild`, `lastChild`, `firstElementChild`, `lastElementChild`, `childElementCount`, `hasChildNodes`, `append`, `prepend`, `appendChild`, `insertBefore`, `removeChild`, `replaceChild`, `replaceChildren`, `contains`, `innerHTML`, `textContent` operate on the LOGICAL child list; writes go into the layer. Verified indirectly: all four frameworks inserted, moved and removed children and anchors of the canvas without an error, and the reconcile scenario reads `firstElementChild`, `children` and `parentNode`.
- On the relocated top-level children: `parentNode`, `parentElement`, `previousSibling`, `nextSibling`, `previousElementSibling`, `nextElementSibling` answer as if the child were still inside the canvas.
- On the canvas: `nextSibling` and `nextElementSibling` skip the layer. On the PARENT of the canvas (`options.parentFacade`, default true): `children`, `childNodes`, `childElementCount`, `firstChild`, `lastChild`, `firstElementChild`, `lastElementChild` hide the layer. Verified indirectly: a framework-rendered sibling after the canvas, and a framework-removed and re-inserted canvas, in the same parent.
- `canvas.addEventListener(...)` and `canvas.onclick`-style handlers receive events from the children (with `currentTarget` set to the canvas). Not exercised by the apps: their handlers sit on the children.

The polyfill also WRITES on author elements: `data-hic-canvas` on the canvas at mount, and (after the document's `load` when it mounts during page load) a merged `aria-owns` on the canvas and a generated `id` (`hic-o-<n>-<m>`) on a top-level drawable that has none (`docs/ARCHITECTURE.md` ADR-M). Client-side rendering in all four frameworks ignored them; hydration does not (section 4).

Not hidden (row `tree-identity`, limited; not re-tested here): CSS `:last-child`, `:nth-child`, the `+` combinator, native live collections, `parent.innerHTML` and author `MutationObserver`s on the canvas still see the layer. `canvas.querySelector()` cannot find the children, because they are no longer descendants of the canvas: use framework refs, as the apps do.

## 3. Rules that worked

1. **Load the polyfill first**, as a classic script before the app bundle (or `install()` before the framework's first render). Every run did this.
2. **Attributes as plain strings**: `content="drawable"` on the canvas and `drawable=""` on each drawn element. All four frameworks rendered them; React 19 server rendering prints `drawable=""`.
3. **Wire the canvas for the lifetime of THAT canvas element**, not of the component that happens to render it: a React 19 callback ref with a cleanup function, a Vue `watch` on the template ref, a Svelte `$effect` that reads the `bind:this` variable, a Lit `ref()` callback. The remount scenario replaces the canvas element and passes with these. A React `useEffect(..., [])` in the parent, as the previous version of this page showed, keeps listening to the removed canvas; that variant was not run.
4. **Listen with `addEventListener('paint', ...)`**, not `canvas.onpaint =`: the listener survives `uninstall()` / `install()` (uninstall scenario); an `onpaint` property is forgotten (GETTING-STARTED section 2).
5. **Read the drawables from refs inside the paint handler**, and skip one that is `null` / `undefined`. A conditional drawable (mounted, unmounted, re-created, 12 toggles 30 ms apart) never made `drawElementImage` throw in the handler: the paint gate holds `paint` until the new element has a snapshot (API-CONTRACT 4.2). A conditional around a drawable is therefore fine; keys still matter, because a re-created element loses its focus, caret and scroll offset.
6. **Draw in bitmap pixels**: `const s = canvas.width / canvas.clientWidth; ctx.drawElementImage(el, x * s, y * s)`. Only DPR 1 was run, where `s` is 1.
7. **Clicks follow the drawing**: a drawable drawn somewhere else than its layout position is hit where it is drawn (the badge). A top-level drawable is laid out at the canvas content-box origin, so one drawn at (0, 0) is hit where it is laid out.
8. **Give each top-level drawable an `id`** if the page is server-rendered (section 4).
9. **Let the framework remove the canvas**: its layer goes with it (11 fast cycles). Do not hide, remove or adopt `<hic-layer>`.

## 4. Hydration and server rendering

React 19 `hydrateRoot` over `react-dom/server` markup works: the server-rendered panel node is kept (not re-created by the client), the oracle and the typing scenario pass, handlers are attached. Two KNOWN probes of `npm run test:frameworks` watch the caveats; the first is still reproduced on every run:

- The dev build logs `A tree hydrated but some attributes of the server rendered HTML didn't match the client properties` for the canvas, because the polyfill added `data-hic-canvas` before hydration (`aria-owns` is now written after `load`). `suppressHydrationWarning` on the `<canvas>` silences it (verified). React leaves the attributes in place, which is what the polyfill needs.
- Fixed: a top-level drawable WITHOUT an `id` used to get a generated one before hydration (reported on the child); the id is now generated after `load` (probe `react-hydration-generated-child-id` reports it as no longer reproduced).

Vue `createSSRApp` hydration, SvelteKit hydration and Lit SSR were NOT run. Expect the same attribute differences; whether those frameworks report them is unverified.

## 5. Copy-paste patterns

The four blocks below are extracted from this file by `test/frameworks/build.mjs`, wrapped in the smallest page that mounts them (imports, a mount call, a stylesheet that sizes the canvas and the form to 480 x 320), and run by the `doc-snippets` scenario. The full apps in `examples/frameworks/` are the larger reference.

React 19:

```jsx
function useCanvasPainter(drawables) {              // drawables: [[ref, x, y], ...]
  return useCallback((canvas) => {                  // React 19 callback ref with a cleanup function
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    const onPaint = () => {
      ctx.reset();
      const s = canvas.width / canvas.clientWidth;
      for (const [ref, x, y] of drawables) if (ref.current) ctx.drawElementImage(ref.current, x * s, y * s);
    };
    canvas.addEventListener('paint', onPaint);
    const ro = new ResizeObserver(([e]) => { const b = e.devicePixelContentBoxSize[0]; canvas.width = b.inlineSize; canvas.height = b.blockSize; });
    ro.observe(canvas, { box: 'device-pixel-content-box' });
    return () => { ro.disconnect(); canvas.removeEventListener('paint', onPaint); };
  }, []);
}

function Form() {
  const formRef = useRef(null);
  const canvasRef = useCanvasPainter([[formRef, 0, 0]]);
  const [name, setName] = useState('');
  return (
    <canvas ref={canvasRef} content="drawable" suppressHydrationWarning>
      <form id="form" ref={formRef} drawable="">
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </form>
    </canvas>
  );
}
```

Vue 3 (the body of `setup()`, or of `<script setup>`; the template is the last line):

```js
const canvas = ref(null), form = ref(null), name = ref('');
watch(canvas, (c, _old, onCleanup) => {
  if (!c) return;                                    // runs again when v-if re-creates the canvas
  const ctx = c.getContext('2d');
  const onPaint = () => { ctx.reset(); if (form.value) ctx.drawElementImage(form.value, 0, 0); };
  c.addEventListener('paint', onPaint);
  const ro = new ResizeObserver(([e]) => { const b = e.devicePixelContentBoxSize[0]; c.width = b.inlineSize; c.height = b.blockSize; });
  ro.observe(c, { box: 'device-pixel-content-box' });
  onCleanup(() => { ro.disconnect(); c.removeEventListener('paint', onPaint); });
}, { flush: 'post' });
// template: <canvas ref="canvas" content="drawable"><form id="form" ref="form" drawable=""><input v-model="name"></form></canvas>
```

Svelte 5:

```svelte
<script>
  let canvas = $state(), form = $state(), name = $state('');
  $effect(() => {
    if (!canvas) return;                             // runs again when {#if} re-creates the canvas
    const c = canvas, ctx = c.getContext('2d');
    const onPaint = () => { ctx.reset(); if (form) ctx.drawElementImage(form, 0, 0); };
    c.addEventListener('paint', onPaint);
    const ro = new ResizeObserver(([e]) => { const b = e.devicePixelContentBoxSize[0]; c.width = b.inlineSize; c.height = b.blockSize; });
    ro.observe(c, { box: 'device-pixel-content-box' });
    return () => { ro.disconnect(); c.removeEventListener('paint', onPaint); };
  });
</script>

<canvas bind:this={canvas} content="drawable"><form id="form" bind:this={form} drawable=""><input bind:value={name}></form></canvas>
```

Lit 3 (members of a `LitElement` subclass with `static properties = { name: { state: true } }`; the canvas is in its open shadow root):

```js
formRef = createRef();
onCanvas = (canvas) => {                             // a stable callback: ref() calls it with the element, then with undefined
  this.unwire?.(); this.unwire = null;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const onPaint = () => { ctx.reset(); if (this.formRef.value) ctx.drawElementImage(this.formRef.value, 0, 0); };
  canvas.addEventListener('paint', onPaint);
  const ro = new ResizeObserver(([e]) => { const b = e.devicePixelContentBoxSize[0]; canvas.width = b.inlineSize; canvas.height = b.blockSize; });
  ro.observe(canvas, { box: 'device-pixel-content-box' });
  this.unwire = () => { ro.disconnect(); canvas.removeEventListener('paint', onPaint); };
};
render() {
  return html`<canvas content="drawable" ${ref(this.onCanvas)}>
    <form id="form" drawable="" ${ref(this.formRef)}><input .value=${this.name ?? ''} @input=${(e) => { this.name = e.target.value; }}></form>
  </canvas>`;
}
```

## 6. Not verified

- DPR 2 or fractional DPR, headed Chrome, a real display refresh rate, other Chromium browsers: only headless Chrome at DPR 1 ran (154 until 2026-10-09, 155 since).
- Production builds (React, Vue and Svelte ran as development builds, Lit in dev mode), and performance of any kind: no timing was measured.
- Vue, Svelte and Lit server rendering and hydration; React Server Components and streaming SSR.
- A framework that MOVES the canvas (a keyed reorder of the list that contains the canvas), portals into a canvas, a framework-rendered drawable nested inside another drawable, text nodes as direct canvas children, toggling `content` from a framework.
- Event delegation on the canvas itself (`canvas.onclick` receiving events of its children).
- Other frameworks (Preact, Solid, Angular, Qwik, htmx).

## 7. Running the tests and reporting

```sh
npm run build
(cd test/frameworks && npm install)          # React, Vue, Svelte, Lit: test-only deps; the root package keeps zero runtime deps
npm run test:frameworks                      # [--only=react,vue] [--no-control]; headless Chrome; .scratch/results/frameworks-<ts>.json + PNGs
```

Last recorded run: 2026-10-26, headless Chrome 155.0.8059.85, DPR 1, with the versions above: 37 scenario runs with 202 checks and 22 controls, all green, 4 min 5 s (the run of 2026-10-22 gave the same counts). Of the two KNOWN hydration probes of section 4, the canvas attributes are still reported and the generated child id is no longer reproduced. (The run of 2026-10-09 on Chrome 154.0.8037.98 gave the same counts.)

If something breaks in your app, run `__HIC__.installed.report()` and note which facade or selector was involved; a minimal repro in the style of `examples/frameworks/` is the most useful bug report.
