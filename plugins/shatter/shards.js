/**
 * The geometry and the physics of the shards, without GPU or DOM. PURE: Node tests exercise it directly.
 *
 *   impactSeeds    Voronoi seeds on jittered rings around the impact point (denser near it), so the cells read as radial cracks
 *   voronoiCell    one cell, clipped from the canvas rectangle by the bisector half-planes (exact partition of the rectangle)
 *   buildShards    every cell as a triangle fan for the vertex buffer, and the per-shard motion parameters for the uniform block
 *   shardPoint     the JavaScript twin of vs_shard in shatter.wgsl: where a point of a shard is at physics time t
 * Everything here runs once per shatter (when it starts), never per frame.
 */

/** shard capacity of the uniform block (shatter.wgsl: 2 vec4 per shard) */
export const MAX_SHARDS = 64;
/** vertices kept per cell; a Voronoi cell of these seeds has far fewer (checked by the tests) */
export const MAX_POLY = 24;
/** floats per vertex: home x, home y (css px), shard * 2 + border flag, edge factor (1 at the centre of the fan, 0 on the outer edge) */
export const VERTEX_FLOATS = 4;
export const MAX_VERTICES = MAX_SHARDS * MAX_POLY * 3;
/** floats per shard: centre x, y, velocity x, y | spin (rad/s), start (s), tumble (rad/s), tumble axis (rad) */
export const SHARD_FLOATS = 8;
/** css px per second at which the cracks run out from the impact point */
export const CRACK_SPEED = 2600;
/** seconds every shard waits after the crack front has passed it */
export const CRACK_HOLD = 0.12;

/** Deterministic random numbers in [0, 1). @param {number} seed */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {{x: number, y: number}} impact  css px
 * @param {number} w @param {number} h  css px
 * @param {number} count
 * @param {() => number} rand
 * @returns {{x: number, y: number}[]}
 */
export function impactSeeds(impact, w, h, count, rand) {
  /** @type {{x: number, y: number}[]} */ const seeds = [];
  const diag = Math.hypot(w, h);
  for (let ring = 0; seeds.length < count && ring < 24; ring += 1) {
    const radius = diag * 0.035 * 1.55 ** ring;
    if (radius > diag * 1.2) break;
    const n = 5 + ring * 2;
    const phase = rand() * Math.PI * 2;
    for (let i = 0; i < n && seeds.length < count; i += 1) {
      const a = phase + ((i + (rand() - 0.5) * 0.6) * Math.PI * 2) / n;
      const r = radius * (0.75 + 0.5 * rand());
      const x = impact.x + Math.cos(a) * r, y = impact.y + Math.sin(a) * r;
      if (x > 0 && x < w && y > 0 && y < h) seeds.push({ x, y });
    }
  }
  while (seeds.length < count) seeds.push({ x: rand() * w, y: rand() * h });
  return seeds;
}

/**
 * Keep the part of `poly` where nx * x + ny * y <= c (Sutherland-Hodgman, one half-plane).
 * @param {number[][]} poly @param {number} nx @param {number} ny @param {number} c
 */
