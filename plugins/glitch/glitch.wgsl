// Controlled digital glitch over the drawn page. Everything is in CSS pixels of the presented frame.
//
// One instanced draw: instance 0 is the whole page, instance i > 0 is block i - 1 of the block table, drawn as a rectangle on top of the
// previous ones, so where blocks overlap the LAST one is visible. The rasterizer picks the pixels of each block: the fragment shader has
// no loop over the blocks (measured back to back at 2200x1240 on an M1 Max with 15 blocks: a per-pixel loop 0.48 ms per frame, this
// instanced draw 0.09 ms, the same as a one-sample pass).
//
// The only layer that MOVES the page is a shift block (kind 0): its pixels show the page shifted by an integer offset, wrapped around the
// page. mapGlitchPoint() in index.js is the JavaScript twin (the last block that covers a point decides it). The other layers only change
// colours where the page already is: the RGB split (red and blue sampled a few pixels apart, green in place), the pixel-sort streaks
// (kind 1: a pixel takes the brightest of the pixels above it), grain and scanlines.
const MAX_BLOCKS : u32 = 16u;
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
  blocks : array<vec4<f32>, 32>,   // per block: (x0, y0, x1, y1), (dx, dy, kind 0 shift | 1 sort, extra split or sort length)
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

@fragment
fn fs(in : VsOut) -> @location(0) vec4<f32> {
  let p = in.position.xy / u.resolution * u.css;
  var src = p;
  var split = u.split;
  var sort_len = 0.0;
  if (in.shift.z < 0.5) {
    let q = p - in.shift.xy;
    src = q - floor(q / u.css) * u.css;   // wrapped around the page (the page itself: q = p, unchanged)
    split = u.split + in.shift.w * u.block_split;
  } else {
    sort_len = in.shift.w;
  }

  let g = tap(src);
  var rgb = vec3<f32>(tap(src + vec2<f32>(split, 0.0)).r, g.g, tap(src - vec2<f32>(split, 0.0)).b);
  if (sort_len > 0.0) {
    // pixel sorting, cheaply: the brightest of the pixels above wins, so bright runs smear down the streak
    var best = rgb;
    var best_l = dot(rgb, vec3<f32>(0.299, 0.587, 0.114));
    for (var j = 1; j <= SORT_TAPS; j = j + 1) {
      let c = tap(src - vec2<f32>(0.0, sort_len * f32(j) / f32(SORT_TAPS))).rgb;
      let l = dot(c, vec3<f32>(0.299, 0.587, 0.114));
      if (l > best_l) { best = c; best_l = l; }
    }
    rgb = best;
  }
  let line = step(fract(p.y / 3.0), 0.34);
  rgb = rgb * (1.0 - u.scan * 0.5 * line);
  rgb = rgb + (hash(floor(p) + vec2<f32>(u.time * 61.0, u.time * 17.0)) - 0.5) * 0.12 * u.grain;
  rgb = mix(rgb, vec3<f32>(rgb.r * 1.25, rgb.g * 0.55, rgb.b * 1.35), u.flash);
  return vec4<f32>(clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0)) * u.ready, 1.0);
}
