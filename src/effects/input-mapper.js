/**
 * Mapper chain over the spatial plugins of presented frames.
 * Module: gpu-effects (src/effects/**).
 */

import { typeError } from '../contracts/errors.js';

/** @typedef {import('../contracts/types.js').InputMapper} InputMapper */
/** @typedef {import('../contracts/types.js').InputPoint} InputPoint */

/** How many presented frames are kept: a pointer event can belong to a frame that is one or two presentations old. */
const RING_SIZE = 3;

/**
 * @typedef {Object} MapperChain
 * @property {(serial: number, mappers: InputMapper[]) => void} push  mappers captured for the frame just presented (ring of the last 3)
 * @property {(p: InputPoint, age?: number) => {x: number, y: number}} map  through the newest presented frame (`age` 1..2 = older presentations)
 * @property {(age?: number) => ((p: InputPoint) => {x: number, y: number})} captureGesture  frozen mapper for one pointer gesture (captureGestureSnapshot when offered)
 * @property {() => boolean} active  the newest presented frame had at least one spatial mapper
 * @property {() => number} depth  presented frames currently kept
 * @property {() => void} clear
 */

/**
 * @param {InputMapper[]} mappers in plugin order (first plugin first)
 * @returns {(p: InputPoint) => {x: number, y: number}}
 */
function compose(mappers) {
  const list = mappers.slice();
  return (p) => {
    let x = p.x;
    let y = p.y;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const q = list[i]({ x, y, width: p.width, height: p.height });
      if (!q || !Number.isFinite(q.x) || !Number.isFinite(q.y)) throw typeError('an input mapper returned a non-finite point');
      x = q.x;
      y = q.y;
    }
    return { x, y };
  };
}

/**
 * Compose the mappers of all spatial plugins, last plugin first (docs/API-CONTRACT.md 7.4). Pure.
 * @returns {MapperChain}
 */
export function createMapperChain() {
  /** @type {{serial: number, mappers: InputMapper[]}[]} */
  const ring = [];
  /** @param {number|undefined} age */
  const at = (age) => (ring.length === 0 ? undefined : ring[ring.length - 1 - Math.min(Math.max(0, Math.trunc(age ?? 0)), ring.length - 1)]);
  return {
    push(serial, mappers) {
      ring.push({ serial, mappers: mappers.slice() });
      if (ring.length > RING_SIZE) ring.shift();
    },
    map(p, age) {
      const e = at(age);
      return e ? compose(e.mappers)(p) : { x: p.x, y: p.y };
    },
    captureGesture(age) {
      const e = at(age);
      if (!e) return (p) => ({ x: p.x, y: p.y });
      return compose(e.mappers.map((m) => (typeof m.captureGestureSnapshot === 'function' ? m.captureGestureSnapshot() : m)));
    },
    active() {
      const e = at(0);
      return !!e && e.mappers.length > 0;
    },
    depth: () => ring.length,
    clear() { ring.length = 0; },
  };
}
