struct Globals {
  resolution : vec2<f32>,
  time : f32,
  form_ready : f32,
  water_params : vec4<f32>,
  ripples : array<vec4<f32>, 4>,
}

@group(0) @binding(0) var<uniform> globals : Globals;
@group(0) @binding(1) var form_sampler : sampler;
@group(0) @binding(2) var form_texture : texture_2d<f32>;

struct VertexOut {
  @builtin(position) position : vec4<f32>,
}

@vertex
fn vs(@builtin(vertex_index) index : u32) -> VertexOut {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0)
  );
  var out : VertexOut;
  out.position = vec4<f32>(positions[index], 0.0, 1.0);
  return out;
}

fn fast_exp_neg(x : f32) -> f32 {
  // [0,+inf) reciprocal cubic approximation. It is intentionally shared with
  // the JS input mapper so visible refraction and routed input stay coherent,
  // while avoiding fullscreen exp() in the hot fragment path.
  let q = max(0.0, x);
  let q2 = q * q;
  return 1.0 / (1.0 + q + 0.48 * q2 + 0.235 * q2 * q);
}

fn caustic(p : vec2<f32>, t : f32) -> f32 {
  // Two phase-coupled waves keep the moving caustic character at a bounded
  // cost suitable for a full-screen 120 Hz demo.
  let a = sin(p.x * 9.0 + p.y * 1.35 + t * 0.32);
  let b = sin(p.y * 11.0 - p.x * 1.10 - t * 0.28);
  let ridge = clamp(0.5 + 0.5 * (a * 0.58 + b * 0.42), 0.0, 1.0);
  let ridge2 = ridge * ridge;
  return ridge2 * ridge2 * ridge;
}

@fragment
fn fs(@builtin(position) position : vec4<f32>) -> @location(0) vec4<f32> {
  let resolution = max(globals.resolution, vec2<f32>(1.0));
  let uv = position.xy / resolution;
  let aspect = vec2<f32>(resolution.x / resolution.y, 1.0);
  let intensity = clamp(globals.water_params.x, 0.0, 1.0);
  let centered = (uv - vec2<f32>(0.5)) * aspect;

  var ripple_displacement = vec2<f32>(0.0);
  var wave_light = 0.0;
  for (var i = 0u; i < 4u; i = i + 1u) {
    let ripple = globals.ripples[i];
    // z = radius and w = CPU-precomputed age decay * authored strength.
    // Activity is uniform across the draw: inactive slots skip the expensive
    // spatial math entirely, active slots avoid two exp() evaluations/pixel.
    if (ripple.w > 0.0) {
      let delta = (uv - ripple.xy) * aspect;
      let distance = max(length(delta), 0.0001);
      let direction = delta / distance;
      let ring = cos((distance - ripple.z) * 82.0);
      let envelope = fast_exp_neg(distance * 2.55) * ripple.w;
      ripple_displacement = ripple_displacement + (direction / aspect) * ring * envelope * (0.0105 * intensity);
      wave_light = wave_light + max(ring, 0.0) * envelope;
    }
  }

  let idle_displacement = vec2<f32>(
    sin(uv.y * 17.0 + globals.time * 0.46),
    cos(uv.x * 15.0 - globals.time * 0.40)
  ) * (0.00155 * intensity);
  let displaced_uv = clamp(uv + idle_displacement + ripple_displacement, vec2<f32>(0.001), vec2<f32>(0.999));

  let water_p = (displaced_uv - vec2<f32>(0.5)) * aspect;
  let c1 = caustic(water_p * 1.48, globals.time);
  let c2 = caustic(water_p.yx * 2.05 + vec2<f32>(1.7, -0.8), globals.time * 1.21);
  let caustics = c1 * 0.66 + c2 * 0.34;
  let depth = smoothstep(-0.60, 0.64, displaced_uv.y);

  var water = mix(vec3<f32>(0.006, 0.034, 0.075), vec3<f32>(0.012, 0.13, 0.20), depth);
  water = water + vec3<f32>(0.025, 0.19, 0.26) * caustics * intensity;
  water = water + vec3<f32>(0.12, 0.34, 0.42) * wave_light * (0.18 * intensity);
  let violet_glow = fast_exp_neg(length(centered - vec2<f32>(0.40, -0.30)) * 2.7);
  water = water + vec3<f32>(0.17, 0.10, 0.29) * violet_glow * 0.22;

  var form_pixel = vec4<f32>(0.0);
  if (globals.form_ready > 0.5) {
    // The HTML snapshot is sampled at the displaced coordinate. This is the
    // important bit: the water bends the pixels produced by the polyfill,
    // rather than living on a separate decorative canvas behind the form.
    form_pixel = textureSample(form_texture, form_sampler, displaced_uv);
  }

  let refracted_highlight = vec3<f32>(0.10, 0.32, 0.40) * caustics * form_pixel.a * (0.07 * intensity);
  let form_rgb = form_pixel.rgb + refracted_highlight;
  var color = mix(water, form_rgb, form_pixel.a);

  let vignette = smoothstep(1.02, 0.30, length(centered * vec2<f32>(0.84, 1.0)));
  color = color * (0.70 + 0.30 * vignette);
  return vec4<f32>(color, 1.0);
}
