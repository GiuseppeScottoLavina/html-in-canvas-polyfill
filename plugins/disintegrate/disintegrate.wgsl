// Disintegrate (README.md): the content of the page turns to dust and blows away, the page stays. What is content is decided per pixel
// against an estimate of the local background (the colour most of the neighbourhood has: panels, cards, the page). A diagonal sweep erodes
// the content (it goes porous, then gone), and every eroded pixel becomes a grain of dust of its own LIVE colour, carried by the wind along
// swirling, streaking paths; some grains travel together as fragments for a moment before they crumble. Run backwards, the dust flies home
// and settles into the letters and fields of the page as it is NOW. Everything is a function of the dissolve amount g (0 assembled, 1 gone).
//
// Passes (index.js):
//   vs_full / fs_down   the source, averaged into cells of BG_CELL css px                      (when a transition starts or the page changes)
//   vs_full / fs_bg     the background estimate: per cell, the dominant colour around it (mean shift over a window of ~230 css px)
//   vs_full / fs_base   the page: the source where its content has not eroded yet, the background estimate where it has
//   vs_dust / fs_dust   one grain per DUST cell of content, instanced, alpha-blended over it
//   vs_full / fs_full   assembled: the host's passthrough formula (bit for bit); with `fade` < 1 the reduced-motion crossfade

struct Uniforms {
  resolution : vec2<f32>,  // backing px
  css : vec2<f32>,         // css px
  g : f32,                 // 0 assembled .. 1 gone
  fade : f32,              // fs_full: 1 the source; reduced motion: the share of content still shown
  cell : f32,              // dust cell, css px
  cols : f32,              // dust grid columns
  sweep : vec2<f32>,       // unit direction the erosion sweeps across the page
  sweep_min : f32,         // dot(corner, sweep) of the first corner reached
  sweep_span : f32,        // and the extent to the last one
  wind : vec2<f32>,        // unit, y down
  travel : f32,            // css px a grain travels over its life
  turbulence : f32,
  time : f32,              // s: drives nothing but the shimmer of the dust (a function of g, so frames do not depend on the frame cap)
  seed : f32,
  sweep_end : f32,         // g at which every pixel of content has eroded
  life : f32,              // g by which every grain is gone (each lives from its birth until then)
  fragments : f32,         // share of the grains that leave as fragments before they crumble
  bg_cell : f32,           // css px per texel of the background estimate
  lo : f32,                // colour distance from the background where content starts
  hi : f32,                // ... and where it is fully content
  backdrop : vec4<f32>,    // fs_full: what a transparent source pixel shows (the host's clear colour)
  vanish : f32,            // 1: the dust fades out as it reaches g = 1 (the transition ends gone); 0: it turns back at full strength (play)
  pad0 : f32,
  pad1 : f32,
  pad2 : f32,
}

@group(0) @binding(0) var<uniform> u : Uniforms;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var source : texture_2d<f32>;
@group(0) @binding(3) var background : texture_2d<f32>;   // fs_bg output (rgb), or fs_down output while fs_bg reads it

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

/** a divergence-free swirl: the curl of a noise field (unit-ish magnitude) */
fn curl(p : vec2<f32>) -> vec2<f32> {
  let e = 0.35;
  let dx = vnoise(p + vec2<f32>(e, 0.0)) - vnoise(p - vec2<f32>(e, 0.0));
  let dy = vnoise(p + vec2<f32>(0.0, e)) - vnoise(p - vec2<f32>(0.0, e));
  return vec2<f32>(dy, -dx) / (2.0 * e) * 1.6;
}

fn luma(c : vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.299, 0.587, 0.114));
}

// ---- assembled: the host's passthrough; reduced motion: the content fades into the page and back -----------------------------------

fn src_at(uv : vec2<f32>) -> vec3<f32> {
  let c = textureSampleLevel(source, samp, uv, 0.0);
  return mix(u.backdrop.rgb, c.rgb, c.a);
}

@fragment
fn fs_full(v : FullOut) -> @location(0) vec4<f32> {
  let c = textureSample(source, samp, v.uv);
  let picture = mix(u.backdrop.rgb, c.rgb, c.a);
  return vec4<f32>(picture, 1.0);
}

// ---- the background estimate -------------------------------------------------------------------------------------------------------

/** the source averaged over one cell of the estimate (16 taps) */
@fragment
fn fs_down(v : FullOut) -> @location(0) vec4<f32> {
  let cell = u.bg_cell / u.css;
  let base = floor(v.position.xy) * cell;
  var sum = vec3<f32>(0.0);
  for (var j = 0; j < 4; j += 1) {
    for (var i = 0; i < 4; i += 1) {
      sum += src_at(base + (vec2<f32>(f32(i), f32(j)) + 0.5) * cell * 0.25);
    }
  }
  return vec4<f32>(sum / 16.0, 1.0);
}

