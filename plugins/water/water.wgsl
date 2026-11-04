// Water over the live HTML. A height field simulated on the CPU (sim.js, the wave equation) is evaluated here per device pixel as a cubic
// B-spline (smooth normals and curvature, no grid pattern), and it lights the page below it:
//   - refraction: the page is sampled where the refracted view ray meets it (displacement = slope x depth), exactly as mapWaterPoint()
//     in index.js computes it for the input mapper;
//   - caustics: the light refracted by the same surface focuses on the page (the inverse Jacobian of that displacement, at a deeper light
//     depth); a faint glow of the focused light in the water shows them over dark content too;
//   - Fresnel reflection (Schlick, water F0 = 0.02) of an environment (a sky, a soft window light, a small sun) seen from a viewer above
//     the middle of the canvas: still water shows a faint reflection, and ripples break it up and make the sun glint;
//   - absorption: a little more blue-green where the water is deeper (in the troughs);
//   - a dither of half a level against banding.
// Everything scales with the intensity: at 0 the output is the source.

struct Globals {
  resolution : vec2<f32>,   // device px
  css : vec2<f32>,          // css px of the canvas
  k : vec2<f32>,            // css px of displacement per unit B-spline gradient (per cell), x and y: refract / cell size
  inv_cell : vec2<f32>,     // 1 / cell size, css px
  grid : vec2<f32>,         // interior cells across and down
  time : f32,               // seconds (the ambient swell)
  intensity : f32,
  light : f32,
  ambient : f32,            // amplitude of the ambient swell, css px (0: none)
  field_active : f32,       // 0: the field is flat (nothing to read)
  form_ready : f32,
  refract : f32,            // css px of displacement per unit slope (the refraction depth x intensity)
  caustic : f32,            // the same for the light (the caustic depth x intensity)
  pad0 : f32,
  pad1 : f32,
}

@group(0) @binding(0) var<uniform> globals : Globals;
@group(0) @binding(1) var form_sampler : sampler;
@group(0) @binding(2) var form_texture : texture_2d<f32>;
@group(0) @binding(3) var height_field : texture_2d<f32>;

const PAD : f32 = 2.0;

struct VertexOut {
  @builtin(position) position : vec4<f32>,
}

@vertex
fn vs(@builtin(vertex_index) index : u32) -> VertexOut {
  var positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var out : VertexOut;
  out.position = vec4<f32>(positions[index], 0.0, 1.0);
  return out;
}

// cubic B-spline weights, first and second derivatives (the same polynomials as weights() in sim.js)
fn bs_w(t : f32) -> vec4<f32> {
  let t2 = t * t; let t3 = t2 * t; let o = 1.0 - t;
  return vec4<f32>(o * o * o, 3.0 * t3 - 6.0 * t2 + 4.0, -3.0 * t3 + 3.0 * t2 + 3.0 * t + 1.0, t3) / 6.0;
}
fn bs_d(t : f32) -> vec4<f32> {
  let o = 1.0 - t;
  return vec4<f32>(-0.5 * o * o, 1.5 * t * t - 2.0 * t, -1.5 * t * t + t + 0.5, 0.5 * t * t);
}
fn bs_dd(t : f32) -> vec4<f32> {
  return vec4<f32>(1.0 - t, 3.0 * t - 2.0, 1.0 - 3.0 * t, t);
}

struct Surface {
  h : f32,
  grad : vec2<f32>,   // per cell
  hess : vec3<f32>,   // xx, yy, xy, per cell^2
}

