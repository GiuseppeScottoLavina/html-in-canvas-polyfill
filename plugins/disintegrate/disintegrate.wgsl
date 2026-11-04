// Disintegrate (README.md): the content of the page (what differs from the dominant colour around it) erodes along an organic front and
// becomes dust of its LIVE colours, carried through a 3D curl-noise wind and seen in perspective (size, parallax, defocus), then flies back.
// Everything is a function of the dissolve amount g (0 assembled, 1 gone): nothing is simulated frame to frame, every frame cap agrees.
// Passes (index.js): fs_down + fs_bg the background estimate (when a transition starts or the page changes); cs_grains one compute thread
// per dust cell writes its grain's 24-byte record (or "none"); fs_base the page with its content eroded and heated at the front; vs_dust +
// fs_dust one instanced, antialiased quad per record, premultiplied; fs_full the host's passthrough (bit for bit) at rest.

struct Uniforms {
  resolution : vec2<f32>,  // backing px
  css : vec2<f32>,         // css px
  g : f32,                 // 0 assembled .. 1 gone
  fade : f32,              // fs_base: 1 the transition; reduced motion: the share of content still shown (the crossfade)
  cell : f32,              // dust cell, css px
  cols : f32,              // dust grid columns
  sweep : vec2<f32>,       // unit direction the erosion sweeps across the page
  sweep_min : f32,         // dot(corner, sweep) of the first corner reached
  sweep_span : f32,        // and the extent to the last one
  wind : vec2<f32>,        // unit, y down
  travel : f32,            // css px the wind carries a grain over its life
  turbulence : f32,
  time : f32,              // s: evolves the flow field and the glints (a function of g, so frames do not depend on the frame cap)
  seed : f32,
  sweep_end : f32,         // g at which every pixel of content has eroded
  life : f32,              // g by which every grain is gone (each lives from its birth until then)
  fragments : f32,         // share of the page that leaves as flakes before they crumble
  bg_cell : f32,           // css px per texel of the background estimate
  lo : f32,                // colour distance from the background where content starts
  hi : f32,                // ... and where it is fully content
  backdrop : vec4<f32>,    // fs_full: what a transparent source pixel shows (the host's clear colour)
  vanish : f32,            // 1: the dust fades out as it reaches g = 1 (the transition ends gone); 0: it turns back at full strength (play)
  depth : f32,             // 0..1: how far the grains travel in depth (parallax, focus)
  glow : f32,              // 0..1: the heat of the eroding front and of new grains
  focal : f32,             // css px from the camera to the page (perspective)
  glow_colour : vec4<f32>, // rgb: the colour of the heat; a: the strength of the defocus
  count : f32,             // dust cells
  shutter : f32,           // the exposure of the motion blur, in units of g (SHUTTER_MS of the way out)
  density : f32,           // share of the cells of content that leave as a visible grain (the rest is dust too fine to see)
  pad1 : f32,
}

@group(0) @binding(0) var<uniform> u : Uniforms;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var source : texture_2d<f32>;
@group(0) @binding(3) var background : texture_2d<f32>;   // fs_bg output (rgb), or fs_down output while fs_bg reads it
@group(1) @binding(0) var<storage, read_write> grains : array<u32>;   // cs_grains: 6 words per dust cell (the vertex buffer of vs_dust)

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