function clip(poly, nx, ny, c) {
  /** @type {number[][]} */ const out = [];
  for (let k = 0; k < poly.length; k += 1) {
    const a = poly[k], b = poly[(k + 1) % poly.length];
    const da = nx * a[0] + ny * a[1] - c, db = nx * b[0] + ny * b[1] - c;
    if (da <= 0) out.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/**
 * The Voronoi cell of seed `i` inside [0, w] x [0, h], with the orientation of the rectangle (positive area).
 * @param {{x: number, y: number}[]} seeds @param {number} i @param {number} w @param {number} h
 * @returns {number[][]}
 */
export function voronoiCell(seeds, i, w, h) {
  let poly = [[0, 0], [w, 0], [w, h], [0, h]];
  const s = seeds[i];
  for (let j = 0; j < seeds.length && poly.length; j += 1) {
    if (j === i) continue;
    const o = seeds[j];
    poly = clip(poly, o.x - s.x, o.y - s.y, (o.x * o.x + o.y * o.y - s.x * s.x - s.y * s.y) / 2);
  }
  return poly;
}

/** Area and centroid of a simple polygon. @param {number[][]} poly */
export function polygonCentroid(poly) {
  let area = 0, cx = 0, cy = 0;
  for (let k = 0; k < poly.length; k += 1) {
    const [x0, y0] = poly[k], [x1, y1] = poly[(k + 1) % poly.length];
    const cross = x0 * y1 - x1 * y0;
    area += cross; cx += (x0 + x1) * cross; cy += (y0 + y1) * cross;
  }
  area /= 2;
  return area === 0 ? { area: 0, x: poly[0]?.[0] ?? 0, y: poly[0]?.[1] ?? 0 } : { area, x: cx / (6 * area), y: cy / (6 * area) };
}

/**
 * Cells, fan triangles and motion of one shatter. Writes into the preallocated arrays and returns how many vertices and shards it wrote.
 * @param {{x: number, y: number}} impact  css px
 * @param {number} w @param {number} h  css px
 * @param {number} pieces  number of shards (clamped to MAX_SHARDS)
 * @param {number} seed
 * @param {Float32Array} vertices  MAX_VERTICES * VERTEX_FLOATS
 * @param {Float32Array} shards  MAX_SHARDS * SHARD_FLOATS
 */
export function buildShards(impact, w, h, pieces, seed, vertices, shards) {
  const rand = mulberry32(seed);
  const seeds = impactSeeds(impact, w, h, Math.max(1, Math.min(MAX_SHARDS, Math.round(pieces))), rand);
  const eps = 1e-3 * Math.max(w, h);
  const onBorder = (/** @type {number[]} */ a, /** @type {number[]} */ b) =>
    (Math.abs(a[0]) < eps && Math.abs(b[0]) < eps) || (Math.abs(a[0] - w) < eps && Math.abs(b[0] - w) < eps)
    || (Math.abs(a[1]) < eps && Math.abs(b[1]) < eps) || (Math.abs(a[1] - h) < eps && Math.abs(b[1] - h) < eps);
  let v = 0, count = 0;
  for (let i = 0; i < seeds.length; i += 1) {
    const poly = voronoiCell(seeds, i, w, h).slice(0, MAX_POLY);
    const c = polygonCentroid(poly);
    if (poly.length < 3 || !(c.area > 0)) continue;
    const id = count++;
    for (let k = 0; k < poly.length; k += 1) {
      const a = poly[k], b = poly[(k + 1) % poly.length];
      const info = id * 2 + (onBorder(a, b) ? 1 : 0);
      for (const [x, y, e] of [[c.x, c.y, 1], [a[0], a[1], 0], [b[0], b[1], 0]]) {
        vertices[v++] = x; vertices[v++] = y; vertices[v++] = info; vertices[v++] = e;
      }
    }
    const dx = c.x - impact.x, dy = c.y - impact.y;
    const dist = Math.hypot(dx, dy);
    const angle = dist > 1 ? Math.atan2(dy, dx) : rand() * Math.PI * 2;
    const burst = 520 * Math.exp(-dist / 260) + 60;
    const s = id * SHARD_FLOATS;
    shards[s] = c.x; shards[s + 1] = c.y;
    shards[s + 2] = Math.cos(angle) * burst + (rand() - 0.5) * 80;
    shards[s + 3] = Math.sin(angle) * burst - rand() * 140;
    shards[s + 4] = (rand() - 0.5) * 7 * (0.4 + burst / 580);
    shards[s + 5] = CRACK_HOLD + dist / CRACK_SPEED;
    shards[s + 6] = 1.5 + rand() * 3.5;
    shards[s + 7] = rand() * Math.PI;
  }
  return { vertexCount: v / VERTEX_FLOATS, shardCount: count };
}

/**
 * Where the point `home` of a shard is at physics time `t` (s): the twin of vs_shard. At t <= the shard's start it is `home` exactly.
 * @param {Float32Array|number[]} shards @param {number} id @param {{x: number, y: number}} home @param {number} t @param {number} gravity  css px/s^2
 */
export function shardPoint(shards, id, home, t, gravity) {
  const s = id * SHARD_FLOATS;
  const tau = Math.max(t - shards[s + 5], 0);
  let lx = home.x - shards[s], ly = home.y - shards[s + 1];
  const ax = Math.cos(shards[s + 7]), ay = Math.sin(shards[s + 7]);
  const along = (lx * ax + ly * ay) * (Math.cos(shards[s + 6] * tau) - 1);
  lx += ax * along; ly += ay * along;
  const cs = Math.cos(shards[s + 4] * tau), sn = Math.sin(shards[s + 4] * tau);
  return {
    x: shards[s] + lx * cs - ly * sn + shards[s + 2] * tau,
    y: shards[s + 1] + lx * sn + ly * cs + shards[s + 3] * tau + 0.5 * gravity * tau * tau,
  };
}
