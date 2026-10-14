// CRT arcade monitor. Lengths in CSS px of the presented frame. mapCrtPoint() in index.js is the JavaScript twin of the barrel and of
// the screen mask below: same formula, same rounded screen corners. Everything after the barrel (beam, scanlines, shadow mask, glow,
// warmth, flicker, glass) changes colours only, never which source point a pixel shows.
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
  mask : f32,          // 0..1 shadow mask
  warmth : f32,        // 0..1 warm phosphor
  pad : f32,
}

@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var src : texture_2d<f32>;

const BG = vec3<f32>(0.008, 0.009, 0.010);

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

// eight taps on a circle of radius r around p; `turn` rotates the ring by 22.5 degrees so that two rings do not line up
fn ring(p : vec2<f32>, r : f32, turn : bool) -> vec3<f32> {
  var a = r * 0.7071;
  var c = r;
  if (turn) { a = r * 0.3827; c = r * 0.9239; }
  return (tap(p + vec2<f32>(c, a)) + tap(p - vec2<f32>(c, a)) + tap(p + vec2<f32>(-a, c)) + tap(p + vec2<f32>(a, -c))
    + tap(p + vec2<f32>(a, c)) + tap(p - vec2<f32>(a, c)) + tap(p + vec2<f32>(c, -a)) + tap(p + vec2<f32>(-c, a))) * 0.125;
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

  // the glass over the tube and the bezel: a soft reflection of a light up and to the left, and a faint sheen across it
  let gp = (p - vec2<f32>(u.css.x * 0.22, u.css.y * 0.15)) / u.css.y * vec2<f32>(0.7, 1.0);
  let sheen = 0.075 * exp(-dot(gp, gp) / 0.03) + 0.014 * smoothstep(0.3, 0.0, abs((p.x + p.y * 0.8) / u.css.x - 0.42));

  // the bezel: dark warm plastic with a lip, lit by the screen near its inner edge
  let edge = max(sd, 0.0);
  let lip = smoothstep(u.bezel * 0.5, 0.0, edge) * smoothstep(0.0, 2.0, edge);
  var bezel = vec3<f32>(0.022, 0.021, 0.020) + vec3<f32>(0.10, 0.085, 0.07) * exp(-edge * 0.14) * (0.3 + 0.7 * u.glow);
  bezel = bezel * (0.75 + 0.25 * smoothstep(half.y * 1.6, 0.0, length(p - vec2<f32>(half.x, 0.0)))) + vec3<f32>(0.035) * lip;
  bezel = bezel + vec3<f32>(sheen * 0.6);
  if (sd * dpr >= 0.34 || u.ready < 0.5) { return vec4<f32>(bezel, 1.0); }

  // the beam: red and blue guns land a little to each side of green (misconvergence)
  var col = tap(s);
  if (u.mis > 0.0) { col = vec3<f32>(tap(s + vec2<f32>(u.mis, 0.0)).r, col.g, tap(s - vec2<f32>(u.mis, 0.0)).b); }

  // phosphor glow and bloom: three rings of taps. The light spills from bright parts into darker neighbours (a halo around text and
  // controls), and bright parts glow a little more; a flat bright area is not washed out, so its lines and stripes stay
  if (u.glow > 0.0) {
    let near = ring(s, 1.5, false);
    let mid = ring(s, 4.0, true);
    let far = ring(s, 9.0, false);
    let bloom = near * 0.45 + mid * 0.35 + far * 0.2;
    col = col + max(bloom - col, vec3<f32>(0.0)) * (1.1 * u.glow) + bloom * bloom * (0.45 * u.glow) + far * (0.16 * u.glow);
  }

  // thick scanlines that follow the curved glass: each line is a beam with a Gaussian profile; bright lines are wider (they fill the
  // gap), dark ones thinner (the gap shows); a line is at least 3 CSS px (and so at least 3 backing px: the lines never alias with the
  // pixel grid), or 1/240 of the height on a taller screen
  let period = max(3.0, u.css.y / 240.0);
  let f = fract(s.y / period) - 0.5;
  let lum = clamp(max(col.r, max(col.g, col.b)), 0.0, 1.0);
  let sigma = mix(0.2, 0.46, sqrt(lum));
  let beam = exp(-f * f / (2.0 * sigma * sigma));
  let depth = 0.94 * u.scanlines;
  col = col * ((1.0 - depth) + depth * beam) * (1.0 + 0.5 * depth);

  // aperture-grille mask on the backing pixels: red, green and blue phosphor stripes, each `cw` px wide (one CSS px), so the triads
  // stay visible at any device pixel ratio; the darker channels keep `lo`, and the gain makes up for the light the mask removes
  let cw = max(1.0, round(dpr));
  let column = u32(floor(pos.x / cw)) % 3u;
  var phos = vec3<f32>(1.0, 0.0, 0.0);
  if (column == 1u) { phos = vec3<f32>(0.0, 1.0, 0.0); }
  if (column == 2u) { phos = vec3<f32>(0.0, 0.0, 1.0); }
  let lo = 1.0 - 0.75 * u.mask;
  col = col * mix(vec3<f32>(lo), vec3<f32>(1.0), phos) * (1.0 + 0.75 * u.mask);

  // warm phosphor: a little more red and less blue, and a warm black level
  col = col * mix(vec3<f32>(1.0), vec3<f32>(1.07, 0.98, 0.82), u.warmth) + vec3<f32>(0.012, 0.008, 0.004) * u.warmth;

  // flicker, a slow rolling bar, faint static (all scaled by `flicker`, which is 0 with reduced motion)
  let roll = fract(u.time * 0.09) * 1.5 - 0.25;
  let bar = smoothstep(0.09, 0.0, abs(s.y / u.css.y - roll));
  let grain = fract(sin(dot(floor(pos.xy) + vec2<f32>(u.time * 61.0, u.time * 17.0), vec2<f32>(12.9898, 78.233))) * 43758.547) - 0.5;
  col = col * (1.0 + u.flicker * (0.022 * sin(u.time * 47.0) + 0.05 * bar)) + vec3<f32>(u.flicker * (0.018 * bar + 0.022 * grain));

  // a soft shoulder instead of a hard clip: the brightest parts compress but keep their lines and their phosphor stripes
  let over = max(col - vec3<f32>(0.55), vec3<f32>(0.0));
  col = min(col, vec3<f32>(0.55)) + 0.43 * (vec3<f32>(1.0) - exp(-over / 0.43));

  // vignette, the dark rim of the curved glass, and the glass reflection on top
  let v = clamp(1.0 - 0.28 * dot(qb, qb) * dot(qb, qb), 0.0, 1.0);
  col = col * v * (0.5 + 0.5 * smoothstep(0.0, 10.0, -sd)) + vec3<f32>(sheen);

  let cover = clamp(0.5 - 1.5 * sd * dpr, 0.0, 1.0);
  return vec4<f32>(mix(bezel, col, cover), 1.0);
}
