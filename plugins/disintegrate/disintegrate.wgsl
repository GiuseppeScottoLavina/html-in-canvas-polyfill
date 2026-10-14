// Disintegrate (README.md): one instanced quad per grid cell; its motion is a function of its cell and of g (0 assembled, 1 gone).

struct Uniforms {
  resolution : vec2<f32>,  // backing px
  css : vec2<f32>,
  g : f32,
  life : f32,
  cell : f32,              // backing px
  cols : f32,
  wind : vec2<f32>,        // unit, y down
  travel : f32,            // css px
  turbulence : f32,
  size_var : f32,
  glow_amount : f32,
  fade : f32,              // fs_full: 1 source, 0 backdrop
  seed : f32,
  backdrop : vec4<f32>,
  glow : vec4<f32>,
}

@group(0) @binding(0) var<uniform> u : Uniforms;
@group(0) @binding(1) var source_sampler : sampler;
@group(0) @binding(2) var source : texture_2d<f32>;

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

fn pcg(n : u32) -> u32 {
  let s = n * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

fn rnd(n : u32) -> f32 {
  return f32(pcg(n)) * (1.0 / 4294967295.0);
}

fn lattice(p : vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(127.1, 311.7)) + u.seed * 17.0) * 43758.5453);
}

fn value_noise(p : vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let s = f * f * (3.0 - 2.0 * f);
  let a = lattice(i);
  let b = lattice(i + vec2<f32>(1.0, 0.0));
  let c = lattice(i + vec2<f32>(0.0, 1.0));
  let d = lattice(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
}

// Start in [0, 1 - life]: every age is 0 at g = 0 and 1 at g = 1 (particleAge in index.js). Downwind leaves first, noisy front.
fn start_of(uv : vec2<f32>, r : f32) -> f32 {
  let span = 0.5 * (abs(u.wind.x) + abs(u.wind.y));
  let downwind = clamp(dot(uv - vec2<f32>(0.5), u.wind) / max(span, 0.001) * 0.5 + 0.5, 0.0, 1.0);
  let front = (1.0 - downwind) * 0.62 + value_noise(uv * 7.0) * 0.23 + r * 0.15;
  return clamp(front, 0.0, 1.0) * (1.0 - u.life);
}

struct ParticleOut {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) alpha : f32,
  @location(2) heat : f32,
}

@vertex
fn vs_particle(@builtin(vertex_index) vertex : u32, @builtin(instance_index) particle : u32) -> ParticleOut {
  var corners = array<vec2<f32>, 6>(vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
                                     vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0));
  let corner = corners[vertex];
  let cols = max(u32(u.cols), 1u);
  let home = vec2<f32>(f32(particle % cols), f32(particle / cols)) * u.cell;
  let size = max(min(vec2<f32>(u.cell), u.resolution - home), vec2<f32>(0.0));
  let centre = home + size * 0.5;
  let r0 = rnd(particle * 4u + 1u);
  let r1 = rnd(particle * 4u + 2u);
  let r2 = rnd(particle * 4u + 3u);
  let r3 = rnd(particle * 4u + 4u);
  let age = clamp((u.g - start_of(centre / u.resolution, r0)) / u.life, 0.0, 1.0);

  let swirl = (value_noise(centre / u.resolution * 5.0 + vec2<f32>(u.seed * 0.37, 0.0)) * 2.0 - 1.0) * 6.2831853 + r1 * 2.0;
  let drift = u.wind * (age * age)
            + vec2<f32>(cos(swirl), sin(swirl)) * (age * u.turbulence * 0.45)
            + vec2<f32>(0.0, -0.25) * (age * r2);
  let dpr = u.resolution.x / max(u.css.x, 1.0);
  let offset = drift * u.travel * (0.6 + 0.8 * r3) * dpr;
  let grow = mix(1.0, 0.3 + 1.4 * r2, u.size_var * smoothstep(0.0, 1.0, age));
  let position = centre + (corner - vec2<f32>(0.5)) * size * grow + offset;

  var out : ParticleOut;
  out.position = vec4<f32>(position.x / u.resolution.x * 2.0 - 1.0, 1.0 - position.y / u.resolution.y * 2.0, 0.0, 1.0);
  out.uv = (home + corner * size) / u.resolution;
  out.alpha = 1.0 - smoothstep(0.1, 0.8, age);
  out.heat = age;
  if (out.alpha <= 0.0) {
    out.position = vec4<f32>(2.0, 2.0, 0.0, 1.0);   // gone: degenerate, outside the clip volume
  }
  return out;
}

@fragment
fn fs_particle(v : ParticleOut) -> @location(0) vec4<f32> {
  let c = textureSample(source, source_sampler, v.uv);
  let picture = mix(u.backdrop.rgb, c.rgb, c.a);
  // a brief ember as it tears off, then its own colour, darkening
  let ember = u.glow_amount * smoothstep(0.0, 0.08, v.heat) * (1.0 - smoothstep(0.12, 0.45, v.heat));
  return vec4<f32>(mix(picture, u.glow.rgb, ember) * (1.0 - 0.4 * v.heat), v.alpha);
}
