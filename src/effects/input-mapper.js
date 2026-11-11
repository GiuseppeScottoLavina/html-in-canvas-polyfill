/**
 * Mapper chain over the spatial plugins of presented frames.
 * Module: gpu-effects (src/effects/**).
 */

import { typeError } from '../contracts/errors.js';
import { NO_TARGET, isNoTarget } from './no-target.js';

/** @typedef {import('../contracts/types.js').InputMapper} InputMapper */
/** @typedef {import('../contracts/types.js').InputPoint} InputPoint */

/** How many presented frames are kept: a pointer event can belong to a frame that is one or two presentations old. */
const RING_SIZE = 3;

/**
 * @typedef {Object} MapperChain
 * @property {(serial: number, mappers: InputMapper[], places?: number[]) => void} push  mappers captured for the frame just presented (ring of the last 3); `places[i]` is the place of the plugin of `mappers[i]` in that frame's chain (0 = the first plugin)
 * @property {(p: InputPoint, age?: number) => {x: number, y: number, under?: true}} map  through the newest presented frame (`age` 1..2 = older presentations); NO_TARGET when a mapper says no element is shown there; `under: true` when the point lies on the under page
 * @property {(place: number, p: InputPoint) => {x: number, y: number, under?: true}} mapAfter  through the mappers of the plugins after `place` in the newest presented frame only (where a point of the canvas is in the picture the plugin at `place` rendered); NO_TARGET like `map`
 * @property {(age?: number) => ((p: InputPoint) => {x: number, y: number, under?: true})} captureGesture  frozen mapper for one pointer gesture (captureGestureSnapshot when offered)
 * @property {() => boolean} active  the newest presented frame had at least one spatial mapper
 * @property {() => void} clear
 */

/**
 * @param {InputMapper[]} mappers in plugin order (first plugin first)
 * @param {boolean} under  the host has an under page (EffectHostOptions.under)
 * @returns {(p: InputPoint) => {x: number, y: number, under?: true}}  NO_TARGET as soon as one mapper returns it: the mappers of earlier plugins never see it
 *   (one of them could clamp the far-away point back onto the canvas, onto an element). A point with `under: true` lies on the under page: it ends the chain
 *   too (the under page is drawn from its own texture, not from the picture of the earlier plugins), and is NO_TARGET on a host without an under page.
 */
function compose(mappers, under) {
  const list = mappers.slice();
  return (p) => {
    let x = p.x;
    let y = p.y;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const q = list[i]({ x, y, width: p.width, height: p.height });
      if (isNoTarget(q)) return NO_TARGET;
      if (!q || !Number.isFinite(q.x) || !Number.isFinite(q.y)) throw typeError('an input mapper returned a non-finite point');
      if (/** @type {{under?: unknown}} */ (q).under === true) return under ? { x: q.x, y: q.y, under: true } : NO_TARGET;
      x = q.x;
      y = q.y;
    }
    return { x, y };
  };
}

/**
 * Compose the mappers of all spatial plugins, last plugin first (docs/API-CONTRACT.md 7.4). Pure.
 * @param {{under?: boolean}} [options]  `under`: the host has an under page, so a mapper's `{x, y, under: true}` is passed on (NO_TARGET otherwise)
 * @returns {MapperChain}
 */
export function createMapperChain(options = {}) {
  const under = options.under === true;
  /** @type {{serial: number, mappers: InputMapper[], places: number[]}[]} */
  const ring = [];
  /** @param {number|undefined} age */
  const at = (age) => (ring.length === 0 ? undefined : ring[ring.length - 1 - Math.min(Math.max(0, Math.trunc(age ?? 0)), ring.length - 1)]);
  return {
    push(serial, mappers, places) {
      ring.push({ serial, mappers: mappers.slice(), places: places ? places.slice() : mappers.map((_, i) => i) });
      if (ring.length > RING_SIZE) ring.shift();
    },
    map(p, age) {
      const e = at(age);
      return e ? compose(e.mappers, under)(p) : { x: p.x, y: p.y };
    },
    mapAfter(place, p) {
      const e = at(0);
      return e ? compose(e.mappers.filter((_, i) => e.places[i] > place), under)(p) : { x: p.x, y: p.y };
    },
    captureGesture(age) {
      const e = at(age);
      if (!e) return (p) => ({ x: p.x, y: p.y });
      return compose(e.mappers.map((m) => (typeof m.captureGestureSnapshot === 'function' ? m.captureGestureSnapshot() : m)), under);
    },
    active() {
      const e = at(0);
      return !!e && e.mappers.length > 0;
    },
    clear() { ring.length = 0; },
  };
}
