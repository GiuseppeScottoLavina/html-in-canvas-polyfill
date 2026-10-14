/**
 * The geometry and the physics of the shards, without GPU or DOM. PURE: Node tests exercise it directly.
 *
 *   spiderweb      the crack pattern: jagged spokes from the impact point and broken rings around it, every cell clipped to the canvas
 *   buildShards    every cell as a triangle fan for the vertex buffer, and the per-shard parameters (crack offset, fall) for the uniform block
 *   crackedLayout  the data of one crack pattern that the input mapper of the cracked pane reads (made once per crack, never per frame)
 *   crackedSource  the mapper of the cracked pane: the exact inverse of the per-shard offsets and of the refraction along the cracks
 *   shardPoint     the JavaScript twin of vs_shard in shatter.wgsl: where a point of a shard is at physics time t
 * Everything here runs once per crack (when it starts), except crackedSource, which runs per pointer event.
 */

/** shard capacity of the uniform block (shatter.wgsl: 4 vec4 per shard) */
export const MAX_SHARDS = 160;
/** vertices per cell at most: a merged cell that would have more is kept as its separate cells (checked by the tests) */
export const MAX_POLY = 20;
/** floats per vertex: home x, y (css px) | shard * 2 + border flag | edge factor (1 at the fan centre, 0 on the outer edge) | inward normal
 *  x, y of the outer edge | distance from the fan centre to that edge (css px) | unused */
export const VERTEX_FLOATS = 8;
/** a fan has one triangle per edge; a cell cut into ears has 3 per ear (MAX_POLY - 2 ears) */
export const MAX_VERTICES = MAX_SHARDS * (MAX_POLY - 2) * 3 * 3;
/** floats per shard: centre x, y, crack offset x, y | velocity x, y, z (css px/s), start (s) | spin axis x, y, z, spin (rad/s) | tilt x, y,
 *  distance from the impact (css px), random */
export const SHARD_FLOATS = 16;
/** within this many css px of a crack the glass bends the picture (the bevel of the broken edge) */
export const BEVEL = 7;
/** the share of the fall timeline in which the cracks spread (way out) or close again (way back); no shard moves before it ends */
export const HEAL = 0.1;
/** physics seconds one way of the fall plays (g = 1 is SPAN seconds after the second impact) */
export const SPAN = 1.7;
/** css px per second at which the shards start to fall away from the impact point */
export const FALL_WAVE = 2600;
/** seconds between the ghost copies of a falling shard (the motion blur) */
export const GHOST_DT = 0.012;

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

/** @param {number[][]} poly @param {number} w @param {number} h */
const clipToRect = (poly, w, h) => clip(clip(clip(clip(poly, -1, 0, 0), 1, 0, w), 0, -1, 0), 0, 1, h);

/** Area (positive counter-clockwise in y-down screen space means clockwise on screen) and centroid. @param {number[][]} poly */
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
 * Ear clipping of a simple counter-clockwise polygon: index triples, each counter-clockwise. For the rare cell that no fan centre sees whole.
 * @param {number[][]} poly
 * @returns {number[][]}
 */
function earClip(poly) {
  const cross = (/** @type {number[]} */ o, /** @type {number[]} */ a, /** @type {number[]} */ b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const idx = poly.map((_, i) => i);
  /** @type {number[][]} */ const out = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 1000) {
    let cut = -1;
    for (let k = 0; k < idx.length && cut < 0; k += 1) {
      const [i, j, l] = [idx[(k + idx.length - 1) % idx.length], idx[k], idx[(k + 1) % idx.length]];
      if (!(cross(poly[i], poly[j], poly[l]) > 0)) continue;
      const inside = idx.some((m) => m !== i && m !== j && m !== l
        && cross(poly[i], poly[j], poly[m]) >= 0 && cross(poly[j], poly[l], poly[m]) >= 0 && cross(poly[l], poly[i], poly[m]) >= 0);
      if (!inside) cut = k;
    }
    if (cut < 0) break;
    out.push([idx[(cut + idx.length - 1) % idx.length], idx[cut], idx[(cut + 1) % idx.length]]);
    idx.splice(cut, 1);
  }
  if (idx.length === 3) out.push(idx.slice());
  return out;
}