fn hash3(c : vec3<i32>) -> f32 {
  let h = pcg((bitcast<u32>(c.x) * 73856093u) ^ (bitcast<u32>(c.y) * 19349663u) ^ (bitcast<u32>(c.z) * 83492791u) ^ (u32(u.seed) * 2654435761u));
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

/** the analytic gradient of 3D value noise (d/dx, d/dy, d/dz) */
fn noise_grad(p : vec3<f32>) -> vec3<f32> {
  let i = vec3<i32>(floor(p));
  let f = fract(p);
  let w = f * f * (3.0 - 2.0 * f);
  let dw = 6.0 * f * (1.0 - f);
  let a = hash3(i);
  let b = hash3(i + vec3<i32>(1, 0, 0));
  let c = hash3(i + vec3<i32>(0, 1, 0));
  let d = hash3(i + vec3<i32>(1, 1, 0));
  let e = hash3(i + vec3<i32>(0, 0, 1));
  let f1 = hash3(i + vec3<i32>(1, 0, 1));
  let g1 = hash3(i + vec3<i32>(0, 1, 1));
  let h = hash3(i + vec3<i32>(1, 1, 1));
  let k1 = b - a;
  let k2 = c - a;
  let k3 = e - a;
  let k4 = a - b - c + d;
  let k5 = a - c - e + g1;
  let k6 = a - b - e + f1;
  let k7 = -a + b + c - d + e - f1 - g1 + h;
  return dw * vec3<f32>(k1 + k4 * w.y + k6 * w.z + k7 * w.y * w.z, k2 + k5 * w.z + k4 * w.x + k7 * w.z * w.x, k3 + k6 * w.x + k5 * w.y + k7 * w.x * w.y);
}

/** the curl of a vector potential made of three offset noise fields: a divergence-free flow (incompressible air), about unit magnitude */
fn curl3(p : vec3<f32>) -> vec3<f32> {
  let a = noise_grad(p);
  let b = noise_grad(p + vec3<f32>(31.4, 17.3, 7.9));
  let c = noise_grad(p + vec3<f32>(-11.7, 43.1, 23.3));
  return vec3<f32>(c.y - b.z, a.z - c.x, b.x - a.y) * 0.7;
}

fn luma(c : vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.299, 0.587, 0.114));
}

/** triangular dither of +-1 level (8-bit): smooth gradients (the heat, the crossfade) do not band */
fn dither(p : vec2<f32>) -> f32 {
  let c = vec2<i32>(floor(p));
  return (hash_cell(c, 91u) + hash_cell(c, 92u) - 1.0) / 255.0;
}

// ---- assembled: the host's passthrough -----------------------------------------------------------------------------------------------

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

/** the flake a point belongs to (6 css px squares); a share `fragments` of them leave whole */
fn flake_of(p : vec2<f32>) -> vec2<i32> {
  return vec2<i32>(floor(p / 6.0));
}

fn is_flake(chunk : vec2<i32>) -> bool {
  return hash_cell(chunk, 40u) < u.fragments;
}

/** g at which the content at p erodes: a sweep with an organic, domain-warped front, porous at the scale of a few pixels; a flake erodes whole */
fn erode_g(p0 : vec2<f32>) -> f32 {
  let chunk = flake_of(p0);
  let p = select(p0, (vec2<f32>(chunk) + 0.5) * 6.0, is_flake(chunk));
  let s = clamp((dot(p, u.sweep) - u.sweep_min) / max(u.sweep_span, 1.0), 0.0, 1.0);
  let warp = vec2<f32>(vnoise(p / 140.0 + 3.1), vnoise(p / 140.0 + 9.7)) * 90.0;
  let ragged = vnoise((p + warp) / 70.0) * 0.6 + vnoise((p + warp) / 21.0) * 0.4;
  let pores = vnoise(p / 2.3) * 0.55 + vnoise(p / 6.1) * 0.45;
  return clamp(s * 0.72 + ragged * 0.17 + pores * 0.11, 0.0, 1.0) * u.sweep_end;
}

