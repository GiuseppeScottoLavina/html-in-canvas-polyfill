/**
 * Mode native-bridged: aliases over a LEGACY or nearly complete native implementation (never replaces the native renderer). Optional: without
 * this bundle such an implementation is used as found (mode native, report().deviations native-step-aside).
 * Module: api-core. Implemented.
 *
 *  - legacy shape (no `content`): `content` IDL + attribute mirroring to `layoutsubtree`, and the translations of native-geometry.js;
 *  - every shape: gap-fill of the ADDITIVE names that are missing (NativeState.gaps), each one built from public native API only.
 */

import { EVENTS } from '../contracts/events.js';
import { ElementGeometryUpdateEvent, getEventHandler, setEventHandler } from './paint-event.js';
import { installLegacyTranslation } from './native-geometry.js';

/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../contracts/types.js').NativeState} NativeState */
/** @typedef {import('../contracts/types.js').PatchLedger} PatchLedger */

/**
 * @param {unknown} extent GPUExtent3D: [w, h?, d?] or {width, height?, depthOrArrayLayers?}
 * @returns {{width: number, height: number}}
 */
function extentSize(extent) {
  if (Array.isArray(extent)) return { width: extent[0], height: extent[1] ?? 1 };
  const e = /** @type {{width: number, height?: number}} */ (extent);
  return { width: e.width, height: e.height ?? 1 };
}

/** @param {Record<string, unknown>} o @returns {Record<string, unknown>} the dictionary without undefined members (WebIDL treats them as missing anyway; this keeps what a native build sees minimal) */
function defined(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

/**
 * drawElementImageToTexture(source, destination) -> copyElementImageToTexture(source, destination) (API-CONTRACT 5.4 and 2.1).
 * @param {any} source  {source, sourceX, sourceY, sourceWidth, sourceHeight}
 * @param {any} destination  {texture, size, origin, colorSpace, premultipliedAlpha}
 * @returns {[object, object]}
 */
export function toLegacyGpuArgs(source, destination) {
  const { texture, size, ...rest } = destination;
  const { width, height } = extentSize(size);
  return [
    defined({ source: source.source, sx: source.sourceX, sy: source.sourceY, swidth: source.sourceWidth, sheight: source.sourceHeight }),
    defined({ destination: defined({ texture, ...rest }), width, height }),
  ];
}

/**
 * The inverse mapping, for a native build that has only the current name and a legacy caller.
 * @param {any} source  {source, sx, sy, swidth, sheight}
 * @param {any} target  {destination: {texture, ...}, width, height}
 * @returns {[object, object]}
 */
export function fromLegacyGpuArgs(source, target) {
  const { destination, width, height } = target;
  return [
    defined({ source: source.source, sourceX: source.sx, sourceY: source.sy, sourceWidth: source.swidth, sourceHeight: source.sheight }),
    defined({ ...destination, size: [width, height] }),
  ];
}

/**
 * `content` <-> `layoutsubtree`: the attribute is mirrored synchronously by the IDL setter and the attribute methods, and asynchronously (MutationObserver)
 * for parser-created and cloned canvases. The polyfill only removes a `layoutsubtree` attribute that it added itself.
 * @param {HicEnv} env
 * @param {PatchLedger} ledger
 */
function installContentMirror(env, ledger) {
  const win = /** @type {Window & typeof globalThis} */ (env.window);
  const mirrored = new WeakSet();
  /** @type {Set<WeakRef<Element>>} the canvases whose attribute this bridge wrote, so uninstall can take it back */
  const written = new Set();
  /** @param {Element} canvas */
  const isDrawable = (canvas) => (canvas.getAttribute('content') ?? '').toLowerCase() === 'drawable';

  /** @param {Element} canvas */
  function mirror(canvas) {
    if (isDrawable(canvas)) {
      if (canvas.hasAttribute('layoutsubtree')) return;
      canvas.setAttribute('layoutsubtree', '');
      mirrored.add(canvas);
      written.add(new WeakRef(canvas));
    } else if (mirrored.has(canvas)) {
      mirrored.delete(canvas);
      canvas.removeAttribute('layoutsubtree');
    }
  }

  const accessor = Object.getOwnPropertyDescriptor({
    get content() { return isDrawable(/** @type {Element} */ (/** @type {unknown} */ (this))) ? 'drawable' : 'fallback'; },
    set content(v) { /** @type {Element} */ (/** @type {unknown} */ (this)).setAttribute('content', String(v)); },
  }, 'content');
  ledger.define(win.HTMLCanvasElement.prototype, 'content', { ...accessor, enumerable: true, configurable: true });

  for (const key of /** @type {const} */ (['setAttribute', 'removeAttribute', 'toggleAttribute'])) {
    ledger.wrap(win.Element.prototype, key, (orig) => /** @this {Element} */ function (/** @type {unknown[]} */ ...args) {
      const result = orig.apply(this, args);
      if (this.localName === 'canvas' && String(args[0]).toLowerCase() === 'content') mirror(this);
      return result;
    });
  }

  /** @param {ParentNode} root */
  const scan = (root) => { for (const c of root.querySelectorAll('canvas[content]')) mirror(c); };
  const observer = new win.MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'attributes') mirror(/** @type {Element} */ (m.target));
      else for (const n of m.addedNodes) if (n.nodeType === 1) { if (/** @type {Element} */ (n).localName === 'canvas') mirror(/** @type {Element} */ (n)); scan(/** @type {Element} */ (n)); }
    }
  });
  /** @param {Document|ShadowRoot} root */
  const watch = (root) => {
    observer.observe(root, { attributes: true, attributeFilter: ['content'], childList: true, subtree: true });
    scan(root);
  };
  watch(env.document);

  return {
    isDrawable, watch,
    dispose() {
      observer.disconnect();
      for (const ref of written) { const canvas = ref.deref(); if (canvas && mirrored.has(canvas)) canvas.removeAttribute('layoutsubtree'); }
      written.clear();
    },
  };
}

