/**
 * Playing <video> elements inside drawables -> damage at every new video frame (WPT video: a paint per frame, as natively).
 * Module: schedule (src/schedule/observers/*).
 */

import { createDamageBatch, getRectMemory } from './damage-rect.js';

/** @typedef {import('../../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../../contracts/types.js').HicEnv} HicEnv */

const MEDIA_EVENTS = ['play', 'playing', 'seeked', 'loadeddata'];

/**
 * Every video of the layer that plays is watched with requestVideoFrameCallback, which fires once per presented frame (also inside the invisible live layer, measured):
 * each new frame damages the video's reach in its drawable (cause 'animation'), so the snapshot shows the frame the page shows and `paint` fires once per video frame,
 * not once per display frame. A paused or ended video presents no frame and costs nothing. Without requestVideoFrameCallback, a frame hook damages the video while its
 * currentTime moves. Started by the media events (captured on the layer) and for the videos already playing.
 * @param {HicEnv} env
 * @param {CanvasRecord} record
 * @returns {() => void}
 */
export function observeVideos(env, record) {
  const found = record.layer;
  if (!found) return () => {};
  const layer = found;
  const root = layer.element;
  const memory = getRectMemory(env);
  /** @type {Map<HTMLVideoElement, number>} armed frame callbacks */
  const armed = new Map();
  /** @type {WeakMap<HTMLVideoElement, number>} last currentTime seen by the fallback hook */
  const times = new WeakMap();
  /** @type {(() => void)|null} */
  let removeHook = null;

  /** @param {HTMLVideoElement} v */
  function damage(v) {
    const drawable = layer.nearestDrawable(v);
    if (!drawable) return;
    const batch = createDamageBatch();
    batch.add(drawable, memory.reach(layer, v));
    batch.flush((d, rect) => env.scheduler.damage(record, 'animation', d, rect));
  }

  /** @param {HTMLVideoElement} v */
  function arm(v) {
    if (armed.has(v)) return;
    const frame = () => {
      armed.delete(v);
      if (!root.contains(v)) return;
      damage(v);
      if (!v.paused && !v.ended) arm(v);
    };
    armed.set(v, v.requestVideoFrameCallback(frame));
  }

  /** @type {import('../../contracts/types.js').FrameHook} */
  function hook(_now, info) {
    if (!info.due) return true;
    let any = false;
    for (const v of /** @type {HTMLVideoElement[]} */ (Array.from(root.getElementsByTagName('video')))) {
      if (v.paused || v.ended) continue;
      any = true;
      if (times.get(v) !== v.currentTime) { times.set(v, v.currentTime); damage(v); }
    }
    if (any) return true;
    removeHook?.();
    removeHook = null;
    return false;
  }

  /** @param {HTMLVideoElement} v */
  function watch(v) {
    if (typeof v.requestVideoFrameCallback === 'function') arm(v);
    else if (!removeHook) removeHook = env.scheduler.addFrameHook(record, hook);
  }

  /** @param {Event} e */
  const onMedia = (e) => {
    const v = /** @type {HTMLVideoElement} */ (e.target);
    if (v.localName !== 'video') return;
    damage(v); // a seek or a new source shows another frame
    if (!v.paused) watch(v);
  };
  for (const type of MEDIA_EVENTS) root.addEventListener(type, onMedia, { capture: true, passive: true });
  for (const v of /** @type {HTMLVideoElement[]} */ (Array.from(root.getElementsByTagName('video')))) if (!v.paused && !v.ended) watch(v);
  return () => {
    for (const type of MEDIA_EVENTS) root.removeEventListener(type, onMedia, { capture: true });
    for (const [v, id] of armed) v.cancelVideoFrameCallback?.(id);
    armed.clear();
    removeHook?.();
    removeHook = null;
  };
}
