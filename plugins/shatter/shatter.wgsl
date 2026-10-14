// Shatter (README.md): a spiderweb of cracks (shards.js) drawn as one triangle fan per shard. Cracked, each shard sits a few px off with
// the picture bent along its edges (the input mapper is the exact inverse: crackedSource in shards.js); falling, it flies out in 3D with
// perspective, lighting and ghost copies for motion blur (vs_shard = shardPoint). Debris is one instanced triangle per chip.

struct Uniforms {
  resolution : vec2<f32>,  // backing px
  css : vec2<f32>,
  time : f32,              // physics s of the fall, 0 = in the pane
  gravity : f32,           // css px/s^2
  alpha : f32,
  front : f32,             // css px: how far the cracks have run from the impact
  impact : vec2<f32>,
  edge_amount : f32,
  fade : f32,              // fs_full: 1 source, 0 backdrop
  flash : f32,
  crack : f32,             // 0 closed .. 1 open
  glint : f32,
  focal : f32,             // css px from the eye to the pane
  debris_t : f32,          // s since the chips burst (< 0: none)
  debris_n : f32,
  ghosts : f32,            // copies drawn per shard: 1, or 3 while they fall (motion blur)
  refract : f32,           // css px the picture bends at a crack
  backdrop : vec4<f32>,
  edge : vec4<f32>,
  shards : array<vec4<f32>, 640>,   // per shard: centre, offset | velocity, start | axis, spin | tilt, distance, random
}

@group(0) @binding(0) var<uniform> u : Uniforms;
@group(0) @binding(1) var source_sampler : sampler;
@group(0) @binding(2) var source : texture_2d<f32>;

const BEVEL : f32 = 7.0;
const GHOST_DT : f32 = 0.012;

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

// Passthrough formula of the host (fade 1: bit-exact); fade < 1: the dimmed picture inside the open cracks, or the reduced-motion crossfade.
@fragment
fn fs_full(v : FullOut) -> @location(0) vec4<f32> {
  let c = textureSample(source, source_sampler, v.uv);
  let picture = mix(u.backdrop.rgb, c.rgb, c.a);
  let faded = mix(u.backdrop.rgb, picture, u.fade);
  return vec4<f32>(select(faded, picture, u.fade >= 1.0), 1.0);
}

// The frozen copy of the picture (rgba8unorm).
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

fn hash2(p : vec2<f32>) -> f32 {
  let c = vec2<i32>(floor(p));
  return rnd((bitcast<u32>(c.x) * 73856093u) ^ (bitcast<u32>(c.y) * 19349663u));
}

/** v rotated about the unit axis a by angle (Rodrigues) */
fn rotate(v : vec3<f32>, a : vec3<f32>, angle : f32) -> vec3<f32> {
  let c = cos(angle);
  let s = sin(angle);
  return v * c + cross(a, v) * s + a * dot(a, v) * (1.0 - c);
}

/** perspective about the canvas centre: the eye looks at the pane from `focal` css px; z > 0 comes towards it */
fn project(p : vec3<f32>) -> vec3<f32> {
  let z = min(p.z, 0.8 * u.focal);
  let s = u.focal / (u.focal - z);
  let centre = u.css * 0.5;
  return vec3<f32>(centre + (p.xy - centre) * s, s);
}

