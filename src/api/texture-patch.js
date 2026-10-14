/**
 * WebGL texElementSubImage2D / texElementImage2D and GPUQueue.drawElementImageToTexture / copyElementImageToTexture.
 * Module: api-surface (src/api/*).
 */

import { invalidState } from '../contracts/errors.js';
import { elementImageVersion } from './element-image.js';
import { offscreenPlaceholder } from './offscreen-patch.js';
import { clipPlanToSurface, planUpload } from './texture-math.js';
import { assertTargetType, defineMethod, globalsOf, resolveElement } from './validate.js';

/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../contracts/types.js').PatchLedger} PatchLedger */
/** @typedef {import('../contracts/types.js').SnapshotVersion} SnapshotVersion */
/** @typedef {import('./texture-math.js').UploadPlan} UploadPlan */
/** @typedef {HTMLCanvasElement | OffscreenCanvas} Surface */
/** @typedef {{sx?: number, sy?: number, swidth?: number, sheight?: number, width?: number, height?: number}} UploadConfig */

/**
 * @typedef {Object} Upload
 * @property {Surface} source  retained surface or scratch canvas
 * @property {number} x  origin of the rect inside `source` (0 for a scratch canvas)
 * @property {number} y
 * @property {number} width  texels
 * @property {number} height
 */

const GL_RGBA = 0x1908;
const GL_UNSIGNED_BYTE = 0x1401;
/** Scratch canvases kept per version (different rects of one snapshot). */
const MAX_SCRATCH_PER_VERSION = 4;

/** @type {WeakMap<SnapshotVersion, Map<string, Surface>>} resampled copies; a version is immutable, so a key never goes stale */
const scratchCache = new WeakMap();