@fragment
fn fs_base(v : FullOut) -> @location(0) vec4<f32> {
  let home = v.uv * u.css;
  let src = src_at(v.uv);
  let bg = bg_at(home);
  let k = content(src, bg);
  let dpx = v.position.xy;
  if (u.fade < 1.0) {
    // reduced motion: no grain moves; the content fades into the page and back
    return vec4<f32>(mix(bg, src, mix(1.0, u.fade, k)) + dither(dpx), 1.0);
  }
  let t = erode_g(home);
  let band = 0.09 * u.sweep_end;
  // just before it goes, the content heats and thins (its pores open); once gone, a faint afterglow where it was, cooling at once
  let ahead = t - u.g;                                    // > 0: not eroded yet
  let heat = (1.0 - smoothstep(0.0, band, ahead)) * step(0.0, ahead);
  let after = (1.0 - smoothstep(0.0, band * 0.8, -ahead)) * step(ahead, 0.0);
  let gone = select(0.0, 1.0, u.g >= t);
  let shown = (1.0 - gone) * (1.0 - 0.4 * heat);
  let hot = mix(src, u.glow_colour.rgb, 0.55) * 1.35;
  let heated = mix(src, hot, heat * u.glow * 0.8 * k);
  var col = mix(bg, heated, mix(1.0, shown, k));
  col += u.glow_colour.rgb * (after * 0.4 + heat * 0.35) * u.glow * k;
  return vec4<f32>(col + dither(dpx), 1.0);
}

// ---- the grains (compute) ----------------------------------------------------------------------------------------------------------

/** the velocity of the air at p (css px; z towards the viewer) for a grain of randoms r at age s, in css px per unit of age */
fn flow(p : vec3<f32>, s : f32, r : vec4<f32>) -> vec3<f32> {
  // a grain detaches gently and then rides the air: the speed ramps from rest (the displacement grows as s^1.6)
  let ramp = 1.6 * pow(max(s, 1e-4), 0.6);
  // little spread from grain to grain: the structure of the dust (wisps, filaments) is the structure of the air, not of the randoms
  let gust = vec3<f32>(u.wind * (0.8 + 0.4 * r.x), 0.0) * u.travel;
  let lift = vec3<f32>(0.0, -0.16 * (0.5 + r.y), (r.z * 2.0 - 1.0) * 0.45 * u.depth) * u.travel;
  let q = vec3<f32>(p.xy, p.z * 1.5) * 0.0042 + vec3<f32>(u.seed * 0.37, 0.0, u.time * 0.3);
  let swirl = (curl3(q) + 0.5 * curl3(q * 2.1 + 5.0) + 0.3 * curl3(q * 4.7 - 3.0)) * u.travel * 0.7 * u.turbulence;
  return (gust + lift + vec3<f32>(swirl.xy, swirl.z * u.depth)) * ramp;
}

/** the perspective of the camera: (screen point in css px, scale) of a point at depth z (css px towards the viewer) */
fn project(p : vec3<f32>) -> vec3<f32> {
  let z = min(p.z, 0.6 * u.focal);
  let k = u.focal / (u.focal - z);
  return vec3<f32>(u.css * 0.5 + (p.xy - u.css * 0.5) * k, k);
}

fn no_grain(i : u32) {
  grains[i * 6u + 4u] = 0u;                              // alpha 0: vs_dust skips the record
}