fn down_at(at : vec2<i32>, dims : vec2<i32>) -> vec3<f32> {
  return textureLoad(background, clamp(at, vec2<i32>(0), dims - 1), 0).rgb;
}

/** mean shift from `m` over 11 x 11 cells, 3 apart (a window of ~260 css px); returns the mode and its support (how much agrees with it) */
fn shift(m0 : vec3<f32>, at : vec2<i32>, dims : vec2<i32>) -> vec4<f32> {
  var m = m0;
  var support = 0.0;
  for (var step = 0; step < 3; step += 1) {
    var sum = vec3<f32>(0.0);
    var weight = 0.0;
    for (var j = -5; j <= 5; j += 1) {
      for (var i = -5; i <= 5; i += 1) {
        let c = down_at(at + vec2<i32>(i, j) * 3, dims);
        let d = c - m;
        let w = exp(-dot(d, d) / 0.005) / (1.0 + 0.015 * f32(i * i + j * j));
        sum += c * w;
        weight += w;
      }
    }
    if (weight > 1e-5) { m = sum / weight; }
    support = weight;
  }
  return vec4<f32>(m, support);
}

/** the dominant colour around a cell: the best supported of the modes reached from the mean and from the four corners of the window */
@fragment
fn fs_bg(v : FullOut) -> @location(0) vec4<f32> {
  let dims = vec2<i32>(textureDimensions(background));
  let at = vec2<i32>(floor(v.position.xy));
  var mean = vec3<f32>(0.0);
  for (var j = -5; j <= 5; j += 1) {
    for (var i = -5; i <= 5; i += 1) { mean += down_at(at + vec2<i32>(i, j) * 3, dims); }
  }
  var best = shift(mean / 121.0, at, dims);
  for (var k = 0; k < 4; k += 1) {
    let corner = vec2<i32>(select(-15, 15, (k & 1) == 1), select(-15, 15, (k & 2) == 2));
    let m = shift(down_at(at + corner, dims), at, dims);
    if (m.w > best.w * 1.05) { best = m; }
  }
  return vec4<f32>(best.rgb, 1.0);
}

// ---- content, and when it erodes ---------------------------------------------------------------------------------------------------

fn bg_at(p : vec2<f32>) -> vec3<f32> {
  return textureSampleLevel(background, samp, p / u.css, 0.0).rgb;
}

/** how much the pixel is content (differs from the background around it): 0 background, 1 content */
fn content(src : vec3<f32>, bg : vec3<f32>) -> f32 {
  return smoothstep(u.lo, u.hi, length(src - bg));
}

/** g at which the content at p erodes: a ragged diagonal sweep, porous at the scale of a few pixels */
fn erode_g(p : vec2<f32>) -> f32 {
  let s = clamp((dot(p, u.sweep) - u.sweep_min) / max(u.sweep_span, 1.0), 0.0, 1.0);
  let ragged = vnoise(p / 90.0) * 0.6 + vnoise(p / 23.0) * 0.4;
  let pores = vnoise(p / 2.2) * 0.55 + vnoise(p / 6.5) * 0.45;
  return clamp(s * 0.72 + ragged * 0.16 + pores * 0.12, 0.0, 1.0) * u.sweep_end;
}

@fragment
fn fs_base(v : FullOut) -> @location(0) vec4<f32> {
  let home = v.uv * u.css;
  let src = src_at(v.uv);
  let bg = bg_at(home);
  let k = content(src, bg);
  if (u.fade < 1.0) {
    // reduced motion: no grain moves; the content fades into the page and back
    return vec4<f32>(mix(bg, src, mix(1.0, u.fade, k)), 1.0);
  }
  let t = erode_g(home);
  // just before it goes, the content thins (its pores open): a short fade over the last 3 % of the sweep, then the background
  let thinning = smoothstep(t - 0.03 * u.sweep_end, t, u.g);
  let gone = select(0.0, 1.0, u.g >= t);
  let shown = (1.0 - gone) * (1.0 - 0.45 * thinning);
  return vec4<f32>(mix(bg, src, mix(1.0, shown, k)), 1.0);
}

// ---- dust ----------------------------------------------------------------------------------------------------------------------------

struct DustOut {
  @builtin(position) position : vec4<f32>,
  @location(0) corner : vec2<f32>,   // -1..1 across the grain, x along its streak
  @location(1) colour : vec3<f32>,
  @location(2) alpha : f32,
}

