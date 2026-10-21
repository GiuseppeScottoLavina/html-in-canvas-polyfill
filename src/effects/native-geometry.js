/**
 * Native mode: where the browser hit-tests the source of an effect host, through the standard `canvas.updateElementGeometry`.
 * Module: gpu-effects (src/effects/**).
 *
 * Measured on Chrome Canary 158 with CanvasDrawElement (docs/guides/EFFECTS-PLUGINS.md, "On a native implementation"):
 * - `GPUQueue.drawElementImageToTexture` does not make the element hit-testable; `updateElementGeometry(source, {canvasTransform})` does,
 *   immediately and synchronously (about 0.08 ms per call), without a paint event. The transform maps the border box of the source to
 *   the canvas content box in css px.
 * - Native `:hover`, `:active`, the cursor, focus on press, caret placement, text selection and the slider drag all follow that geometry.
 * - `document.elementFromPoint` (one element) keeps a per-point cache that a geometry change does not clear: it can answer for the old
 *   geometry. `document.elementsFromPoint` (a list) is never cached.
 * - Hover is recomputed on a pointer event, after a layout, and not after a geometry change alone. A layout of one tiny element of our own
 *   (HoverSync) makes the engine recompute hover and the cursor in the next frame and dispatch the boundary events (pointerover/out,
 *   mouseover/out); it dispatches no pointermove.
 */

/** @typedef {{left: number, top: number, width: number, height: number, scale: number}} ContentBox */

/**
 * The content box of a canvas in viewport css px, and the factor of a css transform on it (1 without one). The effect fills this box.
 * @param {HTMLCanvasElement} canvas
 * @returns {ContentBox}
 */
export function contentBoxOf(canvas) {
  const r = canvas.getBoundingClientRect();
  const view = /** @type {Window & typeof globalThis} */ (canvas.ownerDocument.defaultView);
  const cs = view.getComputedStyle(canvas);
  const px = (/** @type {string} */ v) => parseFloat(v) || 0;
  const scale = canvas.offsetWidth > 0 && r.width > 0 ? r.width / canvas.offsetWidth : 1;
  const left = px(cs.borderLeftWidth) + px(cs.paddingLeft);
  const top = px(cs.borderTopWidth) + px(cs.paddingTop);
  const width = Math.max(0, canvas.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight));
  const height = Math.max(0, canvas.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom));
  return { left: r.left + left * scale, top: r.top + top * scale, width, height, scale };
}

/**
 * @typedef {Object} NativeGeometry
 * @property {(x: number, y: number) => void} setFill  the stretch of the source over the canvas (canvas css px per source css px)
 * @property {(dx: number, dy: number) => boolean} setOffset  shift the hit-test geometry by (dx, dy) canvas css px; true when it changed
 * @property {() => boolean} park  take the source out of hit testing (a NO_TARGET point); true when it changed
 * @property {() => boolean} reset  the plain stretch, no offset; true when it changed
 * @property {() => void} dispose  clearElementGeometry: the source is no longer hit-tested at all
 */

/**
 * The hit-test geometry of one source: canvasTransform = translate(offset) * scale(fill). A point p of the canvas then hits the source point
 * (p - offset) / fill; the interposer sets offset = p - m so that the pointer at p hits what the effect shows there (the source point m / fill).
 * @param {HTMLCanvasElement} canvas
 * @param {Element} source
 * @returns {NativeGeometry}
 */
export function createNativeGeometry(canvas, source) {
  const c = /** @type {any} */ (canvas);
  let fx = 1, fy = 1, dx = 0, dy = 0;
  let parked = false;
  let applied = false;
  const apply = () => {
    c.updateElementGeometry(source, { canvasTransform: { a: fx, b: 0, c: 0, d: fy, e: dx, f: dy } });
    applied = true;
  };
  return {
    setFill(x, y) {
      if (applied && x === fx && y === fy) return;
      fx = x;
      fy = y;
      if (!parked) apply();
    },
    setOffset(x, y) {
      if (applied && !parked && x === dx && y === dy) return false;
      dx = x;
      dy = y;
      parked = false;
      apply();
      return true;
    },
    park() {
      if (parked) return false;
      parked = true;
      applied = false;
      c.clearElementGeometry(source);
      return true;
    },
    reset() {
      return this.setOffset(0, 0);
    },
    dispose() {
      applied = false;
      try { c.clearElementGeometry(source); } catch { /* the source left the canvas */ }
    },
  };
}

/**
 * @typedef {Object} HoverSync
 * @property {() => void} poke  have the engine recompute hover and the cursor at the pointer in the next frame (one layout of a 0 x 0 element)
 * @property {() => void} dispose
 */

/**
 * One inert element of our own, appended to the root element on first use (outside the body, so that page layouts and selectors of the
 * body do not see it): fixed, 0 x 0, invisible, contained. Toggling its width between 0 and 1 px is a layout that changes nothing visible.
 * @param {Document} doc
 * @returns {HoverSync}
 */
export function createHoverSync(doc) {
  /** @type {HTMLElement|null} */
  let el = null;
  let on = false;
  return {
    poke() {
      if (!el) {
        el = doc.createElement('hic-hover-sync');
        el.setAttribute('aria-hidden', 'true');
        el.style.cssText = 'display:block;position:fixed;left:0;top:0;width:0;height:0;margin:0;padding:0;border:0;overflow:hidden;visibility:hidden;pointer-events:none;contain:strict';
      }
      if (!el.isConnected) doc.documentElement.appendChild(el);
      on = !on;
      el.style.width = on ? '1px' : '0px';
    },
    dispose() {
      el?.remove();
      el = null;
    },
  };
}