@compute @workgroup_size(256)
fn cs_grains(@builtin(global_invocation_id) id : vec3<u32>) {
  let i = id.x;
  if (i >= u32(u.count)) { return; }
  let cols = max(u32(u.cols), 1u);
  let c = vec2<i32>(i32(i % cols), i32(i / cols));
  let home = (vec2<f32>(c) + 0.5) * u.cell;
  if (home.y > u.css.y) { no_grain(i); return; }
  let t = erode_g(home);
  let a = (u.g - t) / max(u.life - t, 1e-3);
  if (a <= 0.0 || a >= 1.0) { no_grain(i); return; }      // still on the page, or gone
  // the grain is the live pixel: its colour now, and whether it is content now
  let src = src_at(home / u.css);
  let k = content(src, bg_at(home));
  if (k < 0.2) { no_grain(i); return; }
  // a share of the content crumbles into dust too fine to see: every cell lifts off whole, then only `density` of them stay visible (the
  // others fade out at the start of their flight)
  let fine = hash_cell(c, 25u) >= u.density;
  if (fine && a >= 0.15) { no_grain(i); return; }
  let rg = vec4<f32>(hash_cell(c, 21u), hash_cell(c, 22u), hash_cell(c, 23u), hash_cell(c, 24u));
  // a flake: its grains share the randoms of the flake (so the coherent flow carries them together) until it crumbles
  let chunk = flake_of(home);
  let flake = is_flake(chunk);
  let rc = vec4<f32>(hash_cell(chunk, 31u), hash_cell(chunk, 32u), hash_cell(chunk, 33u), rg.w);
  let crumble = select(-1.0, 0.1 + 0.25 * hash_cell(chunk, 41u), flake);

  // the path: the flow integrated from the cell (midpoint steps), read where the grain is, so it follows the streamlines of the air
  var p = vec3<f32>(home, 0.0);
  var vel = vec3<f32>(0.0);
  let steps = 5;
  let ds = a / f32(steps);
  for (var n = 0; n < steps; n += 1) {
    let s = (f32(n) + 0.5) * ds;
    let r = mix(rc, rg, smoothstep(crumble, crumble + 0.18, s));
    vel = flow(p, s, r);
    p += vel * ds;
  }
  let pr = project(p);
  let dpr = u.resolution.x / u.css.x;

  // the size: the cell itself at birth (the content lifts off whole), then a speck of its own size that crumbles finer as it travels;
  // nearer is bigger
  let birth = smoothstep(0.0, 0.16, a);
  var radius = u.cell * 0.5 * mix(1.0, 0.75 + 0.55 * rg.w, birth) * (1.0 - 0.4 * smoothstep(0.25, 1.0, a)) * pr.z;
  // out of focus off the page plane: the circle of confusion grows with the depth; the light of the grain spreads over it
  let coc = abs(p.z) / u.focal * 16.0 * u.glow_colour.a;
  let focused = radius;
  radius = sqrt(radius * radius + coc * coc);
  var alpha = k * (focused * focused) / (radius * radius);
  let soft = clamp(0.35 + coc / max(radius, 1e-3), 0.35, 1.0);
  // never smaller than half a device px: a smaller grain keeps its light (alpha) instead of flickering between pixels
  let minR = 0.5 / dpr;
  if (radius < minR) { alpha *= (radius / minR) * (radius / minR); radius = minR; }
  // motion blur: the screen distance covered during a fixed exposure (the same at every frame cap); its light spreads along the streak
  let screenVel = vel.xy * pr.z;
  let speed = length(screenVel);
  let dir = select(vec2<f32>(1.0, 0.0), screenVel / max(speed, 1e-4), speed > 1e-3);
  let streak = min(speed * u.shutter / max(u.life - t, 1e-3) * 0.5, 2.0 * radius + 1.0);
  alpha *= max(0.5, radius / (radius + streak));
  // when the transition ends gone, the dust thins out over the second half of its flight (it disperses below sight); a play's dust turns
  // back at full strength
  alpha *= 1.0 - u.vanish * smoothstep(0.5, 1.0, a);
  alpha *= select(1.0, 1.0 - smoothstep(0.03, 0.15, a), fine);
  // the colour of its pixel, a touch greyer as it thins to dust; dimmer far away (behind the page plane)
  var colour = mix(src, vec3<f32>(luma(src)) * 1.06 + 0.02, 0.12 * smoothstep(0.25, 1.0, a));
  colour *= 1.0 - 0.3 * smoothstep(0.0, 0.35 * u.focal, -p.z);
  // light: hot as it leaves the front, cooling fast; a few grains catch the light as they tumble (glints)
  let heat = u.glow * (1.0 - smoothstep(0.0, 0.22, a)) * k;
  let spin = 0.5 + 0.5 * sin(u.time * (9.0 + 16.0 * rg.y) + rg.z * 6.2832);
  let glint = select(0.0, pow(spin, 14.0) * 0.9 * smoothstep(0.1, 0.3, a), rg.w > 0.9) * k;
  let emit = mix(colour, u.glow_colour.rgb, 0.6) * heat * 1.2 + vec3<f32>(glint);
  let shape = 1.0 - birth;                                // square at birth (the cell), round in flight

  let base = i * 6u;
  grains[base] = bitcast<u32>(pr.x);
  grains[base + 1u] = bitcast<u32>(pr.y);
  grains[base + 2u] = pack4x8snorm(vec4<f32>(dir, soft * 2.0 - 1.0, shape * 2.0 - 1.0));
  grains[base + 3u] = pack2x16float(vec2<f32>(radius, streak));
  grains[base + 4u] = pack4x8unorm(vec4<f32>(clamp(colour, vec3<f32>(0.0), vec3<f32>(1.0)), max(clamp(alpha, 0.0, 1.0), 1.0 / 255.0)));
  grains[base + 5u] = pack4x8unorm(vec4<f32>(clamp(emit * 0.5, vec3<f32>(0.0), vec3<f32>(1.0)), 0.0));
}

