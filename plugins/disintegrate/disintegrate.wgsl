// Disintegrate (README.md): the form burns away like paper. A ragged front sweeps out from an origin (the Submit button, a side); ahead of
// it the paper scorches, on it a thin line glows, behind it the paper breaks into flakes (Voronoi cells that carry the exact pixels of the
// form) that lift, curl and burn from their rims; every pixel a flake loses becomes an ember of that pixel's colour, shed only where the
// form has content (text, borders, controls). Everything is a function of the dissolve amount g (0 assembled, 1 gone).

struct Uniforms {
  resolution : vec2<f32>,  // backing px
  css : vec2<f32>,
  g : f32,
  life : f32,              // share of g a flake lives once it lifts
  cell : f32,              // ember grid cell, backing px
  cols : f32,              // ember grid columns
  origin : vec2<f32>,      // css px: where the fire starts
  dmin : f32,              // css px: distance from the origin to the nearest point of the canvas
  dspan : f32,             // css px: from there to the farthest corner
  wind : vec2<f32>,        // unit, y down
  travel : f32,            // css px a flake drifts over its life
  turbulence : f32,
  flake : f32,             // flake cell, css px
  fcols : f32,             // flake grid columns
  glow_amount : f32,
  fade : f32,              // fs_full: 1 source, 0 backdrop
  seed : f32,
  front_end : f32,         // g at which the front has crossed the whole canvas
  plife : f32,             // share of g an ember lives
  density : f32,           // share of the content-free cells that still shed a speck of ash
  backdrop : vec4<f32>,
  glow : vec4<f32>,
}

@group(0) @binding(0) var<uniform> u : Uniforms;
@group(0) @binding(1) var source_sampler : sampler;
@group(0) @binding(2) var source : texture_2d<f32>;

// burn depth, css px behind the front: scorch ahead of it, the glowing line on it, char, then ash (transparent)
const SCORCH : f32 = 24.0;
const GLOW_W : f32 = 2.2;
const ASH : f32 = 17.0;
// EARLY_SHARE of the flakes break off when the front is still EARLY flake sizes short of their seed: they carry the intact form, the side
// that faced the fire scorched and glowing. The others burn in place (the glowing line passes over them) and lift LATE flake sizes behind it
// as charred ash.
const EARLY_SHARE : f32 = 0.45;
const EARLY : f32 = 0.6;
const LATE : f32 = -0.9;
// its rim starts burning at this age and moves inwards at RIM_SPEED flake sizes per life; the rim's burn depth counts RIM_SCALE times
// (a narrower glowing edge and char band than the front's)
const RIM_DELAY : f32 = 0.16;
const RIM_SPEED : f32 = 3.6;
const RIM_SCALE : f32 = 2.4;
// a flake is consumed by this age; its embers then still have plife to live (index.js checks that it all ends by g = 1)
const FLAKE_END : f32 = 0.75;
// the content (luminance) holds the front back by up to this many css px: letters and borders burn a moment after the paper around them
const INK_HOLD : f32 = 9.0;

struct FullOut {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
}

@vertex
fn vs_full(@builtin(vertex_index) index : u32) -> FullOut {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var out : FullOut;
  out.position = vec4<f32>(p[index], 0.0, 1.0);
  out.uv = vec2<f32>((p[index].x + 1.0) * 0.5, (1.0 - p[index].y) * 0.5);
  return out;
}

// The host's passthrough formula; fade = 1 returns it untouched (bit-exact assembled frame), < 1 is the reduced-motion crossfade.
@fragment
fn fs_full(v : FullOut) -> @location(0) vec4<f32> {
  let c = textureSample(source, source_sampler, v.uv);
  let picture = mix(u.backdrop.rgb, c.rgb, c.a);
  let faded = mix(u.backdrop.rgb, picture, u.fade);
  return vec4<f32>(select(faded, picture, u.fade >= 1.0), 1.0);
}

// Freezes the picture when a transition starts (rgba8unorm, the source's size: an exact copy).
@fragment
fn fs_copy(v : FullOut) -> @location(0) vec4<f32> {
  return textureSample(source, source_sampler, v.uv);
}

