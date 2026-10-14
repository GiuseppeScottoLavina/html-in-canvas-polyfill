// Shatter (README.md): Voronoi shards as triangle fans (shards.js); a shard's motion is a function of time (vs_shard = shardPoint).

struct Uniforms {
  resolution : vec2<f32>,  // backing px
  css : vec2<f32>,
  time : f32,              // physics s, 0 = intact
  gravity : f32,           // css px/s^2
  alpha : f32,
  front : f32,             // crack front radius, css px
  impact : vec2<f32>,
  edge_amount : f32,
  fade : f32,              // fs_full: 1 source, 0 backdrop
  flash : f32,
  p0 : f32,
  p1 : vec2<f32>,
  backdrop : vec4<f32>,
  edge : vec4<f32>,
  shards : array<vec4<f32>, 128>,   // centre, velocity | spin, start, tumble, axis
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

// Passthrough formula of the host (fade 1: bit-exact); fade < 1: reduced-motion crossfade.
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

struct ShardOut {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) home : vec2<f32>,
  @location(2) edge : f32,
  @location(3) @interpolate(flat) border : f32,
  @location(4) @interpolate(flat) facing : f32,
  @location(5) @interpolate(flat) moving : f32,
}

@vertex
fn vs_shard(@location(0) home : vec2<f32>, @location(1) info : vec2<f32>) -> ShardOut {
  let id = u32(info.x * 0.5);
  let a = u.shards[id * 2u];
  let b = u.shards[id * 2u + 1u];
  let tau = max(u.time - b.y, 0.0);
  let axis = vec2<f32>(cos(b.w), sin(b.w));
  let tumble = cos(b.z * tau);
  var local = home - a.xy;
  local = local + axis * dot(local, axis) * (tumble - 1.0);
  let cs = cos(b.x * tau);
  let sn = sin(b.x * tau);
  let p = a.xy + vec2<f32>(local.x * cs - local.y * sn, local.x * sn + local.y * cs) + a.zw * tau + vec2<f32>(0.0, 0.5 * u.gravity * tau * tau);
  let px = p * u.resolution / u.css;
  var out : ShardOut;
  out.position = vec4<f32>(px.x / u.resolution.x * 2.0 - 1.0, 1.0 - px.y / u.resolution.y * 2.0, 0.0, 1.0);
  out.uv = home / u.css;
  out.home = home;
  out.edge = info.y;
  out.border = info.x - f32(id) * 2.0;
  out.facing = abs(tumble);
  out.moving = select(0.0, 1.0, tau > 0.0);
  return out;
}

// glass: darker edge-on with a sheen as it tumbles; crack lines on outer edges inside the crack front; impact flash
@fragment
fn fs_shard(v : ShardOut) -> @location(0) vec4<f32> {
  let c = textureSample(source, source_sampler, v.uv);
  var rgb = mix(u.backdrop.rgb, c.rgb, c.a);
  rgb = rgb * (0.55 + 0.45 * v.facing) + u.edge.rgb * ((1.0 - v.facing) * 0.35 * v.moving);
  let to_edge = v.edge / max(fwidth(v.edge), 0.00001);
  let reached = distance(v.home, u.impact);
  let crack = (1.0 - smoothstep(0.5, 2.2, to_edge)) * select(0.0, 1.0, reached < u.front) * (1.0 - v.border);
  rgb = mix(rgb, u.edge.rgb, crack * u.edge_amount);
  rgb = rgb + u.edge.rgb * (u.flash / (1.0 + reached * 0.03));
  return vec4<f32>(rgb, u.alpha);
}
