// CRT monitor. Lengths in CSS px of the presented frame. mapCrtPoint() in index.js is the JavaScript twin of the barrel and of the
// screen mask below: same formula, same rounded screen corners. The interlace (index.js) moves samples by under half a line, never the barrel.
struct U {
  res : vec2<f32>,     // presented size, backing px
  css : vec2<f32>,     // presented size, CSS px
  k : f32,             // barrel strength
  bezel : f32,         // bezel width
  corner : f32,        // screen corner radius (source px)
  ready : f32,
  scanlines : f32,     // 0..1
  glow : f32,          // 0..1
  flicker : f32,       // 0..1 (0 with prefers-reduced-motion)
  mis : f32,           // red / blue misconvergence, CSS px
  time : f32,          // seconds
  interlace : f32,
  parity : f32,        // field drawn now: 0 even lines, 1 odd
  history : f32,       // 1: hist = source of the previous field
}

@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var src : texture_2d<f32>;
@group(0) @binding(3) var hist : texture_2d<f32>;

const BG = vec3<f32>(0.012, 0.016, 0.02);
const FIELD_SHIFT = 0.3;   // odd field offset, CSS px

@vertex
fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(p[i], 0.0, 1.0);
}

fn sd_box(d : vec2<f32>, h : vec2<f32>, r : f32) -> f32 {
  let q = abs(d) - h + vec2<f32>(r);
  return min(max(q.x, q.y), 0.0) + length(max(q, vec2<f32>(0.0))) - r;
}

fn tap(p : vec2<f32>) -> vec3<f32> {
  let c = textureSampleLevel(src, samp, clamp(p / u.css, vec2<f32>(0.0), vec2<f32>(1.0)), 0.0);
  return mix(BG, c.rgb, c.a);
}

fn tap_old(p : vec2<f32>) -> vec3<f32> {
  if (u.history < 0.5) { return tap(p); }
  let c = textureSampleLevel(hist, samp, clamp(p / u.css, vec2<f32>(0.0), vec2<f32>(1.0)), 0.0);
  return mix(BG, c.rgb, c.a);
}

// one sample with the red / blue misconvergence (red and blue land to each side of green)
fn beam(p : vec2<f32>, old : bool) -> vec3<f32> {
  if (old) {
    if (u.mis > 0.0) { return vec3<f32>(tap_old(p + vec2<f32>(u.mis, 0.0)).r, tap_old(p).g, tap_old(p - vec2<f32>(u.mis, 0.0)).b); }
    return tap_old(p);
  }
  if (u.mis > 0.0) { return vec3<f32>(tap(p + vec2<f32>(u.mis, 0.0)).r, tap(p).g, tap(p - vec2<f32>(u.mis, 0.0)).b); }
  return tap(p);
}

// eight taps on a circle of radius r around p
fn ring(p : vec2<f32>, r : f32) -> vec3<f32> {
  let a = r * 0.7071;
  return tap(p + vec2<f32>(r, 0.0)) + tap(p - vec2<f32>(r, 0.0)) + tap(p + vec2<f32>(0.0, r)) + tap(p - vec2<f32>(0.0, r))
    + tap(p + vec2<f32>(a, a)) + tap(p - vec2<f32>(a, a)) + tap(p + vec2<f32>(a, -a)) + tap(p - vec2<f32>(a, -a));
}

