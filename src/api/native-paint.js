/**
 * Paint driving for a native build that fires `paint` only from requestPaint() (part of the native bridge, mode native-bridged).
 * Module: api-core (part of the native bridge).
 *
 * Measured live on Safari Technology Preview 254 (WebKit 22627.1.2.1) with Debug > WebKit Internal Features > HTML-in-Canvas, 2026-10-16:
 *  - no `paint` event at the first rendering of a `layoutsubtree` canvas, none after a child's style, text or children change, none after the canvas grid
 *    or css size changes, none after a field is focused or typed into; exactly one after each requestPaint() (also from rAF and ResizeObserver callbacks);
 *  - drawElementImage draws the child as it was rendered by the PREVIOUS rendering update: a change followed by requestPaint() in the same task, in the next
 *    rAF or in the next ResizeObserver callback is drawn stale, and a child inserted in that task draws nothing.
 * The standard fires `paint` in the rendering update after any change of the drawable content, so the explainer pattern (draw in `onpaint`) drew nothing.
 * The bridge asks for the paint through the public method, one rendering update AFTER the update that rendered the change (two frames, so the draw sees
 * it): when a canvas becomes drawable, and after every change inside it that can alter its rendering (DOM mutations, its size, input, focus, hover,
 * scrolling, the selection, running CSS animations and transitions). A change of the grid size alone (width / height) is requested at once: it clears the
 * bitmap and the children's last rendering is still current. Requests coalesce per frame.
 */

/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */

/** Events inside a drawable that can change its rendering (captured at the window, so stopPropagation in the page does not hide them). */
const CHANGE_EVENTS = Object.freeze(['input', 'change', 'focusin', 'focusout', 'pointerover', 'pointerout', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'scroll']);
const ANIMATION_START = Object.freeze(['transitionrun', 'animationstart']);
const ANIMATION_END = Object.freeze(['transitionend', 'transitioncancel', 'animationend', 'animationcancel']);

/**
 * @param {HicEnv} env
 * @param {(canvas: Element) => boolean} isDrawable  the canvas is still activated by content="drawable"
 * @returns {{watch: (canvas: Element) => void, dispose: () => void}}  watch = a canvas became drawable
 */
export function installPaintDriver(env, isDrawable) {
  const win = /** @type {Window & typeof globalThis} */ (env.window);
  const doc = env.document;
  /** @type {WeakSet<Element>} */
  const watched = new WeakSet();
  /** @type {Map<Element, number>} running animations and transitions per canvas */
  const animating = new Map();
  /** @type {Set<Element>} changed since the last frame (rendered by the next update) */
  let dirty = new Set();
  /** @type {Set<Element>} rendered by the last update: requested in this one */
  let rendered = new Set();
  let frame = 0;

  /** @param {Element} canvas */
  const request = (canvas) => {
    if (!canvas.isConnected || !isDrawable(canvas)) return;
    try { /** @type {any} */ (canvas).requestPaint(); } catch (err) { env.reporter.caught(err, 'bridge.requestPaint'); }
  };
  const pump = () => {
    frame = 0;
    for (const canvas of rendered) request(canvas);
    for (const canvas of animating.keys()) dirty.add(canvas);
    rendered = dirty;
    dirty = new Set();
    if (rendered.size) frame = win.requestAnimationFrame(pump);
  };
  /** @param {Element} canvas */
  const mark = (canvas) => {
    dirty.add(canvas);
    if (!frame) frame = win.requestAnimationFrame(pump);
  };
  /** @param {unknown} node @returns {Element|null} the watched canvas whose drawable content holds `node` */
  const owner = (node) => {
    const el = /** @type {Node|null|undefined} */ (node)?.nodeType === 1 ? /** @type {Element} */ (node) : /** @type {Node|null|undefined} */ (node)?.parentElement;
    const canvas = el?.closest('canvas') ?? null;
    return canvas && watched.has(canvas) ? canvas : null;
  };
  /** @param {Event} e */
  const origin = (e) => owner(e.composedPath()[0]);

  const mutations = new win.MutationObserver((list) => {
    for (const m of list) {
      const canvas = owner(m.target);
      if (!canvas) continue;
      if (m.target === canvas && (m.attributeName === 'width' || m.attributeName === 'height')) request(canvas);
      else mark(canvas);
    }
  });
  const resizes = new win.ResizeObserver((entries) => { for (const e of entries) if (watched.has(e.target)) { request(e.target); mark(e.target); } });

  /** @param {Event} e */
  const onChange = (e) => { const canvas = origin(e); if (canvas) mark(canvas); };
  const onSelection = () => {
    const canvas = owner(doc.activeElement) ?? owner(win.getSelection?.()?.anchorNode);
    if (canvas) mark(canvas);
  };
  /** @param {Event} e */
  const onStart = (e) => { const canvas = origin(e); if (!canvas) return; animating.set(canvas, (animating.get(canvas) ?? 0) + 1); mark(canvas); };
  /** @param {Event} e */
  const onEnd = (e) => {
    const canvas = origin(e);
    if (!canvas || !animating.has(canvas)) return;
    const left = /** @type {number} */ (animating.get(canvas)) - 1;
    if (left > 0) animating.set(canvas, left); else animating.delete(canvas);
    mark(canvas);
  };
  /** @type {Array<[EventTarget, string, (e: Event) => void]>} */
  const listeners = [
    ...CHANGE_EVENTS.map((t) => /** @type {[EventTarget, string, (e: Event) => void]} */ ([win, t, onChange])),
    ...ANIMATION_START.map((t) => /** @type {[EventTarget, string, (e: Event) => void]} */ ([win, t, onStart])),
    ...ANIMATION_END.map((t) => /** @type {[EventTarget, string, (e: Event) => void]} */ ([win, t, onEnd])),
    [doc, 'selectionchange', onSelection],
  ];
  for (const [target, type, fn] of listeners) target.addEventListener(type, fn, true);

  return {
    watch(canvas) {
      if (watched.has(canvas)) return;
      watched.add(canvas);
      mutations.observe(canvas, { subtree: true, childList: true, attributes: true, characterData: true });
      resizes.observe(canvas);
      mark(canvas);
    },
    dispose() {
      for (const [target, type, fn] of listeners) target.removeEventListener(type, fn, true);
      mutations.disconnect();
      resizes.disconnect();
      if (frame) win.cancelAnimationFrame(frame);
      frame = 0;
      animating.clear();
      dirty.clear();
      rendered.clear();
    },
  };
}