/** a fan centre that sees every edge from the inside (all fan triangles positive), or null @param {number[][]} poly */
function fanCentre(poly) {
  const c = polygonCentroid(poly);
  const avg = poly.reduce((s, p) => [s[0] + p[0] / poly.length, s[1] + p[1] / poly.length], [0, 0]);
  const candidates = [[c.x, c.y], avg, ...poly.map((p) => [(p[0] + c.x * 3) / 4, (p[1] + c.y * 3) / 4])];
  for (const [x, y] of candidates) {
    let ok = true;
    for (let k = 0; k < poly.length && ok; k += 1) {
      const a = poly[k], b = poly[(k + 1) % poly.length];
      ok = (a[0] - x) * (b[1] - y) - (a[1] - y) * (b[0] - x) > 0;
    }
    if (ok) return { x, y };
  }
  return null;
}

/**
 * The crack pattern of one impact: `spokes` jagged radial cracks and broken rings around the impact, each cell clipped to [0, w] x [0, h].
 * The cells are an exact partition of the canvas (checked), oriented counter-clockwise in y-down coordinates (positive area).
 * @param {{x: number, y: number}} impact  css px
 * @param {number} w @param {number} h  css px
 * @param {number} spokes
 * @param {() => number} rand
 * @returns {{poly: number[][], ring: number}[]}
 */
export function spiderweb(impact, w, h, spokes, rand) {
  const diag = Math.hypot(w, h);
  const far = Math.max(Math.hypot(impact.x, impact.y), Math.hypot(w - impact.x, impact.y), Math.hypot(impact.x, h - impact.y), Math.hypot(w - impact.x, h - impact.y));
  const S = Math.max(3, Math.round(spokes));
  const phase = rand() * Math.PI * 2;
  const angles = Array.from({ length: S }, (_, j) => phase + ((j + (rand() - 0.5) * 0.5) * Math.PI * 2) / S);
  /** @type {number[]} */ const radii = [0];
  let r = diag * 0.03 * (0.85 + 0.3 * rand());
  while (r < far * 1.02 && radii.length < 9) { radii.push(r); r *= 1.55 + 0.25 * rand(); }
  radii.push(Math.max(r, far * 1.3) * 1.2);   // the last ring lies outside the canvas: the outer cells reach its border
  const K = radii.length - 1;
  const slot = (Math.PI * 2) / S;
  // ring vertices: on each spoke, at each ring, with a little angular and radial jitter (the spokes zigzag)
  const V = angles.map((a) => radii.map((rk, k) => {
    if (k === 0) return [impact.x, impact.y];
    const jit = k === K ? 0 : (rand() - 0.5) * 0.16 * slot;
    const rr = k === K ? rk : rk * (0.83 + 0.34 * rand());
    return [impact.x + Math.cos(a + jit) * rr, impact.y + Math.sin(a + jit) * rr];
  }));
  // ring midpoints: the rings are broken arcs, bulging out or in a little
  const M = angles.map((_, j) => radii.map((_r, k) => {
    if (k === 0) return null;
    const a = V[j][k], b = V[(j + 1) % S][k];
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const dx = mx - impact.x, dy = my - impact.y, d = Math.hypot(dx, dy) || 1;
    const push = k === K ? 0.35 * Math.hypot(b[0] - a[0], b[1] - a[1]) : (rand() - 0.35) * 0.16 * Math.hypot(b[0] - a[0], b[1] - a[1]);
    return [mx + (dx / d) * push, my + (dy / d) * push];
  }));
  /** @param {number[][]} raw */
  const finish = (raw) => {
    let poly = raw;
    if (polygonCentroid(poly).area < 0) poly = poly.slice().reverse();
    return clipToRect(poly, w, h).filter((p, i, all) => {
      const q = all[(i + 1) % all.length];
      return Math.abs(p[0] - q[0]) > 1e-9 || Math.abs(p[1] - q[1]) > 1e-9;
    });
  };
  /** the cell of wedge j between rings a and b (a < b): the inner arc, up spoke j + 1, the outer arc, down spoke j @param {number} j @param {number} a @param {number} b */
  const wedge = (j, a, b) => {
    const n = (j + 1) % S;
    /** @type {number[][]} */ const raw = a === 0 ? [V[j][0]] : [V[j][a], /** @type {number[]} */ (M[j][a]), V[n][a]];
    for (let k = a + 1; k <= b; k += 1) raw.push(V[n][k]);
    raw.push(/** @type {number[]} */ (M[j][b]));
    for (let k = b; k > a; k -= 1) raw.push(V[j][k]);
    return finish(raw);
  };
  /** @type {{poly: number[][], ring: number}[]} */ const cells = [];
  /** @param {number[][]} poly @param {number} ring */
  const keep = (poly, ring) => { if (poly.length >= 3 && polygonCentroid(poly).area > 1e-9) cells.push({ poly, ring }); };
  for (let j = 0; j < S; j += 1) {
    // a ring crack between two spokes is there near the impact, and more and more often missing farther out: the cells on both sides
    // of a missing one are one shard. A merged cell that no fan centre can see whole is kept as its separate cells instead.
    let a = 0;
    for (let k = 1; k <= K; k += 1) {
      const present = k === K || k <= 2 || rand() < 0.95 - 0.13 * k;
      if (!present) continue;
      const merged = wedge(j, a, k);
      if (k - a === 1 || (merged.length <= MAX_POLY && fanCentre(merged))) keep(merged, a);
      else for (let m = a; m < k; m += 1) keep(wedge(j, m, m + 1), m);
      a = k;
    }
  }
  return cells;
}