/** where a grain born at `home` is at age a (css px), and its gust: wind, a rising drift, the swirl of the air along the way */
fn dust_path(home : vec2<f32>, a : f32, r : vec4<f32>, chunk : vec2<i32>, frag : bool) -> vec2<f32> {
  // a fragment travels whole for its first moments, then crumbles: its grains share the chunk's motion until then
  var lead = 0.0;
  var p = home;
  if (frag) {
    let crumble = 0.12 + 0.2 * hash_cell(chunk, 41u);
    lead = min(a, crumble);
    let cr = vec2<f32>(hash_cell(chunk, 42u), hash_cell(chunk, 43u));
    p += (u.wind * (0.55 + 0.5 * cr.x) + vec2<f32>(0.0, -0.25)) * u.travel * 0.28 * lead * (1.0 + cr.y);
  }
  let b = max(a - lead, 0.0);
  let gust = u.wind * u.travel * pow(b, 1.6) * (0.45 + 0.9 * r.x) + vec2<f32>(0.0, -1.0) * u.travel * 0.22 * pow(b, 1.3) * r.y;
  // the swirl is read where the grain is on its way, so its path curls instead of only bending
  let q = (p + gust * 0.6) * 0.0065 + vec2<f32>(u.seed * 0.17, 0.0);
  let swirl = curl(q) * u.travel * 0.3 * u.turbulence * pow(b, 1.15) * (0.6 + 0.8 * r.z);
  return p + gust + swirl;
}

@vertex
fn vs_dust(@builtin(vertex_index) vertex : u32, @builtin(instance_index) grain : u32) -> DustOut {
  var out : DustOut;
  out.position = vec4<f32>(2.0, 2.0, 0.0, 1.0);
  out.corner = vec2<f32>(0.0);
  out.colour = vec3<f32>(0.0);
  out.alpha = 0.0;
  let cols = max(u32(u.cols), 1u);
  let c = vec2<i32>(i32(grain % cols), i32(grain / cols));
  let home = (vec2<f32>(c) + 0.5) * u.cell;
  if (home.y > u.css.y) { return out; }
  let t = erode_g(home);
  let a = (u.g - t) / max(u.life - t, 1e-3);
  if (a <= 0.0 || a >= 1.0) { return out; }               // still on the page, or gone
  // the grain is the live pixel: its colour now, and whether it is content now
  let src = src_at(home / u.css);
  let k = content(src, bg_at(home));
  if (k < 0.25) { return out; }
  let r = vec4<f32>(hash_cell(c, 21u), hash_cell(c, 22u), hash_cell(c, 23u), hash_cell(c, 24u));
  let chunk = vec2<i32>(floor(home / 7.0));
  let frag = hash_cell(chunk, 40u) < u.fragments;
  let p0 = dust_path(home, a, r, chunk, frag);
  let p1 = dust_path(home, min(a + 0.02, 1.0), r, chunk, frag);
  let vel = (p1 - p0) / 0.02;                                // css px per unit of age
  let speed = length(vel);
  let dir = select(vec2<f32>(1.0, 0.0), vel / max(speed, 1e-4), speed > 1e-3);
  // a grain is its cell at first (it IS the pixel), then a finer speck that streaks with its speed
  let size = u.cell * mix(1.05, 0.85 + 0.6 * r.w, smoothstep(0.0, 0.35, a));
  // half the grains streak with their speed (motion blur), the others stay round specks
  let streak = min(speed * 0.01 * step(0.45, r.w) * (r.w - 0.3), 6.0);
  var quad = array<vec2<f32>, 4>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, 1.0));
  let q = quad[vertex];
  let along = q.x * (size * 0.5 + streak);
  let across = q.y * size * 0.5;
  let p = p0 + dir * along + vec2<f32>(-dir.y, dir.x) * across - dir * streak * 0.5;
  out.position = vec4<f32>(p.x / u.css.x * 2.0 - 1.0, 1.0 - p.y / u.css.y * 2.0, 0.0, 1.0);
  out.corner = vec2<f32>(q.x, q.y);
  // the exact colour of its pixel, a touch lighter and greyer as it thins to dust
  out.colour = mix(src, vec3<f32>(luma(src)) * 1.08 + 0.03, 0.22 * smoothstep(0.3, 1.0, a));
  // a streak spreads the same grain over a longer line: its alpha thins with it
  let spread = (size * 0.5) / (size * 0.5 + streak);
  out.alpha = k * (1.0 - u.vanish * smoothstep(0.78, 1.0, a)) * mix(1.0, 0.65 + 0.35 * spread, smoothstep(0.0, 0.3, a));
  return out;
}

@fragment
fn fs_dust(v : DustOut) -> @location(0) vec4<f32> {
  // a square grain at birth (the pixel itself), a soft speck in flight
  let edge = 1.0 - smoothstep(0.55, 1.0, max(abs(v.corner.x), abs(v.corner.y)));
  let a = v.alpha * edge;
  if (a <= 0.003) { discard; }
  return vec4<f32>(v.colour, a);
}