// ---- hashing and noise -------------------------------------------------------------------------------------------------------------

fn pcg(n : u32) -> u32 {
  let s = n * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

fn hash_cell(c : vec2<i32>, k : u32) -> f32 {
  let h = pcg((bitcast<u32>(c.x) * 73856093u) ^ (bitcast<u32>(c.y) * 19349663u) ^ (k * 83492791u) ^ (u32(u.seed) * 2654435761u));
  return f32(h) * (1.0 / 4294967295.0);
}

fn rnd(n : u32) -> f32 {
  return f32(pcg(n ^ (u32(u.seed) * 2654435761u))) * (1.0 / 4294967295.0);
}

fn vnoise(p : vec2<f32>) -> f32 {
  let i = vec2<i32>(floor(p));
  let f = fract(p);
  let s = f * f * (3.0 - 2.0 * f);
  let a = hash_cell(i, 1u);
  let b = hash_cell(i + vec2<i32>(1, 0), 1u);
  let c = hash_cell(i + vec2<i32>(0, 1), 1u);
  let d = hash_cell(i + vec2<i32>(1, 1), 1u);
  return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
}

fn fbm(p : vec2<f32>) -> f32 {
  return vnoise(p) * 0.55 + vnoise(p * 2.13 + vec2<f32>(13.1, 7.3)) * 0.3 + vnoise(p * 4.37 + vec2<f32>(3.7, 21.9)) * 0.15;
}

fn luma(c : vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.299, 0.587, 0.114));
}

// ---- the front -----------------------------------------------------------------------------------------------------------------------

/** g per css px of front travel */
fn front_speed() -> f32 {
  return 0.86 * u.front_end / max(u.dspan, 1.0);
}

/** g at which the front reaches p (css px), without the hold of the content: in [0, front_end] */
fn reach0(p : vec2<f32>) -> f32 {
  let dn = clamp((length(p - u.origin) - u.dmin) / max(u.dspan, 1.0), 0.0, 1.0);
  // a coherent, ragged edge: a slow wobble of the whole front plus the fine tear of the paper fibres
  let wobble = fbm(p / 150.0) - 0.5;
  let fibre = vnoise(p / 7.0) - 0.5;
  return clamp(dn * 0.86 + 0.07 + wobble * 0.09 + fibre * 0.012, 0.0, 1.0) * u.front_end;
}

/** the same with the hold of the content: bright pixels (text, borders) burn a little later */
fn reach(p : vec2<f32>, lum : f32) -> f32 {
  return min(reach0(p) + lum * INK_HOLD * front_speed(), u.front_end);
}

// ---- flakes: a jittered grid of seeds, one Voronoi cell per flake ------------------------------------------------------------------

fn cell_seed(c : vec2<i32>) -> vec2<f32> {
  let h = vec2<f32>(hash_cell(c, 11u), hash_cell(c, 12u));
  return (vec2<f32>(c) + 0.5 + (h - 0.5) * 0.72) * u.flake;
}

struct Vor {
  id : vec2<i32>,
  seed : vec2<f32>,
  edge : f32,   // css px to the nearest other cell
}

fn voronoi(p : vec2<f32>) -> Vor {
  let c0 = vec2<i32>(floor(p / u.flake));
  let last = vec2<i32>(i32(u.fcols) - 1, i32(ceil(u.css.y / u.flake)) - 1);
  var best = 1e9;
  var id = clamp(c0, vec2<i32>(0), last);
  var seed = cell_seed(id);
  for (var j = -1; j <= 1; j += 1) {
    for (var i = -1; i <= 1; i += 1) {
      let c = c0 + vec2<i32>(i, j);
      if (any(c < vec2<i32>(0)) || any(c > last)) { continue; }
      let s = cell_seed(c);
      let d = dot(p - s, p - s);
      if (d < best) { best = d; id = c; seed = s; }
    }
  }
  var edge = 1e9;
  for (var j = -1; j <= 1; j += 1) {
    for (var i = -1; i <= 1; i += 1) {
      let c = id + vec2<i32>(i, j);
      if ((i == 0 && j == 0) || any(c < vec2<i32>(0)) || any(c > last)) { continue; }
      let s = cell_seed(c);
      edge = min(edge, dot((s + seed) * 0.5 - p, normalize(s - seed)));
    }
  }
  return Vor(id, seed, edge);
}