/**
 * Cells, fan triangles and per-shard parameters of one crack. Writes into the preallocated arrays and returns how many vertices and shards
 * it wrote. A cell that no fan centre can see whole (none was found in the tests) would be dropped, never drawn inside out.
 * @param {{x: number, y: number}} impact  css px
 * @param {number} w @param {number} h  css px
 * @param {number} spokes  number of radial cracks
 * @param {number} seed
 * @param {Float32Array} vertices  MAX_VERTICES * VERTEX_FLOATS
 * @param {Float32Array} shards  MAX_SHARDS * SHARD_FLOATS
 */
export function buildShards(impact, w, h, spokes, seed, vertices, shards) {
  const rand = mulberry32(seed);
  const cells = spiderweb(impact, w, h, spokes, rand);
  const eps = 1e-3 * Math.max(w, h);
  const onBorder = (/** @type {number[]} */ a, /** @type {number[]} */ b) =>
    (Math.abs(a[0]) < eps && Math.abs(b[0]) < eps) || (Math.abs(a[0] - w) < eps && Math.abs(b[0] - w) < eps)
    || (Math.abs(a[1]) < eps && Math.abs(b[1]) < eps) || (Math.abs(a[1] - h) < eps && Math.abs(b[1] - h) < eps);
  let v = 0, count = 0;
  /** one fan triangle: centre (edge factor 1), and the outer edge a -> b @param {number} id @param {{x: number, y: number}} c @param {number[]} a @param {number[]} b @param {boolean} crack */
  const emit = (id, c, a, b, crack) => {
    const info = id * 2 + (crack && !onBorder(a, b) ? 0 : 1);   // flag 1: no crack along this edge (the canvas border, or a seam inside a cell)
    const ex = b[0] - a[0], ey = b[1] - a[1], len = Math.hypot(ex, ey) || 1;
    let nx = -ey / len, ny = ex / len;                                 // a normal of the edge, turned towards the fan centre
    if (nx * (c.x - a[0]) + ny * (c.y - a[1]) < 0) { nx = -nx; ny = -ny; }
    const hgt = nx * (c.x - a[0]) + ny * (c.y - a[1]);
    for (const [x, y, e] of [[c.x, c.y, 1], [a[0], a[1], 0], [b[0], b[1], 0]]) {
      vertices[v++] = x; vertices[v++] = y; vertices[v++] = info; vertices[v++] = e;
      vertices[v++] = nx; vertices[v++] = ny; vertices[v++] = hgt; vertices[v++] = 0;
    }
  };
  for (const cell of cells) {
    if (count >= MAX_SHARDS) break;
    const poly = cell.poly;
    if (poly.length > MAX_POLY) continue;
    const id = count++;
    const c = fanCentre(poly);
    if (c) for (let k = 0; k < poly.length; k += 1) emit(id, c, poly[k], poly[(k + 1) % poly.length], true);
    else {
      // no point sees the whole cell: cut it into ears, and fan each ear from its own centre; only the cell's own edges are cracks
      for (const [i, j, l] of earClip(poly)) {
        const e = { x: (poly[i][0] + poly[j][0] + poly[l][0]) / 3, y: (poly[i][1] + poly[j][1] + poly[l][1]) / 3 };
        const edge = (/** @type {number} */ p, /** @type {number} */ q) => (q - p + poly.length) % poly.length === 1;
        emit(id, e, poly[i], poly[j], edge(i, j)); emit(id, e, poly[j], poly[l], edge(j, l)); emit(id, e, poly[l], poly[i], edge(l, i));
      }
    }
    const centre = polygonCentroid(poly);
    const dx = centre.x - impact.x, dy = centre.y - impact.y;
    const dist = Math.hypot(dx, dy);
    const angle = dist > 1 ? Math.atan2(dy, dx) : rand() * Math.PI * 2;
    const ux = Math.cos(angle), uy = Math.sin(angle);
    const s = id * SHARD_FLOATS;
    // the cracked pane: each piece pushed a little away from the impact (more near it) and sagging under its weight
    const push = 1.1 + 3.4 * Math.exp(-dist / 150) + rand() * 0.9;
    const turn = (rand() - 0.5) * 0.7;
    shards[s] = centre.x; shards[s + 1] = centre.y;
    shards[s + 2] = (ux * Math.cos(turn) - uy * Math.sin(turn)) * push;
    shards[s + 3] = (ux * Math.sin(turn) + uy * Math.cos(turn)) * push + 0.35;
    // the fall: out from the impact, towards the viewer, spinning about a tilted axis, after the wave from the impact has reached it
    const burst = 130 + 560 * Math.exp(-dist / 260) + rand() * 90;
    shards[s + 4] = ux * burst + (rand() - 0.5) * 70;
    shards[s + 5] = uy * burst - rand() * 150;
    shards[s + 6] = (50 + 330 * Math.exp(-dist / 240)) * (0.3 + rand());
    shards[s + 7] = HEAL * SPAN + 0.02 + dist / FALL_WAVE + rand() * 0.05;
    const axisAngle = rand() * Math.PI * 2, lift = (rand() - 0.5) * 0.7;
    const an = Math.hypot(1, lift);
    shards[s + 8] = Math.cos(axisAngle) / an; shards[s + 9] = Math.sin(axisAngle) / an; shards[s + 10] = lift / an;
    shards[s + 11] = (2 + 9 * Math.exp(-dist / 300)) * (0.6 + 0.8 * rand()) * (rand() < 0.5 ? -1 : 1);
    // the pieces of a cracked pane sit at slightly different angles: each catches the light its own way
    shards[s + 12] = (rand() - 0.5) * 0.22; shards[s + 13] = (rand() - 0.5) * 0.22;
    shards[s + 14] = dist; shards[s + 15] = rand();
  }
  return { vertexCount: v / VERTEX_FLOATS, shardCount: count };
}