// the B-spline surface over 4 x 4 cells (sim.js surfaceAt: the same cells, the same clamp at the border of the padded grid)
fn surface_at(uv : vec2<f32>) -> Surface {
  var s : Surface;
  s.h = 0.0; s.grad = vec2<f32>(0.0); s.hess = vec3<f32>(0.0);
  let g = uv * globals.grid - vec2<f32>(0.5) + vec2<f32>(PAD);
  let base = floor(g);
  let f = g - base;
  let wx = bs_w(f.x); let wy = bs_w(f.y);
  let dx = bs_d(f.x); let dy = bs_d(f.y);
  let ddx = bs_dd(f.x); let ddy = bs_dd(f.y);
  let size = vec2<i32>(textureDimensions(height_field));
  let b = vec2<i32>(base) - vec2<i32>(1);
  for (var j = 0; j < 4; j = j + 1) {
    let yy = clamp(b.y + j, 0, size.y - 1);
    var row = vec4<f32>(0.0);
    for (var i = 0; i < 4; i = i + 1) {
      row[i] = textureLoad(height_field, vec2<i32>(clamp(b.x + i, 0, size.x - 1), yy), 0).r;
    }
    let rw = dot(wx, row); let rd = dot(dx, row); let rdd = dot(ddx, row);
    s.h = s.h + wy[j] * rw;
    s.grad = s.grad + vec2<f32>(wy[j] * rd, dy[j] * rw);
    s.hess = s.hess + vec3<f32>(wy[j] * rdd, ddy[j] * rw, dy[j] * rd);
  }
  return s;
}

// the ambient swell (sim.js AMBIENT_WAVES): slope and Hessian (xx, yy, xy) of three plane waves, per css px
fn ambient(p : vec2<f32>, t : f32, amp : f32, slope : ptr<function, vec2<f32>>, hess : ptr<function, vec3<f32>>) {
  var waves = array<vec4<f32>, 3>(
    vec4<f32>(0.019622, 0.007141, 0.76, 1.0),
    vec4<f32>(-0.020143, 0.025003, 0.96, 0.55),
    vec4<f32>(0.019610, -0.042028, 1.25, 0.32));
  var phases = array<f32, 3>(0.0, 1.9, 4.1);
  for (var i = 0; i < 3; i = i + 1) {
    let w = waves[i];
    let phase = w.x * p.x + w.y * p.y - w.z * t + phases[i];
    let c = cos(phase) * w.w * amp;
    let s = sin(phase) * w.w * amp;
    *slope = *slope + c * w.xy;
    *hess = *hess - s * vec3<f32>(w.x * w.x, w.y * w.y, w.x * w.y);
  }
}

// a rounded rectangle of directions around `centre` (half sizes in radians, roughly), with a soft edge
fn soft_box(r : vec3<f32>, centre : vec3<f32>, half_size : vec2<f32>, round : f32) -> f32 {
  let e1 = normalize(cross(vec3<f32>(0.0, 1.0, 0.0), centre));
  let e2 = cross(centre, e1);
  let q = vec2<f32>(dot(r, e1), dot(r, e2));
  let d = abs(q) - half_size + vec2<f32>(round);
  let dist = length(max(d, vec2<f32>(0.0))) + min(max(d.x, d.y), 0.0) - round;
  return (1.0 - smoothstep(-0.05, 0.05, dist)) * step(0.0, dot(r, centre));
}

// radiance seen in direction r (z towards the viewer; x right, y down the canvas)
fn environment(r : vec3<f32>) -> vec3<f32> {
  let up = clamp(r.z, 0.0, 1.0);
  var c = mix(vec3<f32>(0.30, 0.36, 0.44), vec3<f32>(0.85, 0.93, 1.0), up * up);
  // a soft window light up and to the left: still water mirrors it over the top-left of the canvas
  let window_dir = normalize(vec3<f32>(-0.20, -0.19, 0.96));
  let wnd = soft_box(r, window_dir, vec2<f32>(0.17, 0.10), 0.05);
  c = c + vec3<f32>(5.2, 5.6, 6.0) * wnd * (0.75 + 0.25 * max(dot(r, window_dir), 0.0));
  // a small, bright sun to the upper right, just outside what still water mirrors: it glints only on the slopes of the ripples
  let sun_dir = normalize(vec3<f32>(0.33, -0.25, 0.91));
  let sun = pow(max(dot(r, sun_dir), 0.0), 1400.0);
  return c + vec3<f32>(17.0, 16.0, 14.5) * sun;
}

// interleaved gradient noise: a dither of +-0.5 level, stable per pixel
fn dither(p : vec2<f32>) -> f32 {
  return fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715)))) - 0.5;
}