/** @param {HicEnv} env @param {number} w @param {number} h @returns {Surface} */
function createScratch(env, w, h) {
  const win = globalsOf(env);
  if (typeof win.OffscreenCanvas === 'function') return new win.OffscreenCanvas(w, h);
  const canvas = env.document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

/**
 * A (width x height) canvas holding the requested rect: cropped when the surface has ink around the border box, resampled when its pixel size differs.
 * @param {HicEnv} env
 * @param {SnapshotVersion} version
 * @param {UploadPlan} plan
 * @returns {Surface}
 */
function scratchFor(env, version, plan) {
  const { sx, sy, sw, sh } = plan.sourceCss;
  const key = `${sx},${sy},${sw},${sh}>${plan.width}x${plan.height}`;
  let byKey = scratchCache.get(version);
  const hit = byKey?.get(key);
  if (hit) return hit;
  const scratch = createScratch(env, plan.width, plan.height);
  const ctx = /** @type {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D|null} */ (scratch.getContext('2d'));
  if (!ctx) throw invalidState(`Could not allocate a ${plan.width}x${plan.height} scratch canvas for the texture upload.`);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const placed = clipPlanToSurface(plan, version);
  const raster = placed && env.store.rasterSource(version, placed.src);
  if (placed && raster) ctx.drawImage(raster.source, raster.sx, raster.sy, raster.sw, raster.sh, placed.dx, placed.dy, placed.dw, placed.dh);
  if (!byKey) scratchCache.set(version, byKey = new Map());
  if (byKey.size >= MAX_SCRATCH_PER_VERSION) byKey.delete(/** @type {string} */ (byKey.keys().next().value));
  byKey.set(key, scratch);
  return scratch;
}

/**
 * Resolve the snapshot and decide what to hand to the GPU: the retained surface itself when it IS the requested rect at the destination size, else a scratch canvas.
 * @param {HicEnv} env
 * @param {HTMLCanvasElement} canvas  canvas whose grid the default size follows
 * @param {unknown} target  Element or ElementImage
 * @param {UploadConfig} config
 * @param {boolean} sourceRectAllowed  the sink takes a source origin (copyExternalImageToTexture); texSubImage2D reads a whole canvas
 * @returns {Upload|null}  null for an empty destination
 */
function prepareUpload(env, canvas, target, config, sourceRectAllowed) {
  const { version } = resolveElement(env, canvas, target, 'snapshot');
  if (!version) throw invalidState('The element has no snapshot yet.');
  const scaleX = version.canvasWidth > 0 ? canvas.width / version.canvasWidth : 1;
  const scaleY = version.canvasHeight > 0 ? canvas.height / version.canvasHeight : 1;
  const plan = planUpload(
    { width: version.width * scaleX, height: version.height * scaleY },
    { width: version.width, height: version.height, scaleX, scaleY },
    config, version.scale);
  if (plan.width === 0 || plan.height === 0) return null;
  const { left, top, right, bottom } = version.ink;
  // With ink around the border box the surface is never exactly the rect, so the lookup is only worth it for an inkless surface.
  if (!plan.resample && (sourceRectAllowed || left + top + right + bottom === 0)) {
    const placed = clipPlanToSurface(plan, version);
    const raster = placed?.whole ? env.store.rasterSource(version, plan.sourceCss) : null;
    const wholeCanvas = raster && raster.sx === 0 && raster.sy === 0 && raster.sw === raster.source.width && raster.sh === raster.source.height;
    if (raster && (sourceRectAllowed || wholeCanvas)) return { source: raster.source, x: raster.sx, y: raster.sy, width: plan.width, height: plan.height };
  }
  return { source: scratchFor(env, version, plan), x: 0, y: 0, width: plan.width, height: plan.height };
}

/** @param {unknown} config @param {string} method @returns {UploadConfig} */
function configObject(config, method) {
  if (config === undefined || config === null) return {};
  if (typeof config !== 'object' && typeof config !== 'function') throw new TypeError(`Failed to execute '${method}': the config argument is not an object.`);
  return /** @type {UploadConfig} */ (config);
}

// ---------------------------------------------------------------------------------------------- WebGL

/**
 * The HTMLCanvasElement behind a WebGL context (an OffscreenCanvas context resolves through its placeholder).
 * @param {{canvas: HTMLCanvasElement | OffscreenCanvas}} gl
 * @returns {HTMLCanvasElement}
 */
function glCanvas(gl) {
  const owner = gl.canvas;
  if (typeof (/** @type {any} */ (owner)).nodeType === 'number') return /** @type {HTMLCanvasElement} */ (owner);
  const placeholder = offscreenPlaceholder(/** @type {OffscreenCanvas} */ (owner));
  if (!placeholder) throw new TypeError('The WebGL context draws into an OffscreenCanvas without a placeholder canvas.');
  return placeholder;
}

/**
 * @param {HicEnv} env
 * @param {PatchLedger} ledger
 * @param {object} proto  WebGLRenderingContext.prototype or WebGL2RenderingContext.prototype
 */
function installWebGL(env, ledger, proto) {
  const api = /** @type {any} */ (proto);
  const texSubImage2D = /** @type {Function} */ (api.texSubImage2D);
  const texImage2D = /** @type {Function} */ (api.texImage2D);

  defineMethod(ledger, proto, 'texElementSubImage2D', 5, /** @this {any} */ function (
    /** @type {number} */ target, /** @type {number} */ level, /** @type {number} */ xoffset, /** @type {number} */ yoffset,
    /** @type {unknown} */ element, /** @type {unknown} */ config) {
    if (arguments.length < 5) throw new TypeError(`Failed to execute 'texElementSubImage2D': 5 arguments required, but only ${arguments.length} present.`);
    assertTargetType(env, element);
    const upload = prepareUpload(env, glCanvas(this), element, configObject(config, 'texElementSubImage2D'), false);
    if (upload) Reflect.apply(texSubImage2D, this, [target, level, xoffset, yoffset, GL_RGBA, GL_UNSIGNED_BYTE, upload.source]);
  });

  if (!env.options.legacyNames) return;
  defineMethod(ledger, proto, 'texElementImage2D', 6, /** @this {any} */ function (
    /** @type {number} */ target, /** @type {number} */ level, /** @type {number} */ internalformat, /** @type {number} */ format, /** @type {number} */ type,
    /** @type {unknown} */ element, /** @type {unknown} */ config) {
    if (arguments.length < 6) throw new TypeError(`Failed to execute 'texElementImage2D': 6 arguments required, but only ${arguments.length} present.`);
    assertTargetType(env, element);
    const upload = prepareUpload(env, glCanvas(this), element, configObject(config, 'texElementImage2D'), false);
    if (upload) Reflect.apply(texImage2D, this, [target, level, internalformat, format, type, upload.source]);
  });
}

// ---------------------------------------------------------------------------------------------- WebGPU

/**
 * GPUExtent3D -> width/height (undefined members when absent).
 * @param {unknown} size
 * @returns {{width?: number, height?: number}}
 */
function extentSize(size) {
  if (size === undefined || size === null) return {};
  if (Array.isArray(size)) return { width: size[0], height: size[1] ?? 1 };
  if (typeof size !== 'object') throw new TypeError('size is not a GPUExtent3D.');
  const e = /** @type {{width?: number, height?: number}} */ (size);
  return { width: e.width, height: e.height ?? 1 };
}

/**
 * The canvas whose grid a WebGPU copy follows: the canvas of the ElementImage, or the nearest managed canvas of the element (a queue has no canvas).
 * @param {HicEnv} env
 * @param {unknown} target
 * @returns {HTMLCanvasElement}
 */
function canvasOfTarget(env, target) {
  assertTargetType(env, target);
  const image = elementImageVersion(target);
  const canvas = image ? image.record?.canvas : env.registry.ownerOfDrawable(/** @type {Element} */ (target))?.canvas;
  if (!canvas) throw invalidState('The element is not a drawable descendant of a canvas with content="drawable".');
  return canvas;
}

/**
 * Shared body of drawElementImageToTexture and the legacy copyElementImageToTexture: one copyExternalImageToTexture of the upload.
 * @param {HicEnv} env
 * @param {Function} copyExternal  the platform GPUQueue.copyExternalImageToTexture
 * @param {any} queue
 * @param {{source: unknown, rect: UploadConfig, destination: Record<string, unknown>}} request
 */
function copyToTexture(env, copyExternal, queue, request) {
  const upload = prepareUpload(env, canvasOfTarget(env, request.source), request.source, request.rect, true);
  if (!upload) return;
  Reflect.apply(copyExternal, queue, [
    { source: upload.source, origin: { x: upload.x, y: upload.y }, flipY: false },
    request.destination,
    [upload.width, upload.height],
  ]);
}

/** @param {unknown} v @param {string} what @returns {Record<string, any>} */
function dictionary(v, what) {
  if (v === null || (typeof v !== 'object' && typeof v !== 'function')) throw new TypeError(`${what} is not an object.`);
  return /** @type {Record<string, any>} */ (v);
}

/** Members of GPUImageCopyTextureTagged (the destination minus `size`). @param {Record<string, any>} d @returns {Record<string, unknown>} */
function taggedTexture(d) {
  const out = /** @type {Record<string, unknown>} */ ({ texture: d.texture });
  for (const key of ['mipLevel', 'origin', 'aspect', 'colorSpace', 'premultipliedAlpha']) if (d[key] !== undefined) out[key] = d[key];
  return out;
}

/**
 * @param {HicEnv} env
 * @param {PatchLedger} ledger
 * @param {object} proto  GPUQueue.prototype
 */
function installWebGPU(env, ledger, proto) {
  const copyExternal = /** @type {Function} */ (/** @type {any} */ (proto).copyExternalImageToTexture);
  if (typeof copyExternal !== 'function') return;

  defineMethod(ledger, proto, 'drawElementImageToTexture', 2, /** @this {any} */ function (/** @type {unknown} */ source, /** @type {unknown} */ destination) {
    if (arguments.length < 2) throw new TypeError(`Failed to execute 'drawElementImageToTexture': 2 arguments required, but only ${arguments.length} present.`);
    const s = dictionary(source, 'source');
    const d = dictionary(destination, 'destination');
    const size = extentSize(d.size);
    copyToTexture(env, copyExternal, this, {
      source: s.source,
      rect: { sx: s.sourceX, sy: s.sourceY, swidth: s.sourceWidth, sheight: s.sourceHeight, width: size.width, height: size.height },
      destination: taggedTexture(d),
    });
  });

  if (!env.options.legacyNames) return;
  // Chrome 154 shape: ({source, sx, sy, swidth, sheight}, {destination: {texture, ...}, width, height}).
  defineMethod(ledger, proto, 'copyElementImageToTexture', 2, /** @this {any} */ function (/** @type {unknown} */ source, /** @type {unknown} */ destination) {
    if (arguments.length < 2) throw new TypeError(`Failed to execute 'copyElementImageToTexture': 2 arguments required, but only ${arguments.length} present.`);
    const s = dictionary(source, 'source');
    const d = dictionary(destination, 'destination');
    copyToTexture(env, copyExternal, this, {
      source: s.source,
      rect: { sx: s.sx, sy: s.sy, swidth: s.swidth, sheight: s.sheight, width: d.width, height: d.height },
      destination: taggedTexture(d.destination ?? d),
    });
  });
}

/**
 * Adapters over store.rasterSource + one GPU copy (docs/API-CONTRACT.md 5.3/5.4). No automatic geometry update.
 * Installed on BOTH WebGLRenderingContext.prototype and WebGL2RenderingContext.prototype (legacy aliases on both) and on GPUQueue.prototype. The upload rect comes from texture-math.planUpload (default = ceil of getElementImageDefaultSize, config overrides);
 * a scratch 2D canvas resamples whenever the surface pixel size differs from the rect (canvas grid scale < 1 or > maxDpr, fractional sizes); the scratch result is cached per SnapshotVersion id. Storage too small or missing is a GL error as native, never a throw.
 * UNPACK_FLIP_Y / PREMULTIPLY_ALPHA apply as for texSubImage2D(canvas).
 * @param {HicEnv} env
 * @param {PatchLedger} ledger
 */
export function installTexturePatches(env, ledger) {
  const win = globalsOf(env);
  for (const ctor of [win.WebGLRenderingContext, win.WebGL2RenderingContext]) {
    if (typeof ctor === 'function') installWebGL(env, ledger, ctor.prototype);
  }
  const queue = /** @type {{prototype: object}|undefined} */ (/** @type {any} */ (win).GPUQueue);
  if (queue) installWebGPU(env, ledger, queue.prototype);
}