/**
 * The data the mapper of a cracked pane reads, copied once per crack (the preallocated GPU staging arrays are reused by the next crack).
 * @param {Float32Array} vertices @param {number} vertexCount @param {Float32Array} shards @param {number} shardCount
 * @param {number} refract  css px the picture bends at a crack (the `refraction` option)
 */
export function crackedLayout(vertices, vertexCount, shards, shardCount, refract) {
  const tri = vertices.slice(0, vertexCount * VERTEX_FLOATS);
  const data = shards.slice(0, shardCount * SHARD_FLOATS);
  /** first triangle of each shard, and its bounding box where it is drawn (offset applied): [x0, y0, x1, y1] */
  const first = new Int32Array(shardCount + 1);
  const box = new Float64Array(shardCount * 4).fill(NaN);
  for (let t = 0, n = vertexCount / 3; t < n; t += 1) {
    const id = Math.floor(tri[t * 3 * VERTEX_FLOATS + 2] / 2);
    first[id + 1] = t + 1;
    for (let k = 0; k < 3; k += 1) {
      const o = (t * 3 + k) * VERTEX_FLOATS;
      const x = tri[o] + data[id * SHARD_FLOATS + 2], y = tri[o + 1] + data[id * SHARD_FLOATS + 3];
      const b = id * 4;
      box[b] = Number.isNaN(box[b]) ? x : Math.min(box[b], x); box[b + 1] = Number.isNaN(box[b + 1]) ? y : Math.min(box[b + 1], y);
      box[b + 2] = Number.isNaN(box[b + 2]) ? x : Math.max(box[b + 2], x); box[b + 3] = Number.isNaN(box[b + 3]) ? y : Math.max(box[b + 3], y);
    }
  }
  for (let i = 1; i <= shardCount; i += 1) first[i] = Math.max(first[i], first[i - 1]);
  return Object.freeze({ tri, data, first, box, shardCount, refract });
}

