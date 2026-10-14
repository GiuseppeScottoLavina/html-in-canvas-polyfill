/**
 * Paints an optimistic text overlay (TextOverlayPlan, snapshot/capture/text-overlay.js) into a retained surface. The tile that later captures the same value replaces it.
 * Module: snapshot-store (src/snapshot/store/*).
 */

/** @typedef {import('../../contracts/types.js').Rect} Rect */
/** @typedef {import('../../contracts/types.js').TextOverlayPlan} TextOverlayPlan */
/** @typedef {import('./pump.js').Geometry} Geometry */
/** @typedef {HTMLCanvasElement|OffscreenCanvas} Surface */

/**
 * The content box in surface pixels, snapped to whole pixels (a fractional clip would blend the refilled box with the old pixels at its edges).
 * @param {TextOverlayPlan} plan @param {Geometry} geo @returns {Rect|null}
 */
export function overlayRectPx(plan, geo) {
  const s = geo.scale;
  const x0 = Math.max(0, Math.round((plan.box.x + geo.ink.left) * s));
  const y0 = Math.max(0, Math.round((plan.box.y + geo.ink.top) * s));
  const x1 = Math.min(geo.widthPx, Math.round((plan.box.x + plan.box.width + geo.ink.left) * s));
  const y1 = Math.min(geo.heightPx, Math.round((plan.box.y + plan.box.height + geo.ink.top) * s));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/**
 * Refill the field's content box with its backdrop (the plan's solid colour, else `backdrop`: pixels of overlayRectPx size) and draw the value. false when nothing was drawn
 * (no context, empty box, no backdrop for a non-solid plan).
 * @param {Surface} surface @param {Geometry} geo @param {TextOverlayPlan} plan @param {Surface|null} [backdrop] @returns {boolean}
 */
export function paintTextOverlay(surface, geo, plan, backdrop = null) {
  const ctx = /** @type {CanvasRenderingContext2D|null} */ (surface.getContext('2d'));
  const r = overlayRectPx(plan, geo);
  if (!ctx || ctx.isContextLost?.() || !r || (plan.fill === null && (!backdrop || backdrop.width < r.width || backdrop.height < r.height))) return false;
  const s = geo.scale;
  ctx.save();
  try {
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.width, r.height);
    ctx.clip();
    ctx.globalCompositeOperation = 'copy';
    if (plan.fill === null) ctx.drawImage(/** @type {Surface} */ (backdrop), 0, 0, r.width, r.height, r.x, r.y, r.width, r.height);
    else {
      ctx.fillStyle = plan.fill;
      ctx.fillRect(r.x, r.y, r.width, r.height);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.setTransform(s, 0, 0, s, geo.ink.left * s, geo.ink.top * s);
    ctx.font = plan.font;
    ctx.letterSpacing = /** @type {any} */ (plan.letterSpacing);
    ctx.wordSpacing = /** @type {any} */ (plan.wordSpacing);
    ctx.fontKerning = plan.kerning;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.direction = 'ltr';
    ctx.fillStyle = plan.color;
    ctx.fillText(plan.text, plan.x, plan.baseline);
  } finally {
    ctx.restore();
  }
  return true;
}

/**
 * @typedef {Object} BackdropDeps
 * @property {(control: Element, rectCss: import('../../contracts/types.js').Rect, geo: Geometry) => string|null} capture  data: URL of the drawable crop with the field's text transparent, null when it failed
 * @property {(url: string) => Promise<HTMLImageElement>} decode
 * @property {(w: number, h: number) => Surface} canvas
 * @property {() => void} landed  a backdrop arrived: the overlay that waited for it can be painted
 * @property {(run: () => void) => void} schedule  run the build later, in the post-frame pump (never inside the rendering update)
 */

/**
 * Backdrop tiles of the optimistic overlay, one per field: the drawable cropped to the field's content box (whole surface pixels) with the text transparent. Built once, kept until
 * the key (obstruction epoch + geometry + box) changes. `get` answers the pixels when they match the key, else starts a build (at most one in flight per field) and answers null.
 * @param {BackdropDeps} deps
 */
export function createBackdropCache(deps) {
  /** @type {WeakMap<Element, {key: string, pad: Surface|null, pending: boolean}>} */
  const cache = new WeakMap();
  let pending = 0;
  return {
    /** @param {Element} control @param {TextOverlayPlan} plan @param {Geometry} geo @param {number} epoch @returns {Surface|null} */
    get(control, plan, geo, epoch) {
      const r = overlayRectPx(plan, geo);
      if (!r) return null;
      const key = `${epoch}|${geo.scale}|${geo.ink.left}|${geo.ink.top}|${r.x}|${r.y}|${r.width}|${r.height}`;
      const known = cache.get(control);
      if (known?.key === key) return known.pad;
      if (known?.pending) return null;
      const slot = { key, pad: /** @type {Surface|null} */ (null), pending: true };
      cache.set(control, slot);
      const s = geo.scale;
      pending++;
      const done = () => {
        slot.pending = false;
        pending--;
        if (cache.get(control) === slot && slot.pad) deps.landed();
      };
      deps.schedule(() => {
        const url = cache.get(control) === slot ? deps.capture(control, { x: r.x / s - geo.ink.left, y: r.y / s - geo.ink.top, width: r.width / s, height: r.height / s }, geo) : null;
        if (!url) { done(); return; }
        deps.decode(url).then((img) => {
          const pad = deps.canvas(r.width, r.height);
          /** @type {CanvasRenderingContext2D} */ (pad.getContext('2d')).drawImage(img, 0, 0, r.width, r.height);
          img.src = '';
          slot.pad = pad;
        }, () => {}).finally(done);
      });
      return null;
    },
    /** @returns {boolean} a backdrop build is queued or decoding */
    busy: () => pending > 0,
  };
}