fn to_clip(css_point : vec2<f32>) -> vec4<f32> {
  let p = css_point / u.css;
  return vec4<f32>(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
}

struct ShardOut {
  @builtin(position) position : vec4<f32>,
  @location(0) home : vec2<f32>,
  @location(1) e : f32,
  @location(2) @interpolate(flat) nin : vec2<f32>,
  @location(3) @interpolate(flat) h : f32,
  @location(4) @interpolate(flat) border : f32,
  @location(5) @interpolate(flat) k : f32,
  @location(6) @interpolate(flat) normal : vec3<f32>,
  @location(7) @interpolate(flat) moving : f32,
  @location(8) @interpolate(flat) alpha : f32,
  @location(9) @interpolate(flat) scale : f32,
}

@vertex
fn vs_shard(@builtin(instance_index) copy : u32, @location(0) home : vec2<f32>, @location(1) info : vec2<f32>, @location(2) bevel : vec4<f32>) -> ShardOut {
  let id = u32(info.x * 0.5);
  let a = u.shards[id * 4u];
  let b = u.shards[id * 4u + 1u];
  let c = u.shards[id * 4u + 2u];
  let d = u.shards[id * 4u + 3u];
  // the ghosts (motion blur) are the same shard a few ms earlier, drawn first and fainter
  let lag = f32(max(u32(u.ghosts), 1u) - 1u - min(copy, max(u32(u.ghosts), 1u) - 1u));
  let t = u.time - lag * GHOST_DT;
  let k = smoothstep(d.z, d.z + 110.0, u.front);
  let tau = max(t - b.w, 0.0);
  let angle = c.w * tau;
  let r = rotate(vec3<f32>(home - a.xy, 0.0), c.xyz, angle);
  let p = vec3<f32>(a.xy + a.zw * k, 0.0) + r + b.xyz * tau + vec3<f32>(0.0, 0.5 * u.gravity * tau * tau, 0.0);
  let projected = project(p);
  var out : ShardOut;
  // in the pane: home + k * offset, exactly (the input mapper's formula)
  out.position = to_clip(select(projected.xy, home + a.zw * k, tau <= 0.0));
  out.home = home;
  out.e = info.y;
  out.nin = bevel.xy;
  out.h = bevel.z;
  out.border = info.x - f32(id) * 2.0;
  out.k = k;
  out.normal = rotate(normalize(vec3<f32>(d.xy * k, 1.0)), c.xyz, angle);
  out.moving = select(0.0, 1.0, tau > 0.0);
  out.alpha = u.alpha * select(select(0.3, 0.16, lag > 1.5), 1.0, lag < 0.5);
  out.scale = select(projected.z, 1.0, tau <= 0.0);
  return out;
}

@fragment
fn fs_shard(v : ShardOut) -> @location(0) vec4<f32> {
  let de = v.e * v.h;                                     // css px to the crack this fan triangle borders
  let inner = 1.0 - v.border;                             // the canvas border is no crack
  var bend = vec2<f32>(0.0);
  if (inner > 0.5 && de < BEVEL) {
    let q = 1.0 - max(de, 0.0) / BEVEL;
    bend = v.nin * u.refract * q * q * v.k;               // the broken edge acts as a lens (crackedSource bends the same way)
  }
  let c = textureSampleLevel(source, source_sampler, (v.home + bend) / u.css, 0.0);
  var rgb = mix(u.backdrop.rgb, c.rgb, c.a);
  let n = normalize(v.normal);
  let nf = n * sign(n.z + 1e-6);
  let light = normalize(vec3<f32>(u.css.x * 0.22, -u.css.y * 0.4, 650.0) - vec3<f32>(v.home, 0.0));
  let half_v = normalize(light + vec3<f32>(0.0, 0.0, 1.0));
  let di = distance(v.home, u.impact);
  if (v.moving > 0.5) {
    // a pane of glass in the air: lit by its face, darker seen from behind, a bright rim that thickens as it turns edge-on
    rgb = rgb * (0.5 + 0.5 * max(dot(nf, light), 0.0));
    if (n.z < 0.0) { rgb = rgb * 0.75 + u.edge.rgb * 0.06; }
    let spec = pow(max(dot(nf, half_v), 0.0), 36.0);
    let rim = 1.0 - smoothstep(0.0, (1.0 + 4.0 * (1.0 - abs(n.z))) / v.scale, de);
    rgb = rgb + u.edge.rgb * spec * 1.3 * u.glint;
    rgb = mix(rgb, u.edge.rgb * (0.75 + spec), rim * 0.85 * u.edge_amount);
  } else {
    // the cracked pane: each piece, at its own slight tilt, catches a far light (a window above the screen) its own way
    let sky = normalize(vec3<f32>(u.css.x * 0.35, -u.css.y * 0.3, 2400.0) - vec3<f32>(v.home, 0.0));
    let hv = dot(nf, normalize(sky + vec3<f32>(0.0, 0.0, 1.0)));
    rgb = rgb + u.edge.rgb * (pow(max(hv, 0.0), 900.0) * 0.1 + pow(max(hv, 0.0), 9000.0) * 0.35) * u.glint * v.k;
  }
  // the crack lines, once the running crack has reached this point: a bright fracture, its bevel lit on one side and shaded on the other
  let reached = 1.0 - smoothstep(u.front - 30.0, u.front, di);
  let crack = inner * reached * u.edge_amount;
  // a fracture is wider and whiter near the impact, and catches more or less light along its length
  let width = mix(1.7, 0.9, smoothstep(30.0, 400.0, di));
  let catches = 0.45 + 0.55 * abs(dot(v.nin, normalize(vec2<f32>(0.8, -0.6)))) * (0.6 + 0.4 * hash2(v.home / 40.0));
  let line = (1.0 - smoothstep(0.25 * width, width, de)) * catches;
  let bevel_q = 1.0 - smoothstep(0.0, BEVEL, de);
  let facing = dot(v.nin, normalize(vec2<f32>(0.45, 0.9)));
  rgb = rgb * (1.0 + crack * bevel_q * bevel_q * facing * 0.35 * v.k);
  rgb = mix(rgb, u.edge.rgb * 1.05, line * crack * (0.55 + 0.4 * v.k));
  let sparkle = step(0.94, hash2(v.home / 3.0)) * (1.0 - smoothstep(0.0, 2.0, de)) * crack;
  rgb = rgb + u.edge.rgb * sparkle * (0.5 + 0.5 * u.glint);
  // crushed glass around the impact, and the flash of a strike
  let crush = (1.0 - smoothstep(4.0, 22.0, di)) * u.edge_amount * v.k * (0.4 + 0.6 * hash2(v.home / 1.5));
  rgb = mix(rgb, vec3<f32>(0.86, 0.94, 1.0), crush * 0.5);
  rgb = rgb + u.edge.rgb * u.flash * exp(-di / 38.0);
  return vec4<f32>(rgb, v.alpha);
}

// ---- debris: small chips of glass bursting from the impact ---------------------------------------------------------------------------

struct DebrisOut {
  @builtin(position) position : vec4<f32>,
  @location(0) colour : vec4<f32>,
}

@vertex
fn vs_debris(@builtin(vertex_index) vertex : u32, @builtin(instance_index) chip : u32) -> DebrisOut {
  var out : DebrisOut;
  out.position = vec4<f32>(2.0, 2.0, 0.0, 1.0);
  out.colour = vec4<f32>(0.0);
  if (f32(chip) >= u.debris_n || u.debris_t < 0.0) { return out; }
  let r0 = rnd(chip * 8u + 1u);
  let r1 = rnd(chip * 8u + 2u);
  let r2 = rnd(chip * 8u + 3u);
  let r3 = rnd(chip * 8u + 4u);
  let r4 = rnd(chip * 8u + 5u);
  let r5 = rnd(chip * 8u + 6u);
  let tau = u.debris_t - r1 * 0.05;
  if (tau <= 0.0) { return out; }
  let a = r0 * 6.2831853;
  let dir = vec2<f32>(cos(a), sin(a));
  let speed = 160.0 + 1100.0 * r2 * r2;
  let start = u.impact + dir * r4 * 28.0;
  let p = vec3<f32>(start + dir * speed * tau + vec2<f32>(0.0, 0.5 * u.gravity * tau * tau - 140.0 * tau * r5), (r3 - 0.25) * 700.0 * tau);
  let q = project(p);
  let spin = (r5 - 0.5) * 40.0 * tau + r0 * 6.0;
  let size = (1.2 + 3.4 * r5 * r5) * q.z;
  var corners = array<vec2<f32>, 3>(vec2<f32>(1.0, 0.0), vec2<f32>(-0.6, 0.8), vec2<f32>(-0.5, -0.9));
  let cn = corners[vertex];
  let cs = cos(spin);
  let sn = sin(spin);
  out.position = to_clip(q.xy + vec2<f32>(cn.x * cs - cn.y * sn, cn.x * sn + cn.y * cs) * size);
  let twinkle = 0.55 + 0.45 * abs(sin(spin * 1.7 + r0 * 9.0));
  out.colour = vec4<f32>(u.edge.rgb * twinkle, (1.0 - smoothstep(0.45, 1.0, tau)) * u.alpha);
  return out;
}

@fragment
fn fs_debris(v : DebrisOut) -> @location(0) vec4<f32> {
  return v.colour;
}