/** g at which flake c (seed `seed`) lifts off */
fn detach_g(c : vec2<i32>, seed : vec2<f32>) -> f32 {
  let early = select(LATE, EARLY, hash_cell(c, 31u) < EARLY_SHARE);
  return clamp(reach0(seed) - early * u.flake * front_speed(), 0.0, u.front_end);
}

/** where the point `local` (css px from the seed) of flake `c` is at age tau: away from the fire and with the wind, rising, spinning, curling */
fn flake_point(c : vec2<i32>, seed : vec2<f32>, local : vec2<f32>, tau : f32) -> vec2<f32> {
  let r0 = hash_cell(c, 21u);
  let r1 = hash_cell(c, 22u);
  let r2 = hash_cell(c, 23u);
  let r3 = hash_cell(c, 24u);
  let axis_a = r0 * 3.14159265;
  let axis = vec2<f32>(cos(axis_a), sin(axis_a));
  let curl = cos(tau * (2.0 + 4.0 * r1));
  var l = local + axis * dot(local, axis) * (curl - 1.0);
  l = l * (1.0 - 0.25 * tau);
  let angle = (r2 - 0.5) * 5.0 * tau;
  let cs = cos(angle);
  let sn = sin(angle);
  l = vec2<f32>(l.x * cs - l.y * sn, l.x * sn + l.y * cs);
  let away = seed - u.origin;
  let dir = away / max(length(away), 1.0);
  let side = vec2<f32>(-dir.y, dir.x);
  let wobble = side * sin(tau * 7.0 + r3 * 6.2831853) * 10.0 * tau * u.turbulence;
  let drift = (dir * 0.45 + u.wind * 0.55) * u.travel * pow(tau, 1.25) * (0.55 + 0.8 * r3)
            + vec2<f32>(0.0, -0.3) * u.travel * tau * tau * (0.5 + r1);
  return seed + l + drift + wobble;
}

/** burn depth of the rim of a lifted flake at age tau, for a point `edge` css px inside it: irregular, from the outline inwards, starting
 *  on the side that faced the fire */
fn rim_depth(tau : f32, edge : f32, home : vec2<f32>, seed : vec2<f32>) -> f32 {
  let away = seed - u.origin;
  let lee = dot(home - seed, away / max(length(away), 1.0)) + 0.6 * u.flake;
  return ((tau - RIM_DELAY) * RIM_SPEED * u.flake - edge * (0.7 + 0.6 * vnoise(home * 0.21)) - lee * 0.8) * RIM_SCALE;
}

/** colour and alpha of the paper at burn depth b (css px behind the front; negative ahead of it) */
fn burn(src : vec3<f32>, b : f32, home : vec2<f32>, heat : f32) -> vec4<f32> {
  if (b < -SCORCH) { return vec4<f32>(src, 1.0); }
  let n = vnoise(home * 0.33);
  let s = smoothstep(-SCORCH, 0.0, b + (n - 0.5) * 6.0);
  var rgb = mix(src, src * vec3<f32>(0.62, 0.44, 0.3) + vec3<f32>(0.07, 0.035, 0.0), s * s * 0.9);
  let charred = smoothstep(GLOW_W * 0.5, GLOW_W * 2.2, b);
  rgb = mix(rgb, vec3<f32>(0.05, 0.036, 0.03), charred);
  let x = (b - GLOW_W * 0.45) / GLOW_W;
  let line = exp(-x * x * 2.0);
  let embers = smoothstep(0.72, 0.92, n) * charred * (1.0 - smoothstep(GLOW_W * 2.0, ASH * 0.6, b));
  rgb = rgb + u.glow.rgb * (line * 1.8 + embers * 0.8) * u.glow_amount * heat;
  let a = 1.0 - smoothstep(ASH - 3.5, ASH, b + (n - 0.5) * 5.0);
  return vec4<f32>(rgb, a);
}

// ---- the paper that has not lifted yet -------------------------------------------------------------------------------------------

