/**
 * `ResizeObserver` with `box: 'device-pixel-content-box'` where the engine lacks it (Safari 27: `observe()` throws TypeError and entries have no
 * `devicePixelContentBoxSize`). The explainer sizes the canvas grid exactly this way, so without it the canonical example throws on its first line.
 * Feature-detected: nothing is patched where the box is supported (Chromium, Firefox). Patches go through the ledger and are removed by uninstall().
 * The size is contentBoxSize x devicePixelRatio, rounded: exact for a box on whole device pixels; a box at a fractional device offset may differ by 1 px from a
 * native snapped size. A devicePixelRatio change alone does not re-fire the observer (feature row resize-observer-dpcb).
 * Module: api-surface (src/api/*).
 */

/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../contracts/types.js').PatchLedger} PatchLedger */

const BOX = 'device-pixel-content-box';

/** @param {any} win @returns {boolean} the engine accepts the box and exposes the entry member */
export function supportsDevicePixelBox(win) {
  const RO = win.ResizeObserver, Entry = win.ResizeObserverEntry;
  if (typeof RO !== 'function') return true; // nothing to complete
  if (Entry && !('devicePixelContentBoxSize' in Entry.prototype)) return false;
  try {
    const ro = new RO(() => {});
    ro.observe(win.document.createElement('div'), { box: BOX });
    ro.disconnect();
    return true;
  } catch { return false; }
}

/**
 * @param {HicEnv} env
 * @param {PatchLedger} ledger
 */
export function installDevicePixelBox(env, ledger) {
  const win = /** @type {any} */ (env.window);
  if (supportsDevicePixelBox(win)) return;
  const proto = win.ResizeObserver.prototype;
  const observe = proto.observe;
  ledger.define(proto, 'observe', {
    value: /** @this {ResizeObserver} */ function observe$(/** @type {Element} */ target, /** @type {ResizeObserverOptions|undefined} */ options) {
      const fixed = options && options.box === BOX ? { ...options, box: 'content-box' } : options;
      return fixed === undefined ? observe.call(this, target) : observe.call(this, target, fixed);
    },
    writable: true, configurable: true, enumerable: true,
  });
  const Entry = win.ResizeObserverEntry;
  if (Entry && !('devicePixelContentBoxSize' in Entry.prototype)) {
    ledger.define(Entry.prototype, 'devicePixelContentBoxSize', {
      get: /** @this {ResizeObserverEntry} */ function devicePixelContentBoxSize() {
        const dpr = win.devicePixelRatio || 1;
        const css = this.contentBoxSize?.[0] ?? { inlineSize: this.contentRect.width, blockSize: this.contentRect.height };
        return Object.freeze([Object.freeze({ inlineSize: Math.round(css.inlineSize * dpr), blockSize: Math.round(css.blockSize * dpr) })]);
      },
      configurable: true, enumerable: true,
    });
  }
}