// ---- the grains (drawn) ------------------------------------------------------------------------------------------------------------

struct DustOut {
  @builtin(position) position : vec4<f32>,
  @location(0) local : vec2<f32>,                       // css px from the grain's centre: x along its streak, y across
  @location(1) @interpolate(flat) shape : vec4<f32>,    // radius, half streak, edge softness, squareness
  @location(2) @interpolate(flat) colour : vec4<f32>,   // premultiplied: rgb * alpha, alpha
  @location(3) @interpolate(flat) emit : vec3<f32>,
}

@vertex
fn vs_dust(@builtin(vertex_index) vertex : u32, @location(0) ra : vec4<u32>, @location(1) rb : vec2<u32>) -> DustOut {
  var out : DustOut;
  out.position = vec4<f32>(2.0, 2.0, 0.0, 1.0);
  out.local = vec2<f32>(0.0);
  out.shape = vec4<f32>(0.0);
  out.colour = vec4<f32>(0.0);
  out.emit = vec3<f32>(0.0);
  let col = unpack4x8unorm(rb.x);
  if (col.a <= 0.0) { return out; }                      // no grain in this cell
  let centre = vec2<f32>(bitcast<f32>(ra.x), bitcast<f32>(ra.y));
  let d4 = unpack4x8snorm(ra.z);
  let rs = unpack2x16float(ra.w);
  let dir = normalize(d4.xy + vec2<f32>(1e-4, 0.0));
  let pad = u.css.x / u.resolution.x;                    // one device px around the shape: room for its antialiased edge
  var quad = array<vec2<f32>, 4>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, 1.0));
  let q = quad[vertex];
  let local = vec2<f32>(q.x * (rs.x + rs.y + pad), q.y * (rs.x + pad));
  let p = centre + dir * local.x + vec2<f32>(-dir.y, dir.x) * local.y;
  out.position = vec4<f32>(p.x / u.css.x * 2.0 - 1.0, 1.0 - p.y / u.css.y * 2.0, 0.0, 1.0);
  out.local = local;
  out.shape = vec4<f32>(rs.x, rs.y, d4.z * 0.5 + 0.5, d4.w * 0.5 + 0.5);
  out.colour = vec4<f32>(col.rgb * col.a, col.a);
  out.emit = unpack4x8unorm(rb.y).rgb * 2.0;
  return out;
}

@fragment
fn fs_dust(v : DustOut) -> @location(0) vec4<f32> {
  let r = v.shape.x;
  let l = v.shape.y;
  // the distance to the shape: a capsule along the streak (round), or the square of the cell at birth
  let along = max(abs(v.local.x) - l, 0.0);
  let d_round = length(vec2<f32>(along, v.local.y));
  let d_square = max(along, abs(v.local.y));
  let d = mix(d_round, d_square, v.shape.w);
  // analytic antialiasing: coverage over an edge 0.85 device px wide (a pixel's footprint across the edge); out of focus, a soft disc
  let px = u.css.x / u.resolution.x;
  let w = max(0.85 * px, r * v.shape.z);
  let cover = clamp((r - d) / w + 0.5, 0.0, 1.0);
  if (cover <= 0.0) { discard; }
  return vec4<f32>(v.colour.rgb * cover + v.emit * cover * v.colour.a, v.colour.a * cover);
}
