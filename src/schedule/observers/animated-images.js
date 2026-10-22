/**
 * Animated images (GIF, APNG, animated WebP and AVIF) of the <img> elements of drawables: their frames on the polyfill's own clock, one paint per frame (WPT animated-gif*).
 * Module: schedule (src/schedule/observers/*).
 *
 * A snapshot is an SVG image: an animated image inside it shows its first frame and never advances, and no event announces a new frame of the live <img>. The capture
 * therefore asks this module which picture an <img> shows (AnimatedImages.frameUrl). An image whose bytes declare an animation (sniffAnimated, once per URL) is played here:
 * its frames are decoded with ImageDecoder (WebCodecs), the frame due is encoded as a PNG data: URL, and when the frame changes the reach of every <img> showing it is damaged
 * (cause 'animation'), so that `paint` fires once per frame of the image, as natively. One clock per image URL, as the engines share one animation per image resource.
 * COST: nothing for a page without animated images but one sniff per image URL the capture inlines. An image is played only while a canvas that contains it can be seen
 * (util/visibility.js, created at the first animated image of that canvas) and at most at the build rate of that canvas (frame cap and maxSnapshotFps); encoded frames stay in a
 * bounded cache (FRAME_BUDGET_CHARS), so a looping image is decoded once per frame.
 * PRIVACY: only bytes the resource cache could read reach the decoder (same-origin, or CORS); a cross-origin image without CORS is never inlined, so never played.
 * Without ImageDecoder (Safari 27, documents that are not a secure context) the first frame is shown.
 */

import { effectiveFps } from '../frame-cap.js';
import { watchVisibility } from '../../util/visibility.js';
import { createDamageBatch, getRectMemory } from './damage-rect.js';

/** @typedef {import('../../contracts/types.js').AnimatedImages} AnimatedImages */
/** @typedef {import('../../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../../contracts/types.js').HicEnv} HicEnv */

/** Encoded frames of every image together, in UTF-16 units of their data: URLs (the least recently used go first; a shown frame stays). */
const FRAME_BUDGET_CHARS = 24 * 1024 * 1024;
/** Larger images show their first frame (reported): a frame is decoded and encoded on the main thread's budget. */
const MAX_FRAME_PIXELS = 2048 * 2048;
/** The engines show a frame that declares 10 ms or less for 100 ms (Chromium ImageDecoder::FrameDurationAtIndex, Gecko), ImageDecoder reports the declared value. */
const SHORT_FRAME_MS = 10;
const SHORT_FRAME_SHOWN_MS = 100;
/** Bytes decoded to sniff an image that is not a GIF (the animation chunk of APNG, WebP and AVIF comes before the image data). */
const SNIFF_PREFIX_CHARS = 64 * 1024;
const ANIMATABLE = /^data:image\/(gif|png|apng|webp|avif);base64,/i;

/** @param {Uint8Array} b @param {number} i */
const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
/** @param {Uint8Array} b @param {number} i */
const fourCC = (b, i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);

/** @param {Uint8Array} b @returns {boolean|null} */
function gifAnimated(b) {
  let i = 13;
  if (b[10] & 0x80) i += 3 << ((b[10] & 7) + 1);
  let images = 0;
  while (i < b.length) {
    const c = b[i];
    if (c === 0x3b) return false;
    if (c === 0x21) i += 2;
    else if (c === 0x2c) {
      if (++images > 1) return true;
      if (i + 10 > b.length) return null;
      const flags = b[i + 9];
      i += 10;
      if (flags & 0x80) i += 3 << ((flags & 7) + 1);
      i += 1;
    } else return false;
    while (i < b.length && b[i] !== 0) i += b[i] + 1;
    i++;
  }
  return null;
}

/** @param {Uint8Array} b @returns {boolean|null} */
function pngAnimated(b) {
  for (let i = 8; i + 8 <= b.length; i += 12 + u32(b, i)) {
    const type = fourCC(b, i + 4);
    if (type === 'acTL') return i + 12 <= b.length ? u32(b, i + 8) > 1 : null;
    if (type === 'IDAT' || type === 'IEND') return false;
  }
  return null;
}

/**
 * PURE. Does an image declare an animation? GIF: a second image; APNG: an acTL chunk with more than one frame before the image data; WebP: the animation flag of VP8X;
 * AVIF: the image-sequence brand `avis`. null: the bytes end before the answer (a prefix).
 * @param {Uint8Array} b
 * @returns {boolean|null}
 */