/**
 * Names missing from an otherwise working native build, built from what that build does have.
 * @param {HicEnv} env
 * @param {NativeState} native
 * @param {PatchLedger} ledger
 */
function fillGaps(env, native, ledger) {
  const win = /** @type {Window & typeof globalThis} */ (env.window);
  const gaps = new Set(native.gaps);
  const present = new Set(native.present);

  if (gaps.has('ElementGeometryUpdateEvent')) {
    ledger.define(win, 'ElementGeometryUpdateEvent', { value: ElementGeometryUpdateEvent, writable: true, configurable: true, enumerable: false });
  }
  if (gaps.has('onelementgeometryupdate')) {
    const accessor = Object.getOwnPropertyDescriptor({
      get onelementgeometryupdate() { return getEventHandler(env, /** @type {HTMLElement} */ (/** @type {unknown} */ (this)), EVENTS.ELEMENT_GEOMETRY_UPDATE); },
      set onelementgeometryupdate(v) { setEventHandler(env, /** @type {HTMLElement} */ (/** @type {unknown} */ (this)), EVENTS.ELEMENT_GEOMETRY_UPDATE, v); },
    }, 'onelementgeometryupdate');
    ledger.define(win.HTMLCanvasElement.prototype, 'onelementgeometryupdate', { ...accessor, enumerable: true, configurable: true });
  }
  if (gaps.has('getElementImageDefaultSize') && present.has('ElementImage.width')) {
    // the 2026-10-08 size getter over the earlier ElementImage.width/height (a capture for an Element); the originating canvas of an ElementImage is not checked
    ledger.define(win.HTMLCanvasElement.prototype, 'getElementImageDefaultSize', { value: /** @this {any} */ function getElementImageDefaultSize(/** @type {any} */ element) {
      if (arguments.length < 1) throw new TypeError("Failed to execute 'getElementImageDefaultSize': 1 argument required, but only 0 present.");
      return nativeDefaultSize(null, element, this);
    }, writable: true, configurable: true, enumerable: true });
  }
  for (const cls of /** @type {const} */ (['WebGLRenderingContext', 'WebGL2RenderingContext'])) {
    if (gaps.has(`${cls}.texElementSubImage2D`)) fillTexSubImage(env, cls, present.has(`${cls}.texElementImage2D`), ledger);
  }
  const queue = /** @type {any} */ (win).GPUQueue?.prototype;
  if (queue && gaps.has('GPUQueue.drawElementImageToTexture') && present.has('GPUQueue.copyElementImageToTexture')) {
    ledger.define(queue, 'drawElementImageToTexture', { value: /** @this {any} */ function drawElementImageToTexture(/** @type {any} */ source, /** @type {any} */ destination) {
      return this.copyElementImageToTexture(...toLegacyGpuArgs(source, destination));
    }, writable: true, configurable: true, enumerable: true });
  } else if (gaps.has('GPUQueue.drawElementImageToTexture')) {
    env.reporter.unsupported({ feature: 'webgpu-draw-element', message: 'GPUQueue.drawElementImageToTexture is missing from this native build and has no legacy name to be built from' });
  }
  if (queue && env.options.legacyNames && present.has('GPUQueue.drawElementImageToTexture') && !present.has('GPUQueue.copyElementImageToTexture')) {
    ledger.define(queue, 'copyElementImageToTexture', { value: /** @this {any} */ function copyElementImageToTexture(/** @type {any} */ source, /** @type {any} */ target) {
      return this.drawElementImageToTexture(...fromLegacyGpuArgs(source, target));
    }, writable: true, configurable: true, enumerable: true });
  }
}