@fragment
fn fs(@builtin(position) position : vec4<f32>) -> @location(0) vec4<f32> {
  let resolution = max(globals.resolution, vec2<f32>(1.0));
  let css = max(globals.css, vec2<f32>(1.0));
  let uv = position.xy / resolution;
  let intensity = clamp(globals.intensity, 0.0, 1.0);

  var h = 0.0;
  var disp = vec2<f32>(0.0);          // css px
  var slope = vec2<f32>(0.0);         // of the surface, per css px
  var hess = vec3<f32>(0.0);          // per css px^2
  if (globals.field_active > 0.5) {
    let s = surface_at(uv);
    h = s.h;
    disp = globals.k * s.grad;
    slope = s.grad * globals.inv_cell;
    hess = s.hess * vec3<f32>(globals.inv_cell.x * globals.inv_cell.x, globals.inv_cell.y * globals.inv_cell.y, globals.inv_cell.x * globals.inv_cell.y);
  }
  if (globals.ambient > 0.0) {
    var aslope = vec2<f32>(0.0);
    var ahess = vec3<f32>(0.0);
    ambient(uv * css, globals.time, globals.ambient, &aslope, &ahess);
    disp = disp + globals.refract * aslope;
    slope = slope + aslope;
    hess = hess + ahess;
  }
  let displaced_uv = clamp(uv + disp / css, vec2<f32>(0.001), vec2<f32>(0.999));

  // the page below: the drawn HTML, or a dark pool floor where it is transparent
  let pool = mix(vec3<f32>(0.006, 0.030, 0.062), vec3<f32>(0.012, 0.085, 0.140), smoothstep(-0.2, 1.2, displaced_uv.y));
  var form_pixel = vec4<f32>(0.0);
  if (globals.form_ready > 0.5) {
    form_pixel = textureSample(form_texture, form_sampler, displaced_uv);
  }
  let below = mix(pool, form_pixel.rgb, form_pixel.a);

  let light = clamp(globals.light, 0.0, 1.0) * smoothstep(0.0, 0.35, intensity);

  // caustics: the light through the same surface lands at p + caustic x slope; its density there is 1 / det(I + caustic x Hessian)
  let jxx = 1.0 + globals.caustic * hess.x;
  let jyy = 1.0 + globals.caustic * hess.y;
  let jxy = globals.caustic * hess.z;
  let focus = min(1.0 / max(abs(jxx * jyy - jxy * jxy), 0.3), 3.2) - 1.0;   // -0.69 .. 2.2; 0 on still water

  // absorption: about 9 % of red over the depth of the water at intensity 1, more in a trough (h < 0)
  let depth = 1.0 - clamp(h * 0.05, -0.5, 0.5);
  let transmit = exp(-vec3<f32>(0.090, 0.030, 0.014) * intensity * depth);
  var color = below * transmit * (vec3<f32>(1.0) + 0.24 * light * focus * vec3<f32>(1.0, 0.98, 0.93));
  color = color + vec3<f32>(0.030, 0.160, 0.200) * (0.55 * light * max(focus, 0.0));

  // Fresnel reflection of the environment, seen from above the middle of the canvas
  let eye = vec3<f32>(0.5 * css, 1.45 * max(css.x, css.y));
  let view = normalize(eye - vec3<f32>(uv * css, 0.0));
  let tilt = slope * intensity;
  let n = normalize(vec3<f32>(-tilt.x, -tilt.y, 1.0));
  let fresnel = 0.02 + 0.98 * pow(1.0 - clamp(dot(n, view), 0.0, 1.0), 5.0);
  let reflected = fresnel * environment(reflect(-view, n)) * light;
  // compressed (a soft knee): the reflection adds at most 0.38 of the range, so it never hides what lies below the water
  color = color + 0.38 * (vec3<f32>(1.0) - exp(-reflected / 0.38));

  color = color + vec3<f32>(dither(position.xy) / 255.0) * step(0.001, intensity);
  return vec4<f32>(clamp(color, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