export function sniffAnimated(b) {
  if (b.length < 13) return null;
  const head = fourCC(b, 0);
  if (head === 'GIF8') return gifAnimated(b);
  if (head === '\x89PNG') return pngAnimated(b);
  if (head === 'RIFF') return fourCC(b, 8) === 'WEBP' && fourCC(b, 12) === 'VP8X' ? b.length > 20 ? (b[20] & 0x02) !== 0 : null : false;
  if (fourCC(b, 4) === 'ftyp') {
    const size = u32(b, 0);
    if (b.length < size) return null;
    for (let i = 8; i + 4 <= size; i += 4) if (fourCC(b, i) === 'avis') return true;
  }
  return false;
}

/** @param {string} dataUrl @param {number} [chars] base64 characters to decode (all when omitted) @returns {Uint8Array} */
function dataBytes(dataUrl, chars) {
  const comma = dataUrl.indexOf(',');
  let s = chars ? dataUrl.slice(comma + 1, comma + 1 + chars) : dataUrl.slice(comma + 1);
  if (chars) s = s.slice(0, s.length - (s.length % 4));
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** @param {string} dataUrl @returns {boolean} */
function declaresAnimation(dataUrl) {
  try {
    const gif = /^data:image\/gif/i.test(dataUrl);
    const first = gif || dataUrl.length <= SNIFF_PREFIX_CHARS * 2 ? null : sniffAnimated(dataBytes(dataUrl, SNIFF_PREFIX_CHARS));
    return first ?? sniffAnimated(dataBytes(dataUrl)) === true;
  } catch {
    return false; // not base64 after all
  }
}

/**
 * @typedef {Object} Viewer  the observer of one canvas
 * @property {(img: Element) => boolean} contains
 * @property {() => boolean} visible  starts the canvas's visibility watch at the first question
 * @property {() => number} intervalMs  the shortest time between two frames this canvas may build (0: no limit)
 * @property {(img: Element) => void} damage
 */

/**
 * @typedef {Object} Anim  one animated image URL
 * @property {number} id
 * @property {string} abs  its URL
 * @property {string} mime
 * @property {string} source  the data: URL of the image
 * @property {Set<Element>} imgs  the <img> elements the capture saw showing it
 * @property {any} decoder  ImageDecoder, null until opened
 * @property {Promise<boolean>|null} opening
 * @property {boolean} dead  no decoder, too large, or a decode failed: the first frame stays
 * @property {number} count
 * @property {number} reps  repetitions after the first play (Infinity: forever)
 * @property {number} loops  plays completed
 * @property {number[]} durations  ms per frame, as decoded
 * @property {Map<number, string>} frames  encoded frames
 * @property {Map<number, Promise<string|null>>} encoding
 * @property {number} index  the frame shown
 * @property {number} since  env.now() at which it started showing on the image's clock (moved forward by the time paused)
 * @property {number} shownAt  env.now() at which it was shown (the frame cap counts from there)
 * @property {number|null} pausedAt
 * @property {number|null} timer
 * @property {boolean} busy  a step is decoding / encoding
 */

/**
 * The shared player (one per install): the capture asks it for the picture of an <img>, the observers of the canvases register as viewers.
 * @param {HicEnv} env
 * @returns {AnimatedImages & {addViewer: (v: Viewer) => () => void}}
 */
export function createAnimatedImages(env) {
  /** @type {Map<string, Anim|null>} null: not animated */
  const byUrl = new Map();
  /** @type {WeakMap<Element, string>} the URL each <img> was seen with */
  const seen = new WeakMap();
  /** @type {Set<Viewer>} */
  const viewers = new Set();
  /** @type {Map<string, {anim: Anim, index: number, chars: number}>} insertion order = recency */
  const lru = new Map();
  let chars = 0;
  let ids = 0;
  let disposed = false;
  const win = /** @type {any} */ (env.window);

  /** @param {string} abs @param {string} dataUrl @returns {Anim|null} */
  function sniff(abs, dataUrl) {
    const m = ANIMATABLE.exec(dataUrl);
    if (!m || !declaresAnimation(dataUrl)) return null;
    const decoding = typeof win.ImageDecoder === 'function';
    if (!decoding) env.reporter.deviation('animated-images', 'this browser has no ImageDecoder (or the document is not a secure context): an animated image shows its first frame');
    return {
      id: ++ids, abs, mime: `image/${m[1].toLowerCase()}`, source: dataUrl, imgs: new Set(), decoder: null, opening: null, dead: !decoding, count: 0, reps: 0, loops: 0,
      durations: [], frames: new Map(), encoding: new Map(), index: 0, since: 0, shownAt: 0, pausedAt: null, timer: null, busy: false,
    };
  }

  /** @param {Anim} anim @returns {Promise<boolean>} */
  function open(anim) {
    anim.opening ??= (async () => {
      const ID = win.ImageDecoder;
      if (!(await ID.isTypeSupported(anim.mime))) return false;
      const decoder = new ID({ data: dataBytes(anim.source), type: anim.mime });
      await decoder.tracks.ready;
      await decoder.completed;
      const track = decoder.tracks.selectedTrack;
      if (!track?.animated || track.frameCount < 2 || disposed) { decoder.close(); return false; }
      anim.decoder = decoder;
      anim.count = track.frameCount;
      anim.reps = track.repetitionCount;
      return true;
    })().catch(() => false);
    return anim.opening;
  }

  /** @param {Anim} anim @param {number} index @returns {Promise<any>} the VideoFrame; its duration is recorded */
  async function decode(anim, index) {
    const { image } = await anim.decoder.decode({ frameIndex: index });
    const ms = (image.duration ?? 0) / 1000;
    anim.durations[index] = ms <= SHORT_FRAME_MS ? SHORT_FRAME_SHOWN_MS : ms;
    return image;
  }

  /** @param {any} image VideoFrame, closed here @returns {Promise<string>} */
  async function encode(image) {
    const w = image.displayWidth;
    const h = image.displayHeight;
    if (w * h > MAX_FRAME_PIXELS) {
      image.close();
      throw new RangeError(`animated image of ${w}x${h} exceeds ${MAX_FRAME_PIXELS} pixels`);
    }
    const OC = win.OffscreenCanvas;
    const canvas = OC ? new OC(w, h) : Object.assign(env.document.createElement('canvas'), { width: w, height: h });
    canvas.getContext('2d').drawImage(image, 0, 0);
    image.close();
    if (!OC) return canvas.toDataURL('image/png');
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return new Promise((resolve, reject) => {
      const reader = new win.FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  /** @param {Anim} anim @param {number} index @param {string} url */
  function remember(anim, index, url) {
    anim.frames.set(index, url);
    lru.set(`${anim.id}:${index}`, { anim, index, chars: url.length });
    chars += url.length;
    for (const [k, e] of lru) {
      if (chars <= FRAME_BUDGET_CHARS) break;
      if (e.anim.index === e.index && e.anim.frames.get(e.index)) continue; // shown
      lru.delete(k);
      e.anim.frames.delete(e.index);
      chars -= e.chars;
    }
  }

  /** @param {Anim} anim @param {number} index @param {any} [image] an already decoded VideoFrame of that frame @returns {Promise<string|null>} */
  function frame(anim, index, image) {
    const hit = anim.frames.get(index);
    if (hit) { image?.close(); return Promise.resolve(hit); }
    let p = anim.encoding.get(index);
    if (p) { image?.close(); return p; }
    p = (async () => encode(image ?? (await decode(anim, index))))().then((url) => {
      anim.encoding.delete(index);
      remember(anim, index, url);
      return url;
    }, (err) => {
      anim.encoding.delete(index);
      kill(anim, err);
      return null;
    });
    anim.encoding.set(index, p);
    return p;
  }

  /** @param {Anim} anim @param {unknown} err */
  function kill(anim, err) {
    if (anim.dead) return;
    anim.dead = true;
    stop(anim);
    env.reporter.deviation('animated-images', `the first frame of an animated image is shown: ${String(/** @type {any} */ (err)?.message ?? err)}`);
  }

  /** @param {Anim} anim */
  function stop(anim) {
    if (anim.timer !== null) win.clearTimeout(anim.timer);
    anim.timer = null;
  }

  /** @param {Anim} anim @param {number} i @returns {number} the frame after i (i itself once the last repetition has ended) */
  function next(anim, i) {
    if (i + 1 < anim.count) return i + 1;
    return anim.reps === Infinity || anim.loops < anim.reps ? 0 : i;
  }

  /** @param {Anim} anim @returns {Viewer[]} the viewers that see one of its images (the images gone are forgotten) */
  function watchers(anim) {
    for (const img of anim.imgs) if (!img.isConnected || seen.get(img) !== anim.abs) anim.imgs.delete(img);
    return [...viewers].filter((v) => [...anim.imgs].some((img) => v.contains(img)));
  }

  /** @param {Anim} anim  (re)arm the clock of an image: paused while no canvas that shows it can be seen */
  function arm(anim) {
    if (anim.dead || anim.busy || anim.timer !== null || disposed) return;
    const now = env.now();
    const visible = watchers(anim).filter((v) => v.visible());
    if (!anim.imgs.size) { release(anim); return; }
    if (!visible.length) { anim.pausedAt ??= now; return; }
    if (anim.pausedAt !== null) { anim.since += now - anim.pausedAt; anim.pausedAt = null; }
    if (!anim.decoder) {
      anim.busy = true;
      open(anim).then((ok) => { anim.busy = false; if (ok) { anim.since = env.now(); arm(anim); } else kill(anim, new Error('the decoder refused it')); });
      return;
    }
    const known = anim.durations[anim.index];
    if (known === undefined) { void step(anim); return; }
    const gap = Math.max(...visible.map((v) => v.intervalMs()), 0);
    if (next(anim, anim.index) === anim.index) return; // the last repetition ended: the last frame stays
    const wait = Math.max(anim.since + known - now, anim.shownAt + gap - now, 0);
    anim.timer = win.setTimeout(() => { anim.timer = null; void step(anim); }, wait);
  }

  /** @param {Anim} anim  move the clock to the frame due now, encode it, show it */
  async function step(anim) {
    if (anim.busy || anim.dead || disposed) return;
    anim.busy = true;
    try {
      let i = anim.index;
      let start = anim.since;
      const now = env.now();
      /** @type {any} */
      let image = null;
      for (let guard = 0; guard < 4 * anim.count; guard++) {
        if (anim.durations[i] === undefined) { image?.close(); image = await decode(anim, i); }
        const end = start + anim.durations[i];
        const n = next(anim, i);
        if (end > now || n === i) break;
        if (n === 0) anim.loops++;
        image?.close();
        image = null;
        i = n;
        start = end;
      }
      if (i === anim.index) { image?.close(); return; }
      const url = await frame(anim, i, image);
      if (!url || anim.dead || disposed) return;
      anim.index = i;
      anim.since = start;
      anim.shownAt = env.now();
      const views = watchers(anim);
      for (const img of anim.imgs) for (const v of views) if (v.contains(img)) v.damage(img);
      void frame(anim, next(anim, i)); // ready for the next boundary
    } catch (err) {
      kill(anim, err);
    } finally {
      anim.busy = false;
      if (!anim.dead) arm(anim);
    }
  }

  /** @param {Anim} anim  no image shows it any more: the decoder and the clock go, encoded frames stay evictable */
  function release(anim) {
    stop(anim);
    anim.decoder?.close();
    anim.decoder = null;
    anim.opening = null;
    anim.index = 0;
    anim.loops = 0;
    anim.pausedAt = null;
  }

  return {
    frameUrl(img, abs, dataUrl) {
      let anim = byUrl.get(abs);
      if (anim === undefined) byUrl.set(abs, (anim = sniff(abs, dataUrl)));
      if (!anim) return dataUrl;
      anim.source = dataUrl;
      if (seen.get(img) !== abs || !anim.imgs.has(img)) {
        seen.set(img, abs);
        anim.imgs.add(img);
        const a = anim;
        queueMicrotask(() => arm(a));
      }
      return (anim.index > 0 || anim.frames.has(0) ? anim.frames.get(anim.index) : null) ?? dataUrl;
    },
    wake() {
      for (const anim of byUrl.values()) {
        if (!anim) continue;
        stop(anim);
        arm(anim);
      }
    },
    addViewer(v) {
      viewers.add(v);
      return () => { viewers.delete(v); };
    },
    dispose() {
      disposed = true;
      for (const anim of byUrl.values()) if (anim) release(anim);
      byUrl.clear();
      lru.clear();
      viewers.clear();
    },
  };
}

/**
 * The viewer of one canvas: its <img> elements are played while the canvas can be seen, and each new frame damages the image's reach in its drawable.
 * @param {HicEnv} env
 * @param {CanvasRecord} record
 * @returns {() => void}
 */
export function observeAnimatedImages(env, record) {
  const player = /** @type {ReturnType<typeof createAnimatedImages>|undefined} */ (env.animatedImages);
  const layer = record.layer;
  if (!player?.addViewer || !layer) return () => {};
  const root = layer.element;
  const memory = getRectMemory(env);
  /** @type {import('../../util/visibility.js').VisibilityWatch|null} */
  let watch = null;
  const remove = player.addViewer({
    contains: (img) => root.contains(img),
    visible() {
      watch ??= watchVisibility(env, record.canvas, () => player.wake());
      return watch.visible && record.state === 'active';
    },
    intervalMs() {
      const fps = effectiveFps(record.frameCap, env.options, 'build', false);
      return fps > 0 ? 1000 / fps : 0;
    },
    damage(img) {
      const drawable = layer.nearestDrawable(img);
      if (!drawable) return;
      const batch = createDamageBatch();
      batch.add(drawable, memory.reach(layer, img));
      batch.flush((d, rect) => env.scheduler.damage(record, 'animation', d, rect));
    },
  });
  return () => {
    remove();
    watch?.dispose();
    player.wake(); // its images pause, or play on in another canvas
  };
}