/** g within which a pixel and the seed of its flake are reached by the front (they are at most ~1.2 flake apart) */
fn seed_margin() -> f32 {
  return 1.6 * u.flake * front_speed() + 0.02 * u.front_end;
}

@fragment
fn fs_base(v : FullOut) -> @location(0) vec4<f32> {
  let home = v.uv * u.css;
  let c = textureSampleLevel(source, source_sampler, v.uv, 0.0);
  let src = mix(u.backdrop.rgb, c.rgb, c.a);
  // most pixels are far from the front: untouched paper ahead of it, or already lifted (gone) behind it; only the band needs the flakes
  let here = reach0(home);
  let v_px = front_speed();
  if (u.g < here - (SCORCH + 2.0 + EARLY * u.flake) * v_px - seed_margin()) { return vec4<f32>(src, 1.0); }
  if (u.g > here - LATE * u.flake * v_px + seed_margin()) { return vec4<f32>(u.backdrop.rgb, 1.0); }
  let vo = voronoi(home);
  if (u.g >= detach_g(vo.id, vo.seed)) { return vec4<f32>(u.backdrop.rgb, 1.0); }   // its flake carries it now
  let b = (u.g - reach(home, luma(src))) / front_speed();
  let paper = burn(src, b, home, 1.0);
  return vec4<f32>(mix(u.backdrop.rgb, paper.rgb, paper.a), 1.0);
}

// ---- flakes ------------------------------------------------------------------------------------------------------------------------

struct FlakeOut {
  @builtin(position) position : vec4<f32>,
  @location(0) home : vec2<f32>,
  @location(1) @interpolate(flat) id : u32,
  @location(2) @interpolate(flat) gc : f32,
  @location(3) @interpolate(flat) tau : f32,
  @location(4) @interpolate(flat) shade : f32,
  @location(5) @interpolate(flat) seed : vec2<f32>,
  @location(6) @interpolate(flat) cell : vec2<i32>,
}

fn corner_of(vertex : u32) -> vec2<f32> {
  var corners = array<vec2<f32>, 6>(vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
                                     vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0));
  return corners[vertex];
}

