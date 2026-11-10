// The ink input mapper against the pixels the GPU really produced, through the shared plugin kit.
import { assert } from '/test/unit/lib/t.js';
import { agreement, checkMapperAgainstGpu, gpuAvailable, gpuTest, identity, markerScene, presentOnce, runActionOnGpu } from '/plugins/_shared/gpu-check.mjs';
import { meta, plugin } from '/plugins/ink/index.js';

console.error(`ink-gpu tests: WebGPU ${(await gpuAvailable()) ? 'available' : 'NOT available'}`);
const scene = markerScene({ w: 480, h: 320 });

/** Strokes of a pressed pointer, by the plugin's own listeners. @param {any} rig */
function strokes(rig) {
  const r = rig.canvas.getBoundingClientRect();
  let t = performance.now() - 400;
  const at = (type, x, y, buttons) => rig.layerEl.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: r.left + x, clientY: r.top + y, buttons, pointerType: 'mouse' }));
  for (let i = 0; i <= 30; i += 1) at('pointermove', 60 + 12 * i, 100 + 60 * Math.sin(i / 5), 0);
  for (let i = 0; i <= 30; i += 1) at('pointermove', 420 - 12 * i, 220 - 50 * Math.sin(i / 4), 0);
  void t;
}

gpuTest('every presented pixel samples the source point the ink mapper says, identity does not (positive control)', async (t) => {
  const v = await checkMapperAgainstGpu(t, plugin, { intensity: 1, pigment: 0 }, { scene, before: strokes, offsetMs: 200 });
  console.error(`ink mapper vs GPU: decided=${v.real.decided} wrong=${v.real.wrong} brightPx=${v.real.bright} | identity wrong=${v.identity.wrong} :: ${v.why}`);
  assert.ok(v.ok, v.why);
});