/**
 * The mapper of the cracked pane (every shard fully cracked, nothing falling): the source point that the presented pixel at `p` shows. The
 * twin of vs_shard and fs_shard at time 0: shards are drawn in order (a later one covers an earlier one where their offsets overlap), each
 * moved by its offset, and near an inner edge the picture is bent along the inward normal. Between shards (the open crack) the pane shows
 * the picture in place, dimmed: the identity. PURE.
 * @param {ReturnType<typeof crackedLayout>} L @param {{x: number, y: number}} p
 * @returns {{x: number, y: number}}
 */
export function crackedSource(L, p) {
  const { tri, data, first, box } = L;
  for (let id = L.shardCount - 1; id >= 0; id -= 1) {
    const b = id * 4;
    if (!(p.x >= box[b] - 1e-6 && p.x <= box[b + 2] + 1e-6 && p.y >= box[b + 1] - 1e-6 && p.y <= box[b + 3] + 1e-6)) continue;
    const qx = p.x - data[id * SHARD_FLOATS + 2], qy = p.y - data[id * SHARD_FLOATS + 3];
    for (let t = first[id + 1] - 1; t >= first[id]; t -= 1) {
      const o = t * 3 * VERTEX_FLOATS;
      const ax = tri[o], ay = tri[o + 1];
      const bx = tri[o + VERTEX_FLOATS], by = tri[o + VERTEX_FLOATS + 1];
      const cx = tri[o + 2 * VERTEX_FLOATS], cy = tri[o + 2 * VERTEX_FLOATS + 1];
      const d1 = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax);
      const d2 = (cx - bx) * (qy - by) - (cy - by) * (qx - bx);
      const d3 = (ax - cx) * (qy - cy) - (ay - cy) * (qx - cx);
      if ((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0)) continue;
      const border = tri[o + 2] - Math.floor(tri[o + 2] / 2) * 2;
      const nx = tri[o + 4], ny = tri[o + 5];
      const de = nx * (qx - bx) + ny * (qy - by);   // css px to the outer edge (b, c) of this fan triangle
      if (border < 0.5 && de < BEVEL) {
        const k = 1 - Math.max(0, de) / BEVEL;
        return { x: qx + nx * L.refract * k * k, y: qy + ny * L.refract * k * k };
      }
      return { x: qx, y: qy };
    }
  }
  return { x: p.x, y: p.y };
}

/**
 * Rotate v about the unit axis a by angle (Rodrigues). @param {number[]} v @param {number[]} a @param {number} angle
 * @returns {number[]}
 */
function rotate(v, a, angle) {
  const c = Math.cos(angle), s = Math.sin(angle), d = (a[0] * v[0] + a[1] * v[1] + a[2] * v[2]) * (1 - c);
  return [v[0] * c + (a[1] * v[2] - a[2] * v[1]) * s + a[0] * d, v[1] * c + (a[2] * v[0] - a[0] * v[2]) * s + a[1] * d, v[2] * c + (a[0] * v[1] - a[1] * v[0]) * s + a[2] * d];
}

/**
 * Where the point `home` of shard `id` is drawn at physics time `t` (s), with the cracks at `k` (0 closed, 1 fully open): the twin of vs_shard
 * (perspective about the canvas centre, focal length `focal` css px). Before the shard starts to fall it is home + k * its offset, exactly.
 * @param {Float32Array|number[]} shards @param {number} id @param {{x: number, y: number}} home @param {number} t
 * @param {{gravity: number, focal: number, width: number, height: number, k?: number}} o
 */
export function shardPoint(shards, id, home, t, o) {
  const s = id * SHARD_FLOATS;
  const k = o.k ?? 1;
  const tau = Math.max(t - shards[s + 7], 0);
  if (tau <= 0) return { x: home.x + shards[s + 2] * k, y: home.y + shards[s + 3] * k };
  const r = rotate([home.x - shards[s], home.y - shards[s + 1], 0], [shards[s + 8], shards[s + 9], shards[s + 10]], shards[s + 11] * tau);
  const x = shards[s] + shards[s + 2] * k + r[0] + shards[s + 4] * tau;
  const y = shards[s + 1] + shards[s + 3] * k + r[1] + shards[s + 5] * tau + 0.5 * o.gravity * tau * tau;
  const z = Math.min(r[2] + shards[s + 6] * tau, 0.8 * o.focal);
  const scale = o.focal / (o.focal - z);
  return { x: o.width / 2 + (x - o.width / 2) * scale, y: o.height / 2 + (y - o.height / 2) * scale };
}