fn to_clip(css_point : vec2<f32>) -> vec4<f32> {
  let p = css_point / u.css;
  return vec4<f32>(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
}

@vertex
fn vs_flake(@builtin(vertex_index) vertex : u32, @builtin(instance_index) flake : u32) -> FlakeOut {
  let fc = max(u32(u.fcols), 1u);
  let c = vec2<i32>(i32(flake % fc), i32(flake / fc));
  let seed = cell_seed(c);
  let gc = detach_g(c, seed);
  let tau = (u.g - gc) / u.life;
  let local = (corner_of(vertex) * 2.0 - 1.0) * 1.05 * u.flake;
  var out : FlakeOut;
  out.position = to_clip(flake_point(c, seed, local, clamp(tau, 0.0, 1.0)));
  out.home = seed + local;
  out.id = flake;
  out.gc = gc;
  out.tau = tau;
  let r1 = hash_cell(c, 22u);
  out.shade = 0.72 + 0.28 * abs(cos(clamp(tau, 0.0, 1.0) * (2.0 + 4.0 * r1)));
  out.seed = seed;
  out.cell = c;
  if (tau <= 0.0 || tau >= 1.0) { out.position = vec4<f32>(2.0, 2.0, 0.0, 1.0); }   // still on the paper, or gone: nothing to draw
  return out;
}

/** css px from p to the nearest other cell, or -1 when p is not in the cell of `own` (its seed `seed`): the 8 neighbours decide */
fn own_edge(p : vec2<f32>, own : vec2<i32>, seed : vec2<f32>) -> f32 {
  let last = vec2<i32>(i32(u.fcols) - 1, i32(ceil(u.css.y / u.flake)) - 1);
  let d0 = dot(p - seed, p - seed);
  var edge = 1e9;
  for (var j = -1; j <= 1; j += 1) {
    for (var i = -1; i <= 1; i += 1) {
      let c = own + vec2<i32>(i, j);
      if ((i == 0 && j == 0) || any(c < vec2<i32>(0)) || any(c > last)) { continue; }
      let s = cell_seed(c);
      if (dot(p - s, p - s) < d0) { return -1.0; }
      edge = min(edge, dot((s + seed) * 0.5 - p, normalize(s - seed)));
    }
  }
  return edge;
}

@fragment
fn fs_flake(v : FlakeOut) -> @location(0) vec4<f32> {
  let edge = own_edge(v.home, v.cell, v.seed);
  if (edge < 0.0) { discard; }
  let c = textureSampleLevel(source, source_sampler, v.home / u.css, 0.0);
  let src = mix(u.backdrop.rgb, c.rgb, c.a);
  // the burn the front left when the flake lifted (its glow cools as it flies), and the rim burning in
  let front = (v.gc - reach(v.home, luma(src))) / front_speed();
  let rim = rim_depth(v.tau, edge, v.home, v.seed);
  let paper = burn(src, max(front, rim), v.home, select(0.85, exp(-v.tau * 9.0), front > rim));
  let a = paper.a * (1.0 - smoothstep(FLAKE_END, 1.0, v.tau));
  if (a <= 0.003) { discard; }
  return vec4<f32>(paper.rgb * v.shade * (1.0 - 0.35 * v.tau), a);
}

// ---- embers: one per ember cell where the form has content, born when its pixel burns away -----------------------------------------
// Where, when, in which colour and how big an ember is born does not depend on g: cs_embers works it out once per phase of a transition
// (index.js dispatches it when the picture, the origin or the grids change) into a storage buffer, and vs_ember only ages it.

struct Ember {
  a : vec4<f32>,   // birth point (css px), g of birth (2: never), size (backing px)
  b : vec4<f32>,   // colour and luminance (pack4x8unorm), drift (css px over its life), alpha
}

@group(1) @binding(0) var<storage, read_write> ember_out : array<Ember>;
@group(1) @binding(1) var<storage, read> ember_in : array<Ember>;

fn load_rgb(p : vec2<i32>, dims : vec2<i32>) -> vec3<f32> {
  let c = textureLoad(source, clamp(p, vec2<i32>(0), dims - vec2<i32>(1)), 0);
  return mix(u.backdrop.rgb, c.rgb, c.a);
}

@compute @workgroup_size(64)
fn cs_embers(@builtin(global_invocation_id) gid : vec3<u32>) {
  let ember = gid.x;
  if (ember >= arrayLength(&ember_out)) { return; }
  var e : Ember;
  e.a = vec4<f32>(0.0, 0.0, 2.0, 0.0);
  e.b = vec4<f32>(0.0);
  let cols = max(u32(u.cols), 1u);
  let centre_px = (vec2<f32>(f32(ember % cols), f32(ember / cols)) + 0.5) * u.cell;
  if (centre_px.y > u.resolution.y) { ember_out[ember] = e; return; }
  let dpr = u.resolution.x / max(u.css.x, 1.0);
  let home = centre_px / dpr;
  // what the pixel holds: its colour, its brightness, and how much it differs from its neighbours (an edge of text, a border)
  let dims = vec2<i32>(textureDimensions(source));
  let tp = vec2<i32>(centre_px * vec2<f32>(dims) / u.resolution);
  let k = max(i32(round(1.5 * dpr)), 1);
  let src = load_rgb(tp, dims);
  let l = luma(src);
  let lx = luma(load_rgb(tp + vec2<i32>(k, 0), dims)) - luma(load_rgb(tp - vec2<i32>(k, 0), dims));
  let ly = luma(load_rgb(tp + vec2<i32>(0, k), dims)) - luma(load_rgb(tp - vec2<i32>(0, k), dims));
  let ink = clamp((abs(lx) + abs(ly)) * 2.6 + smoothstep(0.35, 0.8, l) * 0.8, 0.0, 1.0);
  let r0 = rnd(ember * 4u + 1u);
  let r1 = rnd(ember * 4u + 2u);
  let r2 = rnd(ember * 4u + 3u);
  let r3 = rnd(ember * 4u + 4u);
  if (ink < 0.16 && r0 > u.density * 0.12) { ember_out[ember] = e; return; }   // plain paper sheds only a few specks of ash
  // when its pixel turns to ash: on the paper (before its flake lifts), else on the flake as its rim burns in
  let vo = voronoi(home);
  let gc = detach_g(vo.id, vo.seed);
  let v = front_speed();
  var gs = reach(home, l) + ASH * v;
  var start = home;
  if (gs >= gc) {
    let away = vo.seed - u.origin;
    let lee = dot(home - vo.seed, away / max(length(away), 1.0)) + 0.6 * u.flake;
    let g2 = gc + (RIM_DELAY + (ASH / RIM_SCALE + vo.edge * (0.7 + 0.6 * vnoise(home * 0.21)) + lee * 0.8) / (RIM_SPEED * u.flake)) * u.life;
    let ts = clamp((g2 - gc) / u.life, 0.0, FLAKE_END);
    gs = gc + ts * u.life;
    start = flake_point(vo.id, vo.seed, home - vo.seed, ts);
  }
  gs = min(gs, 1.0 - u.plife);
  let swirl = (fbm(home / 90.0 + vec2<f32>(u.seed * 0.37, 0.0)) * 2.0 - 1.0) * 6.2831853 + r1 * 2.5;
  let drift = (u.wind * 0.55 + vec2<f32>(0.0, -0.75) + vec2<f32>(cos(swirl), sin(swirl)) * 0.6 * u.turbulence) * u.travel * 0.55 * (0.4 + 0.9 * r2);
  e.a = vec4<f32>(start, gs, u.cell * (0.5 + 0.9 * ink) * (0.7 + 0.6 * r3));
  e.b = vec4<f32>(bitcast<f32>(pack4x8unorm(vec4<f32>(src, l))), drift, 0.3 + 0.7 * max(ink, 0.25));
  ember_out[ember] = e;
}

struct EmberOut {
  @builtin(position) position : vec4<f32>,
  @location(0) corner : vec2<f32>,
  @location(1) colour : vec3<f32>,
  @location(2) alpha : f32,
}

@vertex
fn vs_ember(@builtin(vertex_index) vertex : u32, @builtin(instance_index) ember : u32) -> EmberOut {
  var out : EmberOut;
  // one triangle around the round dot: corners at twice the radius
  var tri = array<vec2<f32>, 3>(vec2<f32>(0.0, -2.0), vec2<f32>(1.7320508, 1.0), vec2<f32>(-1.7320508, 1.0));
  out.corner = tri[vertex];
  out.position = vec4<f32>(2.0, 2.0, 0.0, 1.0);
  out.colour = vec3<f32>(0.0);
  out.alpha = 0.0;
  let e = ember_in[ember];
  let age = (u.g - e.a.z) / u.plife;
  if (age <= 0.0 || age >= 1.0) { return out; }
  let dpr = u.resolution.x / max(u.css.x, 1.0);
  let size = e.a.w * (1.35 - 0.85 * age);
  let centre = (e.a.xy + e.b.yz * pow(age, 1.15)) * dpr;
  let p = centre + out.corner * size * 0.5;
  out.position = vec4<f32>(p.x / u.resolution.x * 2.0 - 1.0, 1.0 - p.y / u.resolution.y * 2.0, 0.0, 1.0);
  // born glowing in the colour of its pixel, cooling to grey ash
  let c = unpack4x8unorm(bitcast<u32>(e.b.x));
  let hot = 1.0 - smoothstep(0.05, 0.6, age);
  let ash = vec3<f32>(0.32, 0.3, 0.29) * (0.5 + c.w);
  out.colour = mix(mix(c.rgb, ash, smoothstep(0.45, 1.0, age)), u.glow.rgb * (1.3 + 0.6 * c.w) + c.rgb * 0.25, hot * u.glow_amount);
  out.alpha = (1.0 - smoothstep(0.55, 1.0, age)) * e.b.w;
  return out;
}

@fragment
fn fs_ember(v : EmberOut) -> @location(0) vec4<f32> {
  let d = length(v.corner);
  let a = v.alpha * (1.0 - smoothstep(0.55, 1.0, d));
  return vec4<f32>(v.colour, a);
}