@fragment
fn fs(@builtin(position) pos : vec4<f32>) -> @location(0) vec4<f32> {
  let dpr = u.res.x / u.css.x;
  let p = pos.xy / dpr;
  let half = u.css * 0.5;
  // radial barrel: the screen (canvas minus the bezel) shows the whole source, bulged; r2 is the squared distance from the centre,
  // 1 at the screen corner, and the per-axis normalisation keeps the midpoint of every edge on the edge of the source
  let sh = half - vec2<f32>(u.bezel);
  let d = p - half;
  let r2 = dot(d, d) / dot(sh, sh);
  let qb = (d / sh) * (1.0 + u.k * r2) / (vec2<f32>(1.0) + u.k * sh * sh / dot(sh, sh));
  let s = half + qb * half;
  let sd = sd_box(s - half, half, u.corner);

  // the bezel: dark plastic, lit a little by the screen near its edge
  let edge = max(sd, 0.0);
  var bezel = BG * 2.4 + vec3<f32>(0.05, 0.07, 0.08) * exp(-edge * 0.12) * (0.4 + 0.6 * u.glow);
  bezel = bezel * (0.85 + 0.15 * smoothstep(half.y * 1.4, 0.0, length(p - vec2<f32>(half.x, 0.0))));
  if (sd * dpr >= 0.34 || u.ready < 0.5) { return vec4<f32>(bezel, 1.0); }

  let period = max(2.5 / dpr, u.css.y / 240.0);
  // interlace: two fields of lines; each line samples at its centre (thin edges twitter); the other field is the previous one, dimmer,
  // from hist (moved content combs)
  var col : vec3<f32>;
  var lineGain = 1.0;
  var linePhase = s.y / period;
  if (u.interlace > 0.5) {
    let pitch = max(2.0 / dpr, period * 0.5);
    let n = floor(s.y / pitch);
    let odd = n - 2.0 * floor(n * 0.5);
    let old = abs(odd - u.parity) > 0.5;
    col = beam(vec2<f32>(s.x + odd * FIELD_SHIFT, (n + 0.5) * pitch), old);
    let decay = 1.0 - 0.5 * (0.35 + 0.65 * u.scanlines);
    lineGain = select(1.0, decay, old) * (1.0 + 0.3 * (1.0 - decay));
    linePhase = s.y / pitch;
  } else {
    col = beam(s, false);
  }

  // phosphor glow: two rings of taps, the brightest parts bleed the most
  if (u.glow > 0.0) {
    let near = ring(s, 1.6) * 0.125;
    let far = ring(s, 4.2) * 0.125;
    let bloom = near * 0.6 + far * 0.4;
    col = col + bloom * bloom * (1.25 * u.glow) + bloom * (0.12 * u.glow);
  }

  // scanlines on the curved glass, aperture-grille mask on the backing pixels
  let profile = 0.5 + 0.5 * cos(6.2831853 * linePhase);
  let gap = select(0.42, 0.3, u.interlace > 0.5);
  col = col * lineGain * (1.0 + 0.16 * u.scanlines) * (1.0 - u.scanlines * gap * (1.0 - profile));
  let column = u32(pos.x) % 3u;
  var mask = vec3<f32>(1.0, 0.86, 0.86);
  if (column == 1u) { mask = vec3<f32>(0.86, 1.0, 0.86); }
  if (column == 2u) { mask = vec3<f32>(0.86, 0.86, 1.0); }
  col = col * mix(vec3<f32>(1.0), mask, 0.55 * u.scanlines);

  // flicker, a slow rolling bar, faint static (all scaled by `flicker`, which is 0 with reduced motion)
  let roll = fract(u.time * 0.09) * 1.5 - 0.25;
  let bar = smoothstep(0.09, 0.0, abs(s.y / u.css.y - roll));
  let grain = fract(sin(dot(floor(pos.xy) + vec2<f32>(u.time * 61.0, u.time * 17.0), vec2<f32>(12.9898, 78.233))) * 43758.547) - 0.5;
  col = col * (1.0 + u.flicker * (0.022 * sin(u.time * 47.0) + 0.05 * bar)) + vec3<f32>(u.flicker * (0.018 * bar + 0.022 * grain));

  // vignette and the dark rim of the curved glass
  let v = clamp(1.0 - 0.16 * dot(qb, qb) * dot(qb, qb), 0.0, 1.0);
  col = col * v * (0.55 + 0.45 * smoothstep(0.0, 9.0, -sd));
  col = col * vec3<f32>(0.97, 1.02, 0.98);

  let cover = clamp(0.5 - 1.5 * sd * dpr, 0.0, 1.0);
  return vec4<f32>(mix(bezel, col, cover), 1.0);
}

// source -> history texture (same size)
@fragment
fn fs_copy(@builtin(position) pos : vec4<f32>) -> @location(0) vec4<f32> {
  return textureLoad(src, vec2<i32>(pos.xy), 0);
}
