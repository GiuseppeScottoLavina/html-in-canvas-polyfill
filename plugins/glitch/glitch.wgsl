// Controlled digital glitch over the drawn page. Everything is in CSS pixels of the presented frame.
//
// One instanced draw: instance 0 is the whole page, instance i > 0 is block i - 1 of the block table, drawn as a rectangle on top of the
// previous ones, so where blocks overlap the LAST one is visible. The rasterizer picks the pixels of each block: the fragment shader has
// no loop over the blocks (measured back to back at 2200x1240 on an M1 Max with 15 blocks: a per-pixel loop 0.48 ms per frame, this
// instanced draw 0.09 ms, the same as a one-sample pass).
//
// The only layers that MOVE the page are the shift blocks (kind below 0.5: a block, a tear, a slice of the tracking band): their pixels
// show the page shifted by an integer offset, wrapped around the page. mapGlitchPoint() in index.js is the JavaScript twin (the last block
// that covers a point decides it). The other layers only change colours where the page already is: the RGB split (red spread to one side
// and blue to the other over five taps, like the dispersion of a cheap lens; green stays in place), the pixel-sort streaks (kind 1: a
// pixel takes the brightest of the pixels above it), the corrupted macroblocks (kind 2: luma kept, chroma taken from the block's centre
// and drifted, as a damaged video stream shows), the washed-out band with its dropout lines, grain and scanlines.
const MAX_BLOCKS : u32 = 32u;
const SORT_TAPS : i32 = 8;

struct Uniforms {
  resolution : vec2<f32>,   // presented size in backing pixels
  css : vec2<f32>,          // presented size in CSS pixels
  time : f32,               // seconds, quantised (grain)
  split : f32,              // RGB split everywhere, CSS px
  grain : f32,              // 0..1
  scan : f32,               // scanline darkening 0..1
  count : f32,              // blocks in use
  ready : f32,              // 0 before the first source upload
  flash : f32,              // burst colour flash 0..1
  block_split : f32,        // 1: the blocks add their own split, 0: the split is off
  blocks : array<vec4<f32>, 64>,   // per block: (x0, y0, x1, y1), (dx, dy, kind 0 shift | 0.25 band | 1 sort | 2 macroblock, extra)
}

@group(0) @binding(0) var<uniform> u : Uniforms;
@group(0) @binding(1) var source_sampler : sampler;
@group(0) @binding(2) var source : texture_2d<f32>;

struct VsOut {
  @builtin(position) position : vec4<f32>,
  @location(0) @interpolate(flat) shift : vec4<f32>,   // dx, dy, kind, extra of the block (zero for the page)
}

@vertex
fn vs(@builtin(vertex_index) index : u32, @builtin(instance_index) instance : u32) -> VsOut {
  var corners = array<vec2<f32>, 6>(vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0), vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0));
  var rect = vec4<f32>(0.0, 0.0, u.css.x, u.css.y);
  var shift = vec4<f32>(0.0);
  if (instance > 0u) {
    let i = min(instance - 1u, MAX_BLOCKS - 1u);
    rect = u.blocks[2u * i];
    shift = u.blocks[2u * i + 1u];
  }
  let q = mix(rect.xy, rect.zw, corners[index]);
  var out : VsOut;
  out.position = vec4<f32>(q.x / u.css.x * 2.0 - 1.0, 1.0 - q.y / u.css.y * 2.0, 0.0, 1.0);
  out.shift = shift;
  return out;
}

fn tap(q : vec2<f32>) -> vec4<f32> {
  return textureSampleLevel(source, source_sampler, q / u.css, 0.0);
}

fn hash(p : vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(12.9898, 78.233))) * 43758.5453);
}

fn luma(c : vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.299, 0.587, 0.114));
}

// The RGB split as a spectral spread: red is sampled over (0, +s/2, +s), blue over (0, -s/2, -s), green only at q, so the fringes fade
// smoothly instead of the hard double edge of a three-tap split, and the green channel stays exactly where the mapper says.
fn spectral(q : vec2<f32>, s : f32) -> vec3<f32> {
  let c = tap(q).rgb;
  if (s < 0.05) { return c; }
  let d = vec2<f32>(s, 0.0);
  let r = 0.2 * c.r + 0.35 * tap(q + 0.5 * d).r + 0.45 * tap(q + d).r;
  let b = 0.2 * c.b + 0.35 * tap(q - 0.5 * d).b + 0.45 * tap(q - d).b;
  return vec3<f32>(r, c.g, b);
}

@fragment
fn fs(in : VsOut) -> @location(0) vec4<f32> {
  let p = in.position.xy / u.resolution * u.css;
  let kind = in.shift.z;
  var src = p;
  var split = u.split;
  var sort_len = 0.0;
  var macro_size = 0.0;
  var band = false;
  if (kind < 0.5) {
    let q = p - in.shift.xy;
    src = q - floor(q / u.css) * u.css;   // wrapped around the page (the page itself: q = p, unchanged)
    split = u.split + in.shift.w * u.block_split;
    band = kind > 0.1;
  } else if (kind < 1.5) {
    sort_len = in.shift.w;
  } else {
    macro_size = in.shift.w;
  }

  var rgb = spectral(src, split);
  if (sort_len > 0.0) {
    // pixel sorting, cheaply: the brightest of the pixels above wins, so bright runs smear down the streak
    var best = rgb;
    var best_l = luma(rgb);
    for (var j = 1; j <= SORT_TAPS; j = j + 1) {
      let c = tap(src - vec2<f32>(0.0, sort_len * f32(j) / f32(SORT_TAPS))).rgb;
      let l = luma(c);
      if (l > best_l) { best = c; best_l = l; }
    }
    rgb = best;
  }
  if (macro_size > 0.0) {
    // a corrupted macroblock: the detail (luma) of the pixel, the colour (chroma) of the block's centre, boosted and drifted per block
    let cell = floor(p / macro_size);
    let c = tap((cell + vec2<f32>(0.5)) * macro_size).rgb;
    let h = hash(cell + vec2<f32>(u.time * 7.0, 3.1));
    let drift = (vec3<f32>(h, fract(h * 7.31), fract(h * 13.7)) - vec3<f32>(0.5)) * 0.22;
    rgb = vec3<f32>(luma(rgb)) + (c - vec3<f32>(luma(c))) * 1.7 + drift;
  }
  if (band) {
    // the tracking band: washed out, with bright dropout dashes while a burst runs (the grain is strong only then)
    rgb = mix(rgb, vec3<f32>(luma(rgb)), 0.45) * 1.06 + vec3<f32>(0.015);
    if (u.grain > 0.3) {
      let n = hash(vec2<f32>(floor(p.x / 4.0), floor(p.y)) + vec2<f32>(u.time * 37.0, u.time * 11.0));
      rgb = mix(rgb, vec3<f32>(0.92, 0.95, 1.0), step(0.97, n) * 0.85);
    }
  }
  // scanlines: a soft cosine profile, 3 CSS px per line
  let line = 0.5 + 0.5 * cos(6.2831853 * p.y / 3.0);
  rgb = rgb * (1.0 - u.scan * 0.5 * line);
  rgb = rgb + (hash(floor(p) + vec2<f32>(u.time * 61.0, u.time * 17.0)) - 0.5) * 0.12 * u.grain;
  rgb = mix(rgb, vec3<f32>(rgb.r * 1.25, rgb.g * 0.55, rgb.b * 1.35), u.flash);
  return vec4<f32>(clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0)) * u.ready, 1.0);
}
