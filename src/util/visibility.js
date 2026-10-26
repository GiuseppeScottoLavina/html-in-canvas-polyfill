/**
 * Can the user see a canvas? The effect host pauses its rendering while the answer is no (docs/ARCHITECTURE.md ADR-G, off-screen pause), and so do animated images (schedule/observers/animated-images.js).
 * Module: util.
 */

/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */

/**
 * How far outside the viewport (and outside the clip of every scroll container around the canvas) the canvas already counts as visible:
 * half the viewport (half the scroll container) on each side. An IntersectionObserver reports a change one frame late and the host renders
 * on the frame after, so the margin must cover two frames of scrolling: half a viewport is far more than a wheel notch, a fling or a
 * smooth Page Down travels in two frames, so the canvas is already rendering when it scrolls in.
 * Given as `scrollMargin` where the engine has it (Chrome 120+), else as `rootMargin`. Not both: Chrome applies `scrollMargin` to the
 * document's own scroller too, so the two would add up on the viewport (measured, Chrome 155: rootMargin and scrollMargin '50%' together
 * kept a canvas 0.7 viewport heights below the viewport visible), while `rootMargin` alone does not reach nested scroll containers.
 */
export const VISIBILITY_MARGIN = '50%';

/**
 * @typedef {Object} VisibilityWatch
 * @property {boolean} visible  the canvas (with the margin) intersects the viewport and the document is not hidden
 * @property {() => void} dispose
 */

/**
 * Watch whether `canvas` can be seen: an IntersectionObserver with the margin VISIBILITY_MARGIN, and the document's visibility. The canvas
 * counts as visible until the observer's first report, and always where IntersectionObserver is missing (no pause then). `onChange(visible)`
 * is called on every change, never for the initial state.
 * JUMPS: the observer reports a frame late, which the margin hides for any scroll that moves, but not for a jump (scrollTo, an anchor, a
 * scrollbar click) that lands the canvas in view at once. While the canvas is out of view a passive capture `scroll` listener on the
 * document compares the canvas box with the viewport (plus the margin) at each scroll event: scroll events are dispatched in the rendering
 * update before the animation frame callbacks, so a change reported there is rendered in that same frame. It reports the canvas visible
 * when its box moves from outside to inside that area, and observes the canvas again so that the observer's next report (which, unlike
 * the box test, accounts for the clip of scroll containers) settles the state.
 * @param {HicEnv} env
 * @param {Element} canvas
 * @param {(visible: boolean) => void} onChange
 * @returns {VisibilityWatch}
 */
export function watchVisibility(env, canvas, onChange) {
  const doc = canvas.ownerDocument;
  const win = /** @type {any} */ (env.window);
  const IO = win.IntersectionObserver;
  let intersecting = true;
  let shown = doc.visibilityState !== 'hidden';
  let visible = intersecting && shown;
  let disposed = false;
  const update = () => {
    const next = intersecting && shown;
    if (next === visible || disposed) return;
    visible = next;
    onChange(visible);
  };
  /** @type {IntersectionObserver|null} */
  let observer = null;
  /** the canvas box was inside the viewport plus the margin at the last check */
  let boxInside = true;
  let listening = false;
  /** @param {{top: number, bottom: number, left: number, right: number, width: number, height: number}} r */
  const inside = (r) => {
    const h = win.innerHeight / 2, w = win.innerWidth / 2;
    return r.width > 0 && r.height > 0 && r.bottom > -h && r.top < win.innerHeight + h && r.right > -w && r.left < win.innerWidth + w;
  };
  const onScroll = () => {
    const was = boxInside;
    boxInside = inside(canvas.getBoundingClientRect());
    if (was || !boxInside || intersecting || !observer) return;
    intersecting = true;
    listen(false);
    observer.unobserve(canvas);
    observer.observe(canvas);
    update();
  };
  /** @param {boolean} on */
  const listen = (on) => {
    if (on === listening) return;
    listening = on;
    if (on) doc.addEventListener('scroll', onScroll, { capture: true, passive: true });
    else doc.removeEventListener('scroll', onScroll, { capture: true });
  };
  if (typeof IO === 'function') {
    const callback = (/** @type {IntersectionObserverEntry[]} */ entries) => {
      // the newest entry is the current state (a frame can queue more than one)
      const last = entries[entries.length - 1];
      if (!last || disposed) return;
      intersecting = last.isIntersecting;
      boxInside = inside(last.boundingClientRect);
      listen(!intersecting);
      update();
    };
    const margin = 'scrollMargin' in IO.prototype ? { scrollMargin: VISIBILITY_MARGIN } : { rootMargin: VISIBILITY_MARGIN };
    observer = /** @type {IntersectionObserver} */ (new IO(callback, { ...margin, threshold: 0 }));
    observer.observe(canvas);
  }
  const onVisibility = () => { shown = doc.visibilityState !== 'hidden'; update(); };
  doc.addEventListener('visibilitychange', onVisibility);
  return {
    get visible() { return visible; },
    dispose() {
      if (disposed) return;
      disposed = true;
      observer?.disconnect();
      listen(false);
      doc.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