/**
 * The natural size of an element or ElementImage in grid px, from whichever shape the native build has: the current
 * `getElementImageDefaultSize` on the canvas (or its OffscreenCanvas), else the earlier `ElementImage.width/height` of a capture.
 * @param {any} canvas  the context's canvas
 * @param {any} source  Element or ElementImage
 * @param {any} [owner]  the canvas that captures an Element (default: its parent, the legacy direct-child rule)
 * @returns {{width: number, height: number}}
 */
function nativeDefaultSize(canvas, source, owner = source?.parentElement) {
  if (typeof canvas?.getElementImageDefaultSize === 'function') return canvas.getElementImageDefaultSize(source);
  if (typeof source?.close === 'function') return { width: source.width, height: source.height };
  const image = owner.captureElementImage(source);
  try { return { width: image.width, height: image.height }; } finally { image.close(); }
}

/**
 * texElementSubImage2D over the legacy texElementImage2D: upload into a scratch texture, copy the rectangle into the bound target at the offset, restore the GL state.
 * The natural-size rule of API-CONTRACT 5.3 applies (config.width/height, else the native default size); scaling between source and destination rectangles is not available this way.
 * @param {HicEnv} env
 * @param {'WebGLRenderingContext'|'WebGL2RenderingContext'} cls
 * @param {boolean} hasLegacyUpload
 * @param {PatchLedger} ledger
 */
function fillTexSubImage(env, cls, hasLegacyUpload, ledger) {
  const proto = /** @type {any} */ (env.window)[cls]?.prototype;
  if (!proto) return;
  if (!hasLegacyUpload) {
    env.reporter.unsupported({ feature: 'webgl-tex-element', path: cls, message: `${cls}.texElementSubImage2D is missing from this native build and has no texElementImage2D to be built from` });
    return;
  }
  ledger.define(proto, 'texElementSubImage2D', {
    value: /** @this {any} */ function texElementSubImage2D(/** @type {number} */ target, /** @type {number} */ level, /** @type {number} */ xoffset, /** @type {number} */ yoffset,
      /** @type {any} */ element, /** @type {any} */ config = {}) {
      const gl = this;
      if (target !== gl.TEXTURE_2D) throw new DOMException('texElementSubImage2D (bridged) supports target TEXTURE_2D only', 'NotSupportedError');
      const { width: naturalWidth, height: naturalHeight } = nativeDefaultSize(gl.canvas, element);
      const width = config.width ?? Math.ceil(naturalWidth);
      const height = config.height ?? Math.ceil(naturalHeight);
      const sx = config.sx ?? 0;
      const sy = config.sy ?? 0;
      const previousTexture = gl.getParameter(gl.TEXTURE_BINDING_2D);
      const previousFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      const scratch = gl.createTexture();
      const framebuffer = gl.createFramebuffer();
      try {
        gl.bindTexture(gl.TEXTURE_2D, scratch);
        gl.texElementImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, element);
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, scratch, 0);
        gl.bindTexture(gl.TEXTURE_2D, previousTexture);
        gl.copyTexSubImage2D(gl.TEXTURE_2D, level, xoffset, yoffset, sx, sy, config.swidth ?? width - sx, config.sheight ?? height - sy);
      } finally {
        gl.bindFramebuffer(gl.FRAMEBUFFER, previousFramebuffer);
        gl.bindTexture(gl.TEXTURE_2D, previousTexture);
        gl.deleteFramebuffer(framebuffer);
        gl.deleteTexture(scratch);
      }
    },
    writable: true, configurable: true, enumerable: true,
  });
}

/**
 * Install the bridge for a native build of kind `legacy` or a fillable `partial`. Records every patch in the ledger.
 * @param {HicEnv} env
 * @param {NativeState} native
 * @param {PatchLedger} ledger
 * @returns {{adoptRoot: (root: ShadowRoot) => void, dispose: () => void}}
 *   adoptRoot = watch a shadow root for `content` attributes (the bridge has no root scope of its own); dispose = stop observers and remove the bridge's stylesheet and attributes (descriptors are restored by the ledger)
 */
export function installNativeBridge(env, native, ledger) {
  const mirror = native.missing.includes('content') ? installContentMirror(env, ledger) : null;
  fillGaps(env, native, ledger);
  const translation = native.kind === 'legacy' && mirror
    ? installLegacyTranslation(env, ledger, (canvas) => mirror.isDrawable(canvas))
    : null;
  env.reporter.deviation('legacy-native-bridge', `native kind "${native.kind}", gaps: ${native.gaps.join(', ') || 'none'}`);
  return {
    adoptRoot: (root) => mirror?.watch(root),
    dispose() { mirror?.dispose(); translation?.dispose(); },
  };
}
